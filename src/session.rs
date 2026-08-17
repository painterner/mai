use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::conversation::Message;

const STORAGE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    pub version: u32,
    pub id: String,
    pub workspace: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<Message>,
}

impl PersistedSession {
    pub fn new(
        id: impl Into<String>,
        workspace: impl Into<String>,
        created_at: impl Into<String>,
        messages: Vec<Message>,
    ) -> Self {
        Self {
            version: STORAGE_VERSION,
            id: id.into(),
            workspace: workspace.into(),
            created_at: created_at.into(),
            updated_at: now(),
            messages,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummary {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    pub message_count: usize,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SessionIndex {
    #[serde(default = "storage_version")]
    version: u32,
    #[serde(default)]
    directories: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct SessionStore {
    root: PathBuf,
    workspace: String,
}

impl SessionStore {
    pub fn for_workspace(workspace: impl AsRef<Path>) -> Result<Self> {
        let data_dir = dirs::data_local_dir()
            .or_else(dirs::config_dir)
            .context("Failed to determine application data directory")?;
        Self::at(data_dir.join(crate::APP_NAME).join("sessions"), workspace)
    }

    pub fn at(root: impl Into<PathBuf>, workspace: impl AsRef<Path>) -> Result<Self> {
        let root = root.into();
        let records = root.join("records");
        fs::create_dir_all(&records).with_context(|| {
            format!(
                "Failed to create session storage directory: {}",
                records.display()
            )
        })?;
        Ok(Self {
            root,
            workspace: normalize_workspace(workspace.as_ref())?,
        })
    }

    pub fn workspace(&self) -> &str {
        &self.workspace
    }

    pub fn list(&self) -> Result<Vec<SessionSummary>> {
        let index = self.read_index()?;
        let mut sessions = index
            .directories
            .get(&self.workspace)
            .into_iter()
            .flatten()
            .filter_map(|id| self.load_record(id).ok())
            .filter(|session| session.workspace == self.workspace)
            .map(|session| SessionSummary {
                title: session_title(&session.messages),
                message_count: session.messages.len(),
                id: session.id,
                created_at: session.created_at,
                updated_at: session.updated_at,
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(sessions)
    }

    pub fn load(&self, id: &str) -> Result<PersistedSession> {
        validate_session_id(id)?;
        let index = self.read_index()?;
        let belongs_to_workspace = index
            .directories
            .get(&self.workspace)
            .is_some_and(|ids| ids.iter().any(|candidate| candidate == id));
        if !belongs_to_workspace {
            bail!(
                "Session {id} does not belong to workspace {}",
                self.workspace
            );
        }

        let session = self.load_record(id)?;
        if session.workspace != self.workspace {
            bail!("Session {id} has an invalid workspace mapping");
        }
        Ok(session)
    }

    pub fn save(&self, session: &PersistedSession) -> Result<()> {
        validate_session_id(&session.id)?;
        if session.workspace != self.workspace {
            bail!("Cannot save a session for a different workspace");
        }

        let mut session = session.clone();
        session.version = STORAGE_VERSION;
        session.updated_at = now();
        let record_path = self.record_path(&session.id);
        write_json_atomically(&record_path, &session)?;

        let mut index = self.read_index()?;
        index.version = STORAGE_VERSION;
        let ids = index.directories.entry(self.workspace.clone()).or_default();
        if !ids.contains(&session.id) {
            ids.push(session.id.clone());
        }
        write_json_atomically(&self.index_path(), &index)
    }

    fn load_record(&self, id: &str) -> Result<PersistedSession> {
        validate_session_id(id)?;
        let path = self.record_path(id);
        let content = fs::read_to_string(&path)
            .with_context(|| format!("Failed to read session: {}", path.display()))?;
        let session: PersistedSession = serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse session: {}", path.display()))?;
        if session.version != STORAGE_VERSION {
            bail!(
                "Unsupported session storage version {} in {}",
                session.version,
                path.display()
            );
        }
        if session.id != id {
            bail!(
                "Session ID does not match its file name: {}",
                path.display()
            );
        }
        Ok(session)
    }

    fn read_index(&self) -> Result<SessionIndex> {
        let path = self.index_path();
        if !path.exists() {
            return Ok(SessionIndex {
                version: STORAGE_VERSION,
                ..SessionIndex::default()
            });
        }
        let content = fs::read_to_string(&path)
            .with_context(|| format!("Failed to read session index: {}", path.display()))?;
        let index: SessionIndex = serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse session index: {}", path.display()))?;
        if index.version != STORAGE_VERSION {
            bail!(
                "Unsupported session index version {} in {}",
                index.version,
                path.display()
            );
        }
        Ok(index)
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    fn record_path(&self, id: &str) -> PathBuf {
        self.root.join("records").join(format!("{id}.json"))
    }
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn storage_version() -> u32 {
    STORAGE_VERSION
}

fn normalize_workspace(workspace: &Path) -> Result<String> {
    let absolute = if workspace.is_absolute() {
        workspace.to_path_buf()
    } else {
        std::env::current_dir()
            .context("Failed to determine current directory")?
            .join(workspace)
    };
    let normalized = absolute.canonicalize().unwrap_or(absolute);
    Ok(normalized.to_string_lossy().into_owned())
}

fn validate_session_id(id: &str) -> Result<()> {
    let valid = id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        });
    if !valid {
        bail!("Invalid session ID");
    }
    Ok(())
}

fn session_title(messages: &[Message]) -> String {
    let title = messages
        .iter()
        .find(|message| message.role == crate::conversation::Role::User)
        .map(|message| {
            message
                .content
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Untitled session".to_string());
    let mut chars = title.chars();
    let shortened = chars.by_ref().take(60).collect::<String>();
    if chars.next().is_some() {
        format!("{shortened}…")
    } else {
        shortened
    }
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<()> {
    let content = serde_json::to_vec_pretty(value).context("Failed to serialize session data")?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("Session storage path has no file name")?;
    let temporary = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        rand::random::<u64>()
    ));
    fs::write(&temporary, content)
        .with_context(|| format!("Failed to write session data: {}", temporary.display()))?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error)
            .with_context(|| format!("Failed to replace session data: {}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::Message;

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{}-session-test-{name}-{}-{}",
            crate::APP_NAME,
            std::process::id(),
            rand::random::<u64>()
        ))
    }

    fn id(value: u8) -> String {
        format!("00000000-0000-4000-8000-{value:012x}")
    }

    #[test]
    fn saves_lists_and_restores_a_session() {
        let root = test_root("round-trip");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let store = SessionStore::at(root.join("data"), &workspace).unwrap();
        let session = PersistedSession::new(
            id(1),
            store.workspace(),
            now(),
            vec![
                Message::user("first question"),
                Message::assistant("answer"),
            ],
        );

        store.save(&session).unwrap();

        let summaries = store.list().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "first question");
        assert_eq!(summaries[0].message_count, 2);
        assert_eq!(store.load(&id(1)).unwrap().messages, session.messages);
    }

    #[test]
    fn directory_mapping_keeps_workspaces_isolated() {
        let root = test_root("mapping");
        let first_workspace = root.join("first");
        let second_workspace = root.join("second");
        fs::create_dir_all(&first_workspace).unwrap();
        fs::create_dir_all(&second_workspace).unwrap();
        let first = SessionStore::at(root.join("data"), first_workspace).unwrap();
        let second = SessionStore::at(root.join("data"), second_workspace).unwrap();
        first
            .save(&PersistedSession::new(
                id(2),
                first.workspace(),
                now(),
                vec![Message::user("only first")],
            ))
            .unwrap();

        assert_eq!(first.list().unwrap().len(), 1);
        assert!(second.list().unwrap().is_empty());
        assert!(second.load(&id(2)).is_err());
    }

    #[test]
    fn rejects_session_ids_that_could_escape_the_records_directory() {
        let root = test_root("unsafe-id");
        fs::create_dir_all(root.join("workspace")).unwrap();
        let store = SessionStore::at(root.join("data"), root.join("workspace")).unwrap();
        let session = PersistedSession::new(
            "../../outside",
            store.workspace(),
            now(),
            vec![Message::user("unsafe")],
        );

        assert!(store.save(&session).is_err());
        assert!(store.load("../../outside").is_err());
    }
}
