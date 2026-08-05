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

    /// Enable debug mode
    #[arg(short, long, default_value_t = false)]
    pub debug: bool,
}
