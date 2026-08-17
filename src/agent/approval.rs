use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

impl std::fmt::Display for RiskLevel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuleDecision {
    Allow,
    Review,
    Forbidden,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRequirement {
    pub decision: RuleDecision,
    pub risk: RiskLevel,
    pub reason: String,
}

impl ApprovalRequirement {
    fn allow(reason: impl Into<String>) -> Self {
        Self {
            decision: RuleDecision::Allow,
            risk: RiskLevel::Low,
            reason: reason.into(),
        }
    }

    fn review(risk: RiskLevel, reason: impl Into<String>) -> Self {
        Self {
            decision: RuleDecision::Review,
            risk,
            reason: reason.into(),
        }
    }

    fn forbidden(reason: impl Into<String>) -> Self {
        Self {
            decision: RuleDecision::Forbidden,
            risk: RiskLevel::Critical,
            reason: reason.into(),
        }
    }
}

pub fn classify_tool(tool: &str, arguments: &Value) -> ApprovalRequirement {
    match tool {
        "list_files" | "read_file" | "search_files" => {
            ApprovalRequirement::allow("Read-only workspace tool")
        }
        "write_file" | "replace_in_file" => {
            ApprovalRequirement::allow("Write is constrained to the workspace")
        }
        "run_command" => match arguments.get("command").and_then(Value::as_str) {
            Some(command) if !command.trim().is_empty() => classify_command(command),
            _ => ApprovalRequirement::forbidden("run_command requires a non-empty command"),
        },
        _ => ApprovalRequirement::forbidden(format!("Unknown tool: {tool}")),
    }
}

fn classify_command(script: &str) -> ApprovalRequirement {
    let commands = match split_simple_script(script) {
        Some(commands) if !commands.is_empty() => commands,
        _ => {
            return ApprovalRequirement::review(
                RiskLevel::High,
                "Complex shell syntax cannot be safely split by the rule engine",
            );
        }
    };

    commands
        .iter()
        .map(|command| classify_simple_command(command))
        .max_by_key(|requirement| (requirement.decision, requirement.risk))
        .unwrap_or_else(|| ApprovalRequirement::forbidden("Empty command"))
}

fn classify_simple_command(arguments: &[String]) -> ApprovalRequirement {
    let executable = arguments
        .first()
        .and_then(|value| value.rsplit('/').next())
        .unwrap_or_default();

    if matches!(
        executable,
        "sudo"
            | "su"
            | "doas"
            | "mount"
            | "umount"
            | "umount2"
            | "pivot_root"
            | "reboot"
            | "shutdown"
            | "poweroff"
            | "halt"
            | "fdisk"
            | "parted"
    ) || executable.starts_with("mkfs")
    {
        return ApprovalRequirement::forbidden(format!(
            "Privilege, host-control, or disk-management command is forbidden: {executable}"
        ));
    }

    if contains_sensitive_target(arguments) {
        return ApprovalRequirement::forbidden(
            "Command targets credentials, secrets, or protected agent metadata",
        );
    }

    if executable == "rm" && is_catastrophic_rm(arguments) {
        return ApprovalRequirement::forbidden("Catastrophic recursive deletion is forbidden");
    }

    if executable == "rm"
        && arguments.iter().skip(1).any(|value| {
            value == "-r" || value == "-rf" || value == "-fr" || value == "--recursive"
        })
    {
        return ApprovalRequirement::review(
            RiskLevel::High,
            "Recursive deletion can destroy workspace data",
        );
    }

    if matches!(executable, "sh" | "bash" | "zsh" | "fish" | "dash")
        || matches!(executable, "eval" | "exec")
    {
        return ApprovalRequirement::review(
            RiskLevel::High,
            "Nested shell execution can hide additional actions",
        );
    }

    if matches!(
        executable,
        "curl" | "wget" | "ssh" | "scp" | "sftp" | "nc" | "ncat" | "socat" | "telnet"
    ) {
        return ApprovalRequirement::review(
            RiskLevel::High,
            "Network or remote-access command requires review; command networking is sandboxed off",
        );
    }

    if executable == "git" {
        return classify_git(arguments);
    }

    if executable == "cargo" {
        return match arguments.get(1).map(String::as_str) {
            Some("check" | "test" | "build" | "clippy" | "fmt" | "metadata") => {
                ApprovalRequirement::allow("Known project-local Cargo workflow")
            }
            _ => ApprovalRequirement::review(
                RiskLevel::Medium,
                "Cargo subcommand may execute code or modify external state",
            ),
        };
    }

    if matches!(executable, "pwd" | "true" | "false") {
        return ApprovalRequirement::allow("Known side-effect-free command");
    }

    if executable == "rg"
        && arguments
            .iter()
            .any(|argument| argument == "--pre" || argument.starts_with("--pre="))
    {
        return ApprovalRequirement::review(
            RiskLevel::High,
            "ripgrep --pre can execute an arbitrary preprocessing command",
        );
    }

    if matches!(executable, "ls" | "cat" | "head" | "tail" | "wc" | "rg")
        && arguments
            .iter()
            .skip(1)
            .all(|argument| safe_local_argument(argument))
    {
        return ApprovalRequirement::allow(
            "Known read-only command with workspace-relative arguments",
        );
    }

    ApprovalRequirement::review(
        RiskLevel::Medium,
        format!("Command is not covered by a narrow allow rule: {executable}"),
    )
}

fn classify_git(arguments: &[String]) -> ApprovalRequirement {
    if arguments
        .iter()
        .any(|value| value == "--ext-diff" || value == "--textconv")
    {
        return ApprovalRequirement::review(
            RiskLevel::High,
            "Git external diff or text conversion can execute configured programs",
        );
    }
    match arguments.get(1).map(String::as_str) {
        Some("status" | "diff" | "log" | "show") => {
            ApprovalRequirement::allow("Known read-only Git command")
        }
        Some("clean") if arguments.iter().any(|value| value.contains('f')) => {
            ApprovalRequirement::review(
                RiskLevel::High,
                "Forced git clean can delete untracked work",
            )
        }
        Some("reset") | Some("checkout") | Some("restore") => ApprovalRequirement::review(
            RiskLevel::High,
            "Git command can overwrite or discard workspace changes",
        ),
        _ => ApprovalRequirement::review(
            RiskLevel::Medium,
            "Git command may mutate the repository or contact a remote",
        ),
    }
}

fn safe_local_argument(argument: &str) -> bool {
    argument.starts_with('-')
        || (!argument.starts_with('/')
            && argument != ".."
            && !argument.starts_with("../")
            && !argument.contains("/../"))
}

fn contains_sensitive_target(arguments: &[String]) -> bool {
    arguments.iter().any(|argument| {
        let normalized = argument.to_ascii_lowercase();
        normalized == ".env"
            || normalized.ends_with("/.env")
            || normalized.contains("/.ssh/")
            || normalized.ends_with("/.ssh")
            || normalized.contains("/.aws/")
            || normalized.ends_with("/.aws")
            || normalized.contains("/.gnupg/")
            || normalized.ends_with("/.gnupg")
            || normalized.contains("/.codex/")
            || normalized.contains("/.agents/")
    })
}

fn is_catastrophic_rm(arguments: &[String]) -> bool {
    let recursive = arguments
        .iter()
        .skip(1)
        .any(|value| value == "-r" || value == "-rf" || value == "-fr" || value == "--recursive");
    recursive
        && arguments.iter().skip(1).any(|value| {
            matches!(value.as_str(), "/" | "/*" | "." | "./" | ".." | "../")
                || value == "--no-preserve-root"
        })
}

/// Split only the deliberately small, safe subset of shell syntax used by the
/// rule engine. Anything ambiguous returns `None` and is sent to review.
fn split_simple_script(script: &str) -> Option<Vec<Vec<String>>> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Quote {
        None,
        Single,
        Double,
    }

