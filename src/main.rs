mod api;
mod app;
mod cli;
mod config;
mod markdown;
mod ui;

use anyhow::Result;
use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::app::App;
use crate::cli::Args;
use crate::config::Config;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_target(false)
        .init();

    let args = Args::parse();

    // Load or create config
    let mut config = Config::load_or_create()?;
    if let Some(provider) = args.provider {
        config.set_provider(provider);
        config.apply_provider_env();
    }
    if let Some(model) = &args.model {
        config.model = model.clone();
    }

    // Handle non-interactive commands
    if let Some(prompt) = &args.prompt {
        // Non-interactive: single prompt mode
        let api = api::ApiClient::new(&config)?;
        let response = api.chat(prompt, &[]).await?;
        println!("{response}");
        return Ok(());
    }

    // Interactive TUI mode
    let mut app = App::new(config, args)?;
    app.run().await?;

    Ok(())
}
