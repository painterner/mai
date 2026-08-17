use anyhow::{Context, Result, bail};
use futures::StreamExt;
use reqwest::header::HeaderName;
use reqwest_eventsource::{Event, EventSource};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use tracing::debug;

use crate::config::{ApiProvider, Config};
use crate::conversation::{Message, Role};

const SESSION_ID_HEADER: HeaderName = HeaderName::from_static("session-id");

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponseEvent {
    Thinking(String),
    Content(String),
}

pub type ResponseStream = tokio::sync::mpsc::Receiver<Result<ResponseEvent>>;

#[derive(Debug, Serialize)]
struct GeminiRequest {
    #[serde(rename = "systemInstruction", skip_serializing_if = "Option::is_none")]
    system_instruction: Option<GeminiSystemInstruction>,
    contents: Vec<GeminiMessage>,
    #[serde(rename = "generationConfig", skip_serializing_if = "Option::is_none")]
    generation_config: Option<GeminiGenerationConfig>,
}

#[derive(Debug, Serialize)]
struct GeminiSystemInstruction {
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Serialize)]
struct GeminiMessage {
    role: String,
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Serialize)]
struct GeminiPart {
    text: String,
}

#[derive(Debug, Serialize)]
struct GeminiGenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
}

#[derive(Debug, Deserialize)]
struct GeminiContent {
    parts: Option<Vec<GeminiResponsePart>>,
}

#[derive(Debug, Deserialize)]
struct GeminiResponsePart {
    text: Option<String>,
    #[serde(default)]
    thought: bool,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct GeminiStreamChunk {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Debug, Serialize)]
struct OpenAiRequest {
    model: String,
    messages: Vec<OpenAiMessage>,
    max_tokens: u32,
    temperature: f32,
    stream: bool,
}

#[derive(Debug, Serialize)]
struct OpenAiMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    choices: Option<Vec<OpenAiChoice>>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: Option<OpenAiResponseMessage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponseMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamChunk {
    choices: Option<Vec<OpenAiStreamChoice>>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamChoice {
    delta: Option<OpenAiDelta>,
}

#[derive(Debug, Deserialize)]
struct OpenAiDelta {
    content: Option<String>,
    reasoning_content: Option<String>,
    reasoning: Option<String>,
}

#[derive(Clone)]
pub struct ApiClient {
    client: reqwest::Client,
    provider: ApiProvider,
    base_url: String,
    api_key: String,
    model: String,
    max_tokens: u32,
    temperature: f32,
    session_id: Arc<RwLock<String>>,
}

impl ApiClient {
    pub fn new(config: &Config) -> Result<Self> {
        if config.provider == ApiProvider::Gemini && config.api_key.is_empty() {
            bail!(
                "API key is not configured. Set {} or edit the config file.",
                config.provider.api_key_env()
            );
        }

        let session_id = generate_session_id();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()?;

        Ok(Self {
            client,
            provider: config.provider,
            base_url: config.base_url.trim_end_matches('/').to_string(),
            api_key: config.api_key.clone(),
            model: config.model.clone(),
            max_tokens: config.max_tokens,
            temperature: config.temperature,
            session_id: Arc::new(RwLock::new(session_id)),
        })
    }