    let mut commands = Vec::new();
    let mut command = Vec::new();
    let mut word = String::new();
    let mut quote = Quote::None;
    let mut escaped = false;
    let chars = script.chars().collect::<Vec<_>>();
    let mut index = 0;

    while index < chars.len() {
        let character = chars[index];
        if escaped {
            word.push(character);
            escaped = false;
            index += 1;
            continue;
        }

        match quote {
            Quote::Single => {
                if character == '\'' {
                    quote = Quote::None;
                } else {
                    word.push(character);
                }
            }
            Quote::Double => match character {
                '"' => quote = Quote::None,
                '\\' => escaped = true,
                '$' | '`' => return None,
                _ => word.push(character),
            },
            Quote::None => match character {
                '\'' => quote = Quote::Single,
                '"' => quote = Quote::Double,
                '\\' => escaped = true,
                '$' | '`' | '<' | '>' | '*' | '?' | '#' | '(' | ')' | '{' | '}' => return None,
                ' ' | '\t' | '\r' => push_word(&mut command, &mut word),
                '\n' | ';' | '|' | '&' => {
                    push_word(&mut command, &mut word);
                    if character == '&' && chars.get(index + 1) != Some(&'&') {
                        return None;
                    }
                    if matches!(character, '|' | '&') && chars.get(index + 1) == Some(&character) {
                        index += 1;
                    }
                    if command.is_empty() {
                        return None;
                    }
                    if looks_like_assignment(&command[0]) || is_control_flow(&command[0]) {
                        return None;
                    }
                    commands.push(std::mem::take(&mut command));
                }
                _ => word.push(character),
            },
        }
        index += 1;
    }

