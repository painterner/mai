use clap::Parser;

use crate::config::ApiProvider;

/// Gemini CLI - A fast terminal-based Gemini AI assistant
#[derive(Parser, Debug)]
#[command(name = "gemini", version, about, long_about = None)]
pub struct Args {
    /// Send a single prompt without entering interactive mode
    #[arg(short, long)]
    pub prompt: Option<String>,

    /// Model to use (e.g. gemini-2.0-flash, gemini-2.5-pro)
    #[arg(short, long)]
    pub model: Option<String>,

    /// API protocol to use (gemini or openai)
    #[arg(long, value_enum)]
    pub provider: Option<ApiProvider>,

    /// Enable debug mode
    #[arg(short, long, default_value_t = false)]
    pub debug: bool,
}
