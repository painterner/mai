use anyhow::{Context, Result, bail};
use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

const GEMINI_MODEL: &str = "gemini-2.0-flash";
const GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_MODEL: &str = "gpt-4o-mini";
const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum ApiProvider {
    #[default]
    Gemini,
    Openai,
}

impl ApiProvider {
    pub fn api_key_env(self) -> &'static str {
        match self {
            Self::Gemini => "GEMINI_API_KEY",
            Self::Openai => "OPENAI_API_KEY",
        }
    }

    fn default_model(self) -> &'static str {
        match self {
            Self::Gemini => GEMINI_MODEL,
            Self::Openai => OPENAI_MODEL,
        }
    }

    fn default_base_url(self) -> &'static str {
        match self {
            Self::Gemini => GEMINI_BASE_URL,
            Self::Openai => OPENAI_BASE_URL,
        }
    }
}

impl fmt::Display for ApiProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Gemini => formatter.write_str("gemini"),
            Self::Openai => formatter.write_str("openai"),
        }
    }
}

impl FromStr for ApiProvider {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "gemini" => Ok(Self::Gemini),
            "openai" | "openai-compatible" | "openai_compatible" => Ok(Self::Openai),
            _ => bail!("Unsupported API provider '{value}'; use 'gemini' or 'openai'"),
        }
    }
}

/// Application configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Wire protocol used by the API server.
    #[serde(default)]
    pub provider: ApiProvider,

    /// API key. It may be empty for local OpenAI-compatible servers.
    #[serde(default)]
    pub api_key: String,

    /// Default model. An empty value selects the provider default.
    #[serde(default)]
    pub model: String,

    /// API base URL. An empty value selects the provider default.
    #[serde(default)]
    pub base_url: String,

    /// Max tokens for response.
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,

    /// Temperature for generation.
    #[serde(default = "default_temperature")]
    pub temperature: f32,
}

fn default_max_tokens() -> u32 {
    8192
}

fn default_temperature() -> f32 {
    0.7
}

impl Default for Config {
    fn default() -> Self {
        Self {
            provider: ApiProvider::Gemini,
            api_key: String::new(),
            model: GEMINI_MODEL.to_string(),
            base_url: GEMINI_BASE_URL.to_string(),
            max_tokens: default_max_tokens(),
            temperature: default_temperature(),
        }
    }
}

impl Config {
    /// Get the config file path: ~/.config/gemini-cli/config.toml
    pub fn config_path() -> Result<PathBuf> {
        let config_dir = dirs::config_dir()
            .context("Failed to determine config directory")?
            .join("gemini-cli");
        fs::create_dir_all(&config_dir)?;
        Ok(config_dir.join("config.toml"))
    }

    /// Load config from file or create a default one.
    pub fn load_or_create() -> Result<Self> {
        let path = Self::config_path()?;

        if path.exists() {
            let content = fs::read_to_string(&path)
                .with_context(|| format!("Failed to read config: {}", path.display()))?;
            let config: Config = toml::from_str(&content)
                .with_context(|| format!("Failed to parse config: {}", path.display()))?;
            Ok(config.with_env_overrides())
        } else {
            let config = Config::default().with_env_overrides();

            if config.api_key.is_empty() {
                let template = r#"# Gemini CLI Configuration
# provider can be "gemini" or "openai"

provider = "gemini"
api_key = ""
model = "gemini-2.0-flash"
base_url = "https://generativelanguage.googleapis.com/v1beta"
max_tokens = 8192
temperature = 0.7
"#;
                fs::write(&path, template)?;
                eprintln!(
                    "⚠️  No API key found. Set {} or edit:\n   {}",
                    config.provider.api_key_env(),
                    path.display()
                );
            }

            Ok(config)
        }
    }

    /// Change protocol and migrate values that were still using the previous
    /// provider's defaults. Explicit custom values are preserved.
    pub fn set_provider(&mut self, provider: ApiProvider) {
        if self.provider == provider {
            return;
        }
        let previous = self.provider;
        self.provider = provider;
        if self.model.is_empty() || self.model == previous.default_model() {
            self.model = provider.default_model().to_string();
        }
        if self.base_url.is_empty() || self.base_url == previous.default_base_url() {
            self.base_url = provider.default_base_url().to_string();
        }
    }

    fn normalize(mut self) -> Self {
        if self.model.is_empty() {
            self.model = self.provider.default_model().to_string();
        }
        if self.base_url.is_empty() {
            self.base_url = self.provider.default_base_url().to_string();
        }
        self
    }

    /// Override config values from environment variables.
    fn with_env_overrides(mut self) -> Self {
        if let Ok(provider) = std::env::var("API_PROVIDER")
            && !provider.is_empty()
        {
            match <ApiProvider as FromStr>::from_str(&provider) {
                Ok(provider) => self.set_provider(provider),
                Err(error) => eprintln!("⚠️  Ignoring invalid API_PROVIDER: {error}"),
            }
        }

        self.apply_provider_env();
        self.normalize()
    }

    /// Apply environment variables for the currently selected provider.
    /// This is also used after a CLI provider override.
    pub fn apply_provider_env(&mut self) {
        let prefix = match self.provider {
            ApiProvider::Gemini => "GEMINI",
            ApiProvider::Openai => "OPENAI",
        };
        if let Ok(key) = std::env::var(format!("{prefix}_API_KEY"))
            && !key.is_empty()
        {
            self.api_key = key;
        }
        if let Ok(model) = std::env::var(format!("{prefix}_MODEL"))
            && !model.is_empty()
        {
            self.model = model;
        }
        if let Ok(url) = std::env::var(format!("{prefix}_BASE_URL"))
            && !url.is_empty()
        {
            self.base_url = url;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_config_uses_openai_defaults_when_values_are_omitted() {
        let config: Config = toml::from_str("provider = \"openai\"").unwrap();
        let config = config.normalize();
        assert_eq!(config.model, OPENAI_MODEL);
        assert_eq!(config.base_url, OPENAI_BASE_URL);
    }

    #[test]
    fn changing_provider_migrates_only_provider_defaults() {
        let mut config = Config::default();
        config.set_provider(ApiProvider::Openai);
        assert_eq!(config.model, OPENAI_MODEL);
        assert_eq!(config.base_url, OPENAI_BASE_URL);

        config.model = "custom-model".to_string();
        config.base_url = "http://localhost:1234/v1".to_string();
        config.set_provider(ApiProvider::Gemini);
        assert_eq!(config.model, "custom-model");
        assert_eq!(config.base_url, "http://localhost:1234/v1");
    }
}