    if quote != Quote::None || escaped {
        return None;
    }
    push_word(&mut command, &mut word);
    if !command.is_empty() {
        if looks_like_assignment(&command[0]) || is_control_flow(&command[0]) {
            return None;
        }
        commands.push(command);
    }
    Some(commands)
}

fn push_word(command: &mut Vec<String>, word: &mut String) {
    if !word.is_empty() {
        command.push(std::mem::take(word));
    }
}

fn looks_like_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty()
            && name
                .chars()
                .all(|character| character == '_' || character.is_ascii_alphanumeric())
    })
}

fn is_control_flow(word: &str) -> bool {
    matches!(
        word,
        "if" | "then"
            | "else"
            | "elif"
            | "fi"
            | "for"
            | "while"
            | "until"
            | "case"
            | "esac"
            | "do"
            | "done"
            | "function"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allows_narrow_read_and_build_commands() {
        assert_eq!(classify_command("git status").decision, RuleDecision::Allow);
        assert_eq!(classify_command("cargo test").decision, RuleDecision::Allow);
        assert_eq!(
            classify_command("rg 'needle' src").decision,
            RuleDecision::Allow
        );
    }

    #[test]
    fn compound_command_uses_most_restrictive_segment() {
        let result = classify_command("git status && git reset --hard HEAD");
        assert_eq!(result.decision, RuleDecision::Review);
        assert_eq!(result.risk, RiskLevel::High);
    }

    #[test]
    fn executable_options_cannot_hide_behind_read_only_allow_rules() {
        for command in ["rg --pre=helper needle", "git diff --ext-diff"] {
            assert_eq!(classify_command(command).decision, RuleDecision::Review);
            assert_eq!(classify_command(command).risk, RiskLevel::High);
        }
    }

    #[test]
    fn complex_shell_syntax_is_reviewed_conservatively() {
        for command in [
            "echo $TOKEN",
            "cat file > copy",
            "rm *.tmp",
            "FOO=bar cargo test",
        ] {
            assert_eq!(classify_command(command).decision, RuleDecision::Review);
        }
    }

    #[test]
    fn blocks_privilege_secrets_and_catastrophic_deletion() {
        for command in [
            "sudo cargo test",
            "cat /home/me/.ssh/id_ed25519",
            "rm -rf /",
        ] {
            assert_eq!(classify_command(command).decision, RuleDecision::Forbidden);
        }
    }

    #[test]
    fn workspace_tools_do_not_need_review() {
        let result = classify_tool("write_file", &json!({"path": "src/lib.rs"}));
        assert_eq!(result.decision, RuleDecision::Allow);
    }
}