    pub fn session_id(&self) -> String {
        self.session_id
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn start_new_session(&self) -> String {
        let session_id = generate_session_id();
        self.restore_session(session_id.clone());
        session_id
    }

    pub fn restore_session(&self, session_id: impl Into<String>) {
        let session_id = session_id.into();
        *self
            .session_id
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = session_id;
    }

    pub fn set_model(&mut self, model: &str) {
        self.model = model.to_string();
    }

    fn post(&self, endpoint: impl reqwest::IntoUrl) -> reqwest::RequestBuilder {
        self.client
            .post(endpoint)
            .header(SESSION_ID_HEADER, self.session_id())
    }

    pub async fn complete(
        &self,
        system_prompt: Option<&str>,
        messages: &[Message],
    ) -> Result<String> {
        match self.provider {
            ApiProvider::Gemini => self.complete_gemini(system_prompt, messages).await,
            ApiProvider::Openai => self.complete_openai(system_prompt, messages).await,
        }
    }

    pub fn complete_stream(
        &self,
        system_prompt: Option<&str>,
        messages: &[Message],
    ) -> Result<tokio::sync::mpsc::Receiver<Result<String>>> {
        let mut events = self.complete_stream_events(system_prompt, messages)?;
        let (sender, receiver) = tokio::sync::mpsc::channel(32);
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    Ok(ResponseEvent::Content(content)) => {
                        if sender.send(Ok(content)).await.is_err() {
                            break;
                        }
                    }
                    Ok(ResponseEvent::Thinking(_)) => {}
                    Err(error) => {
                        let _ = sender.send(Err(error)).await;
                        break;
                    }
                }
            }
        });
        Ok(receiver)
    }

    pub fn complete_stream_events(
        &self,
        system_prompt: Option<&str>,
        messages: &[Message],
    ) -> Result<ResponseStream> {
        match self.provider {
            ApiProvider::Gemini => self.complete_stream_gemini(system_prompt, messages),
            ApiProvider::Openai => self.complete_stream_openai(system_prompt, messages),
        }
    }

    async fn complete_gemini(
        &self,
        system_prompt: Option<&str>,
        messages: &[Message],
    ) -> Result<String> {
        let request = self.gemini_request(system_prompt, messages);
        let endpoint = format!("{}/models/{}:generateContent", self.base_url, self.model);
        debug!("Sending Gemini request to: {}", endpoint);

        let response = self
            .post(&endpoint)
            .query(&[("key", &self.api_key)])
            .json(&request)
            .send()
            .await
            .context("Failed to send request to Gemini API")?;
        let status = response.status();
        let response_text = response
            .text()
            .await
            .context("Failed to read Gemini API response")?;
        let body: GeminiResponse = serde_json::from_str(&response_text)
            .with_context(|| format!("Failed to parse Gemini API response (HTTP {status})"))?;

        if let Some(error) = body.error {
            bail!("Gemini API error (HTTP {status}): {}", error.message);
        }
        if !status.is_success() {
            bail!("Gemini API returned HTTP {status}");
        }

        Ok(gemini_text(body.candidates))
    }

    fn complete_stream_gemini(
        &self,
        system_prompt: Option<&str>,
        messages: &[Message],
    ) -> Result<ResponseStream> {
        let request = self.gemini_request(system_prompt, messages);
        let endpoint = format!(
            "{}/models/{}:streamGenerateContent",
            self.base_url, self.model
        );
        let (tx, rx) = tokio::sync::mpsc::channel(32);
        let req = self
            .post(endpoint)
            .query(&[("alt", "sse"), ("key", self.api_key.as_str())])
            .json(&request);

        tokio::spawn(async move {
            let mut es = match EventSource::new(req) {
                Ok(es) => es,
                Err(err) => {
                    let _ = tx
                        .send(Err(anyhow::anyhow!("Failed to start stream: {err}")))
                        .await;
                    return;
                }
            };

            while let Some(event) = es.next().await {
                match event {
                    Ok(Event::Message(msg)) => {
                        match serde_json::from_str::<GeminiStreamChunk>(&msg.data) {
                            Ok(chunk) => {
                                for event in gemini_events(chunk.candidates) {
                                    if tx.send(Ok(event)).await.is_err() {
                                        return;
                                    }
                                }
                            }
                            Err(err) => {
                                let _ = tx
                                    .send(Err(anyhow::anyhow!(
                                        "Invalid Gemini stream response: {err}"
                                    )))
                                    .await;
                                break;
                            }
                        }
                    }
                    Ok(Event::Open) => debug!("Gemini SSE connection opened"),
                    Err(reqwest_eventsource::Error::StreamEnded) => break,
                    Err(err) => {
                        let _ = tx.send(Err(anyhow::anyhow!("Stream error: {err}"))).await;
                        break;
                    }
                }
            }
        });

        Ok(rx)
    }

    async fn complete_openai(
        &self,
        system_prompt: Option<&str>,
        messages: &[Message],
    ) -> Result<String> {
        let request = self.openai_request(system_prompt, messages, false);
        let endpoint = format!("{}/chat/completions", self.base_url);
        debug!("Sending OpenAI-compatible request to: {}", endpoint);

        let response = openai_auth(self.post(&endpoint), &self.api_key)
            .json(&request)
            .send()
            .await
            .context("Failed to send request to OpenAI-compatible API")?;
        let status = response.status();
        let response_text = response
            .text()
            .await
            .context("Failed to read OpenAI-compatible API response")?;
        let body: OpenAiResponse = serde_json::from_str(&response_text).with_context(|| {
            format!("Failed to parse OpenAI-compatible API response (HTTP {status})")
        })?;

        if let Some(error) = body.error {
            bail!(
                "OpenAI-compatible API error (HTTP {status}): {}",
                error.message
            );
        }
        if !status.is_success() {
            bail!("OpenAI-compatible API returned HTTP {status}");
        }

        Ok(body
            .choices
            .and_then(|choices| choices.into_iter().next())
            .and_then(|choice| choice.message)
            .and_then(|message| message.content)
            .unwrap_or_default())
    }

    fn complete_stream_openai(
        &self,
        system_prompt: Option<&str>,
        messages: &[Message],
    ) -> Result<ResponseStream> {
        let request = self.openai_request(system_prompt, messages, true);
        let endpoint = format!("{}/chat/completions", self.base_url);
        let (tx, rx) = tokio::sync::mpsc::channel(32);
        let req = openai_auth(self.post(endpoint), &self.api_key).json(&request);

        tokio::spawn(async move {
            let mut es = match EventSource::new(req) {
                Ok(es) => es,
                Err(err) => {
                    let _ = tx
                        .send(Err(anyhow::anyhow!("Failed to start stream: {err}")))
                        .await;
                    return;
                }
            };

            while let Some(event) = es.next().await {
                match event {
                    Ok(Event::Message(msg)) => {
                        if msg.data.trim() == "[DONE]" {
                            es.close();
                            break;
                        }
                        match serde_json::from_str::<OpenAiStreamChunk>(&msg.data) {
                            Ok(chunk) => {
                                if let Some(error) = chunk.error {
                                    let _ = tx
                                        .send(Err(anyhow::anyhow!(
                                            "OpenAI-compatible API error: {}",
                                            error.message
                                        )))
                                        .await;
                                    break;
                                }
                                let delta = chunk
                                    .choices
                                    .and_then(|choices| choices.into_iter().next())
                                    .and_then(|choice| choice.delta);
                                for event in openai_delta_events(delta) {
                                    if tx.send(Ok(event)).await.is_err() {
                                        return;
                                    }
                                }
                            }
                            Err(err) => {
                                let _ = tx
                                    .send(Err(anyhow::anyhow!(
                                        "Invalid OpenAI-compatible stream response: {err}"
                                    )))
                                    .await;
                                break;
                            }
                        }
                    }
                    Ok(Event::Open) => debug!("OpenAI-compatible SSE connection opened"),
                    Err(reqwest_eventsource::Error::StreamEnded) => break,
                    Err(err) => {
                        let _ = tx.send(Err(anyhow::anyhow!("Stream error: {err}"))).await;
                        break;
                    }
                }
            }
        });

        Ok(rx)
    }

    fn gemini_request(&self, system_prompt: Option<&str>, messages: &[Message]) -> GeminiRequest {
        GeminiRequest {
            system_instruction: system_prompt.map(|prompt| GeminiSystemInstruction {
                parts: vec![GeminiPart {
                    text: prompt.to_string(),
                }],
            }),
            contents: messages.iter().map(to_gemini_message).collect(),
            generation_config: Some(GeminiGenerationConfig {
                max_output_tokens: Some(self.max_tokens),
                temperature: Some(self.temperature),
            }),
        }
    }

    fn openai_request(
        &self,
        system_prompt: Option<&str>,
        messages: &[Message],
        stream: bool,
    ) -> OpenAiRequest {
        let mut request_messages =
            Vec::with_capacity(messages.len() + usize::from(system_prompt.is_some()));
        if let Some(prompt) = system_prompt {
            request_messages.push(OpenAiMessage {
                role: "system".to_string(),
                content: prompt.to_string(),
            });
        }
        request_messages.extend(messages.iter().map(to_openai_message));
        OpenAiRequest {
            model: self.model.clone(),
            messages: request_messages,
            max_tokens: self.max_tokens,
            temperature: self.temperature,
            stream,
        }
    }
}

