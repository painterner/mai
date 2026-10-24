use clap::Parser;

use crate::config::ApiProvider;

/// A fast terminal AI assistant using an OpenAI-compatible API by default
#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
pub struct Args {
    /// Send a single prompt without entering interactive mode
    #[arg(short, long)]
    pub prompt: Option<String>,

    /// Model to use (e.g. gpt-4o-mini or a compatible server's model name)
    #[arg(short, long)]
    pub model: Option<String>,

    /// API protocol to use (gemini or openai)
    #[arg(long, value_enum)]
    pub provider: Option<ApiProvider>,

    /// Run prompts with workspace tools enabled
    #[arg(long, default_value_t = false)]
    pub agent: bool,

    /// Maximum model/tool turns for one agent task
    #[arg(
        long,
        default_value_t = 12,
        value_parser = parse_positive_usize
    )]
    pub agent_max_steps: usize,

    /// Explicitly enable sandboxed shell commands (enabled by default)
    #[arg(long, default_value_t = true, conflicts_with = "no_shell")]
    pub allow_shell: bool,

    /// Disable the Agent's shell command tool
    #[arg(long, default_value_t = false)]
    pub no_shell: bool,

    /// Enable debug mode
    #[arg(short, long, default_value_t = false)]
    pub debug: bool,
}

impl Args {
    pub fn shell_enabled(&self) -> bool {
        self.allow_shell && !self.no_shell
    }
}

fn parse_positive_usize(value: &str) -> Result<usize, String> {
    let value = value
        .parse::<usize>()
        .map_err(|_| "must be a positive integer".to_string())?;
    if value == 0 {
        Err("must be greater than zero".to_string())
    } else {
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_options() {
        let args = Args::try_parse_from([
            crate::APP_NAME,
            "--agent",
            "--agent-max-steps",
            "5",
            "--allow-shell",
            "-p",
            "check the project",
        ])
        .unwrap();

        assert!(args.agent);
        assert!(args.shell_enabled());
        assert_eq!(args.agent_max_steps, 5);
        assert_eq!(args.prompt.as_deref(), Some("check the project"));
    }

    #[test]
    fn shell_is_enabled_by_default_and_can_be_disabled() {
        let defaults = Args::try_parse_from([crate::APP_NAME]).unwrap();
        assert!(defaults.shell_enabled());

        let disabled = Args::try_parse_from([crate::APP_NAME, "--no-shell"]).unwrap();
        assert!(!disabled.shell_enabled());
    }

    #[test]
    fn rejects_zero_agent_steps() {
        assert!(Args::try_parse_from([crate::APP_NAME, "--agent-max-steps", "0"]).is_err());
    }

    #[test]
    fn command_name_comes_from_cargo_package() {
        use clap::CommandFactory;

        assert_eq!(Args::command().get_name(), crate::APP_NAME);
    }
}
