use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentAction {
    ToolCall {
        tool: String,
        #[serde(default)]
        arguments: Value,
    },
    Final {
        content: String,
    },
}

pub fn parse_action(response: &str) -> Result<AgentAction> {
    let payload = strip_json_fence(response);
    serde_json::from_str(payload).with_context(|| {
        format!(
            "Agent response is not a valid action: {}",
            truncate(response.trim(), 200)
        )
    })
}

fn strip_json_fence(response: &str) -> &str {
    let response = response.trim();
    if !response.starts_with("```") || !response.ends_with("```") {
        return response;
    }

    response
        .strip_prefix("```json")
        .or_else(|| response.strip_prefix("```JSON"))
        .or_else(|| response.strip_prefix("```"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(response)
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_tool_call() {
        let action = parse_action(
            r#"{"type":"tool_call","tool":"read_file","arguments":{"path":"src/main.rs"}}"#,
        )
        .unwrap();

        assert_eq!(
            action,
            AgentAction::ToolCall {
                tool: "read_file".to_string(),
                arguments: json!({"path": "src/main.rs"}),
            }
        );
    }

    #[test]
    fn parses_final_action_inside_json_fence() {
        let action =
            parse_action("```json\n{\"type\":\"final\",\"content\":\"done\"}\n```").unwrap();
        assert_eq!(
            action,
            AgentAction::Final {
                content: "done".to_string(),
            }
        );
    }

    #[test]
    fn rejects_free_form_response() {
        assert!(parse_action("I am done").is_err());
    }
}
