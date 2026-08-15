use std::path::Path;

const CHAT_SYSTEM: &str = include_str!("../prompts/chat_system.md");
const AGENT_SYSTEM: &str = include_str!("../prompts/agent_system.md");
const TOOL_RESULT: &str = include_str!("../prompts/tool_result.md");
const PROTOCOL_ERROR: &str = include_str!("../prompts/protocol_error.md");

pub fn chat_system() -> &'static str {
    CHAT_SYSTEM.trim()
}

pub fn agent_system(workspace: &Path, tools: &str) -> String {
    AGENT_SYSTEM
        .replace("{{workspace}}", &workspace.display().to_string())
        .replace("{{tools}}", tools)
}

pub fn tool_result(tool: &str, result: &str) -> String {
    TOOL_RESULT
        .replace("{{tool}}", tool)
        .replace("{{result}}", result)
}

pub fn protocol_error(error: &str) -> String {
    PROTOCOL_ERROR.replace("{{error}}", error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_prompt_replaces_all_placeholders() {
        let prompt = agent_system(Path::new("/workspace"), "read_file");
        assert!(prompt.contains("/workspace"));
        assert!(prompt.contains("read_file"));
        assert!(!prompt.contains("{{"));
    }

    #[test]
    fn tool_result_preserves_tool_output() {
        let prompt = tool_result("read_file", "file contents");
        assert!(prompt.contains("`read_file`"));
        assert!(prompt.contains("file contents"));
    }

    #[test]
    fn protocol_error_includes_parse_failure() {
        let prompt = protocol_error("expected JSON");
        assert!(prompt.contains("expected JSON"));
        assert!(!prompt.contains("{{error}}"));
    }
}
