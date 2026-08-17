pub const APP_NAME: &str = env!("CARGO_PKG_NAME");

pub mod agent;
pub mod api;
pub mod app;
pub mod cli;
pub mod config;
pub mod conversation;
mod markdown;
pub mod prompts;
pub mod session;
mod ui;
