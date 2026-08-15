use clap::Parser;

use crate::config::ApiProvider;

/// A fast terminal AI assistant using an OpenAI-compatible API by default
#[derive(Parser, Debug)]
#[command(name = "gemini", version, about, long_about = None)]
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

    /// Allow the agent to run shell commands in the workspace
    #[arg(long, default_value_t = false)]
    pub allow_shell: bool,

    /// Enable debug mode
    #[arg(short, long, default_value_t = false)]
    pub debug: bool,
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
            "gemini",
            "--agent",
            "--agent-max-steps",
            "5",
            "--allow-shell",
            "-p",
            "check the project",
        ])
        .unwrap();

        assert!(args.agent);
        assert!(args.allow_shell);
        assert_eq!(args.agent_max_steps, 5);
        assert_eq!(args.prompt.as_deref(), Some("check the project"));
    }

    #[test]
    fn rejects_zero_agent_steps() {
        assert!(Args::try_parse_from(["gemini", "--agent-max-steps", "0"]).is_err());
    }
}
