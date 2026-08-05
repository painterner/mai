use anyhow::{Context, Result, bail};
use futures::StreamExt;
use reqwest_eventsource::{Event, EventSource};
use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::config::{ApiProvider, Config};

/// A provider-neutral message in the conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Part {
    pub text: String,
}

#[derive(Debug, Serialize)]
struct GeminiRequest {
    contents: Vec<Message>,
    #[serde(rename = "generationConfig", skip_serializing_if = "Option::is_none")]
    generation_config: Option<GeminiGenerationConfig>,
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
}

pub struct ApiClient {
    client: reqwest::Client,
    provider: ApiProvider,
    base_url: String,
    api_key: String,
    model: String,
    max_tokens: u32,
    temperature: f32,
}

impl ApiClient {
    pub fn new(config: &Config) -> Result<Self> {
        if config.provider == ApiProvider::Gemini && config.api_key.is_empty() {
            bail!(
                "API key is not configured. Set {} or edit the config file.",
                config.provider.api_key_env()
            );
        }

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
        })
    }

    pub fn set_model(&mut self, model: &str) {
        self.model = model.to_string();
    }

    pub async fn chat(&self, prompt: &str, history: &[Message]) -> Result<String> {
        match self.provider {
            ApiProvider::Gemini => self.chat_gemini(prompt, history).await,
            ApiProvider::Openai => self.chat_openai(prompt, history).await,
        }
    }

    pub fn chat_stream(
        &self,
        prompt: &str,
        history: &[Message],
    ) -> Result<tokio::sync::mpsc::Receiver<Result<String>>> {
        match self.provider {
            ApiProvider::Gemini => self.chat_stream_gemini(prompt, history),
            ApiProvider::Openai => self.chat_stream_openai(prompt, history),
        }
    }

    async fn chat_gemini(&self, prompt: &str, history: &[Message]) -> Result<String> {
        let request = GeminiRequest {
            contents: with_prompt(history, prompt),
            generation_config: Some(GeminiGenerationConfig {
                max_output_tokens: Some(self.max_tokens),
                temperature: Some(self.temperature),
            }),
        };
        let endpoint = format!("{}/models/{}:generateContent", self.base_url, self.model);
        debug!("Sending Gemini request to: {}", endpoint);

        let response = self
            .client
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

    fn chat_stream_gemini(
        &self,
        prompt: &str,
        history: &[Message],
    ) -> Result<tokio::sync::mpsc::Receiver<Result<String>>> {
        let request = GeminiRequest {
            contents: with_prompt(history, prompt),
            generation_config: Some(GeminiGenerationConfig {
                max_output_tokens: Some(self.max_tokens),
                temperature: Some(self.temperature),
            }),
        };
        let endpoint = format!(
            "{}/models/{}:streamGenerateContent",
            self.base_url, self.model
        );
        let (tx, rx) = tokio::sync::mpsc::channel(32);
        let req = self
            .client
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
                                let text = gemini_text(chunk.candidates);
                                if !text.is_empty() && tx.send(Ok(text)).await.is_err() {
                                    break;
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

    async fn chat_openai(&self, prompt: &str, history: &[Message]) -> Result<String> {
        let request = self.openai_request(prompt, history, false);
        let endpoint = format!("{}/chat/completions", self.base_url);
        debug!("Sending OpenAI-compatible request to: {}", endpoint);

        let response = openai_auth(self.client.post(&endpoint), &self.api_key)
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

    fn chat_stream_openai(
        &self,
        prompt: &str,
        history: &[Message],
    ) -> Result<tokio::sync::mpsc::Receiver<Result<String>>> {
        let request = self.openai_request(prompt, history, true);
        let endpoint = format!("{}/chat/completions", self.base_url);
        let (tx, rx) = tokio::sync::mpsc::channel(32);
        let req = openai_auth(self.client.post(endpoint), &self.api_key).json(&request);

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
                                let text = chunk
                                    .choices
                                    .and_then(|choices| choices.into_iter().next())
                                    .and_then(|choice| choice.delta)
                                    .and_then(|delta| delta.content)
                                    .unwrap_or_default();
                                if !text.is_empty() && tx.send(Ok(text)).await.is_err() {
                                    break;
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

    fn openai_request(&self, prompt: &str, history: &[Message], stream: bool) -> OpenAiRequest {
        let mut messages = history.iter().map(to_openai_message).collect::<Vec<_>>();
        messages.push(OpenAiMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
        });
        OpenAiRequest {
            model: self.model.clone(),
            messages,
            max_tokens: self.max_tokens,
            temperature: self.temperature,
            stream,
        }
    }
}

fn with_prompt(history: &[Message], prompt: &str) -> Vec<Message> {
    let mut contents = history.to_vec();
    contents.push(Message {
        role: "user".to_string(),
        parts: vec![Part {
            text: prompt.to_string(),
        }],
    });
    contents
}

fn openai_auth(request: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    if api_key.is_empty() {
        request
    } else {
        request.bearer_auth(api_key)
    }
}

fn to_openai_message(message: &Message) -> OpenAiMessage {
    OpenAiMessage {
        role: match message.role.as_str() {
            "model" => "assistant".to_string(),
            role => role.to_string(),
        },
        content: message
            .parts
            .iter()
            .map(|part| part.text.as_str())
            .collect::<Vec<_>>()
            .join(""),
    }
}

fn gemini_text(candidates: Option<Vec<GeminiCandidate>>) -> String {
    candidates
        .and_then(|items| items.into_iter().next())
        .and_then(|candidate| candidate.content)
        .and_then(|content| content.parts)
        .map(|parts| {
            parts
                .into_iter()
                .filter_map(|part| part.text)
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_gemini_model_role_to_openai_assistant() {
        let message = Message {
            role: "model".to_string(),
            parts: vec![Part {
                text: "hello".to_string(),
            }],
        };
        let mapped = to_openai_message(&message);
        assert_eq!(mapped.role, "assistant");
        assert_eq!(mapped.content, "hello");
    }

    #[test]
    fn joins_all_gemini_response_parts() {
        let candidates = Some(vec![GeminiCandidate {
            content: Some(GeminiContent {
                parts: Some(vec![
                    GeminiResponsePart {
                        text: Some("a".into()),
                    },
                    GeminiResponsePart {
                        text: Some("b".into()),
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
        let history = vec![Message {
            role: "model".to_string(),
            parts: vec![Part {
                text: "previous".to_string(),
            }],
        }];

        let value = serde_json::to_value(client.openai_request("next", &history, true)).unwrap();
        assert_eq!(value["model"], "test-model");
        assert_eq!(value["stream"], true);
        assert_eq!(value["messages"][0]["role"], "assistant");
        assert_eq!(value["messages"][0]["content"], "previous");
        assert_eq!(value["messages"][1]["role"], "user");
        assert_eq!(value["messages"][1]["content"], "next");
    }
}