fn openai_auth(request: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    if api_key.is_empty() {
        request
    } else {
        request.bearer_auth(api_key)
    }
}

fn generate_session_id() -> String {
    let mut bytes = rand::random::<[u8; 16]>();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn to_openai_message(message: &Message) -> OpenAiMessage {
    OpenAiMessage {
        role: match message.role {
            Role::User => "user".to_string(),
            Role::Assistant => "assistant".to_string(),
        },
        content: message.content.clone(),
    }
}

fn to_gemini_message(message: &Message) -> GeminiMessage {
    GeminiMessage {
        role: match message.role {
            Role::User => "user".to_string(),
            Role::Assistant => "model".to_string(),
        },
        parts: vec![GeminiPart {
            text: message.content.clone(),
        }],
    }
}

fn gemini_text(candidates: Option<Vec<GeminiCandidate>>) -> String {
    gemini_events(candidates)
        .into_iter()
        .filter_map(|event| match event {
            ResponseEvent::Content(text) => Some(text),
            ResponseEvent::Thinking(_) => None,
        })
        .collect()
}

fn gemini_events(candidates: Option<Vec<GeminiCandidate>>) -> Vec<ResponseEvent> {
    candidates
        .and_then(|items| items.into_iter().next())
        .and_then(|candidate| candidate.content)
        .and_then(|content| content.parts)
        .map(|parts| {
            parts
                .into_iter()
                .filter_map(|part| {
                    part.text.filter(|text| !text.is_empty()).map(|text| {
                        if part.thought {
                            ResponseEvent::Thinking(text)
                        } else {
                            ResponseEvent::Content(text)
                        }
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn openai_delta_events(delta: Option<OpenAiDelta>) -> Vec<ResponseEvent> {
    let Some(delta) = delta else {
        return Vec::new();
    };
    let mut events = Vec::with_capacity(2);
    let thinking = delta.reasoning_content.or(delta.reasoning);
    if let Some(thinking) = thinking.filter(|text| !text.is_empty()) {
        events.push(ResponseEvent::Thinking(thinking));
    }
    if let Some(content) = delta.content.filter(|text| !text.is_empty()) {
        events.push(ResponseEvent::Content(content));
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_assistant_role_for_each_provider() {
        let message = Message::assistant("hello");
        let mapped = to_openai_message(&message);
        assert_eq!(mapped.role, "assistant");
        assert_eq!(mapped.content, "hello");

        let mapped = to_gemini_message(&message);
        assert_eq!(mapped.role, "model");
        assert_eq!(mapped.parts[0].text, "hello");
    }

    #[test]
    fn joins_all_gemini_response_parts() {
        let candidates = Some(vec![GeminiCandidate {
            content: Some(GeminiContent {
                parts: Some(vec![
                    GeminiResponsePart {
                        text: Some("a".into()),
                        thought: false,
                    },
                    GeminiResponsePart {
                        text: Some("b".into()),
                        thought: false,
                    },
                ]),
            }),
        }]);
        assert_eq!(gemini_text(candidates), "ab");
    }

    #[test]
    fn builds_openai_chat_completions_body() {
        let mut config = Config::default();
        config.set_provider(ApiProvider::Openai);
        config.model = "test-model".to_string();
        let client = ApiClient::new(&config).unwrap();
        let messages = vec![Message::assistant("previous"), Message::user("next")];

        let value =
            serde_json::to_value(client.openai_request(Some("Be concise."), &messages, true))
                .unwrap();
        assert_eq!(value["model"], "test-model");
        assert_eq!(value["stream"], true);
        assert_eq!(value["messages"][0]["role"], "system");
        assert_eq!(value["messages"][0]["content"], "Be concise.");
        assert_eq!(value["messages"][1]["role"], "assistant");
        assert_eq!(value["messages"][1]["content"], "previous");
        assert_eq!(value["messages"][2]["role"], "user");
        assert_eq!(value["messages"][2]["content"], "next");
    }

    #[test]
    fn builds_gemini_request_with_system_instruction() {
        let config = Config::default();
        let client = ApiClient::new(&config).unwrap();
        let request = client.gemini_request(Some("Use tools."), &[Message::user("work")]);
        let value = serde_json::to_value(request).unwrap();

        assert_eq!(value["systemInstruction"]["parts"][0]["text"], "Use tools.");
        assert_eq!(value["contents"][0]["role"], "user");
        assert_eq!(value["contents"][0]["parts"][0]["text"], "work");
    }

    #[test]
    fn api_clients_have_unique_session_ids_and_clones_reuse_them() {
        let config = Config::default();
        let first = ApiClient::new(&config).unwrap();
        let cloned = first.clone();
        let second = ApiClient::new(&config).unwrap();

        assert_eq!(first.session_id(), cloned.session_id());
        assert_ne!(first.session_id(), second.session_id());
        assert_eq!(first.session_id().len(), 36);

        let request = first.post("http://localhost/").build().unwrap();
        assert_eq!(
            request.headers().get(SESSION_ID_HEADER).unwrap(),
            first.session_id().as_str()
        );

        let previous = first.session_id();
        let current = first.start_new_session();
        assert_ne!(previous, current);
        assert_eq!(cloned.session_id(), current);
        assert_ne!(second.session_id(), current);
    }

    #[test]
    fn parses_openai_reasoning_and_content_events() {
        let events = openai_delta_events(Some(OpenAiDelta {
            content: Some("answer".to_string()),
            reasoning_content: Some("thinking".to_string()),
            reasoning: None,
        }));
        assert_eq!(
            events,
            vec![
                ResponseEvent::Thinking("thinking".to_string()),
                ResponseEvent::Content("answer".to_string())
            ]
        );
    }

    #[test]
    fn separates_gemini_thought_parts_from_content() {
        let candidates = Some(vec![GeminiCandidate {
            content: Some(GeminiContent {
                parts: Some(vec![
                    GeminiResponsePart {
                        text: Some("thinking".to_string()),
                        thought: true,
                    },
                    GeminiResponsePart {
                        text: Some("answer".to_string()),
                        thought: false,
                    },
                ]),
            }),
        }]);
        assert_eq!(
            gemini_events(candidates),
            vec![
                ResponseEvent::Thinking("thinking".to_string()),
                ResponseEvent::Content("answer".to_string())
            ]
        );
    }
}
