use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::approval::{ApprovalRequirement, classify_tool};
use super::sandbox;

const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_CHARS: usize = 100_000;
const MAX_SEARCH_RESULTS: usize = 100;

#[derive(Debug, Clone, Copy)]
pub struct ToolPermissions {
    pub write: bool,
    pub shell: bool,
}

impl ToolPermissions {
    pub fn workspace_write(shell: bool) -> Self {
        Self { write: true, shell }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct ToolRegistry {
    workspace: PathBuf,
    permissions: ToolPermissions,
}

impl ToolRegistry {
    pub fn new(workspace: impl AsRef<Path>, permissions: ToolPermissions) -> Result<Self> {
        let workspace = workspace.as_ref().canonicalize().with_context(|| {
            format!(
                "Failed to resolve workspace: {}",
                workspace.as_ref().display()
            )
        })?;
        if !workspace.is_dir() {
            bail!("Workspace is not a directory: {}", workspace.display());
        }
        Ok(Self {
            workspace,
            permissions,
        })
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let mut definitions = vec![
            ToolDefinition {
                name: "list_files",
                description: "List the direct children of a workspace directory.",
                arguments: json!({
                    "type": "object",
                    "properties": {"path": {"type": "string", "default": "."}}
                }),
            },
            ToolDefinition {
                name: "read_file",
                description: "Read a UTF-8 workspace file with line numbers.",
                arguments: json!({
                    "type": "object",
                    "required": ["path"],
                    "properties": {
                        "path": {"type": "string"},
                        "start_line": {"type": "integer", "minimum": 1},
                        "end_line": {"type": "integer", "minimum": 1}
                    }
                }),
            },
            ToolDefinition {
                name: "search_files",
                description: "Search UTF-8 files below a workspace path for literal text.",
                arguments: json!({
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {"type": "string"},
                        "path": {"type": "string", "default": "."},
                        "case_sensitive": {"type": "boolean", "default": false}
                    }
                }),
            },
        ];

        if self.permissions.write {
            definitions.extend([
                ToolDefinition {
                    name: "write_file",
                    description: "Create or replace a UTF-8 file inside the workspace.",
                    arguments: json!({
                        "type": "object",
                        "required": ["path", "content"],
                        "properties": {
                            "path": {"type": "string"},
                            "content": {"type": "string"}
                        }
                    }),
                },
                ToolDefinition {
                    name: "replace_in_file",
                    description: "Replace one exact, uniquely occurring string in a workspace file.",
                    arguments: json!({
                        "type": "object",
                        "required": ["path", "old", "new"],
                        "properties": {
                            "path": {"type": "string"},
                            "old": {"type": "string"},
                            "new": {"type": "string"}
                        }
                    }),
                },
            ]);
        }

        if self.permissions.shell {
            definitions.push(ToolDefinition {
                name: "run_command",
                description: "Run a shell command in a network-disabled Linux sandbox with workspace-only writes and return its exit status and output.",
                arguments: json!({
                    "type": "object",
                    "required": ["command"],
                    "properties": {
                        "command": {"type": "string"},
                        "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 300}
                    }
                }),
            });
        }

        definitions
    }

    pub fn definitions_json(&self) -> String {
        serde_json::to_string_pretty(&self.definitions())
            .expect("tool definitions must always serialize")
    }

    pub fn approval_requirement(&self, tool: &str, arguments: &Value) -> ApprovalRequirement {
        classify_tool(tool, arguments)
    }

    pub async fn execute(&self, tool: &str, arguments: Value) -> Result<String> {
        match tool {
            "list_files" => self.list_files(parse_arguments(arguments)?),
            "read_file" => self.read_file(parse_arguments(arguments)?),
            "search_files" => self.search_files(parse_arguments(arguments)?),
            "write_file" if self.permissions.write => self.write_file(parse_arguments(arguments)?),
            "replace_in_file" if self.permissions.write => {
                self.replace_in_file(parse_arguments(arguments)?)
            }
            "run_command" if self.permissions.shell => {
                self.run_command(parse_arguments(arguments)?).await
            }
            "write_file" | "replace_in_file" => bail!("Workspace writes are disabled"),
            "run_command" => bail!("Shell execution is disabled by --no-shell"),
            _ => bail!("Unknown tool: {tool}"),
        }
    }

    fn list_files(&self, arguments: ListFilesArgs) -> Result<String> {
        let directory = self.resolve_existing(&arguments.path)?;
        if !directory.is_dir() {
            bail!("Not a directory: {}", arguments.path);
        }

        let mut entries = fs::read_dir(&directory)
            .with_context(|| format!("Failed to list directory: {}", arguments.path))?
            .map(|entry| {
                let entry = entry?;
                let suffix = if entry.file_type()?.is_dir() { "/" } else { "" };
                Ok(format!("{}{}", entry.file_name().to_string_lossy(), suffix))
            })
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort();
        Ok(if entries.is_empty() {
            "(empty directory)".to_string()
        } else {
            entries.join("\n")
        })
    }

    fn read_file(&self, arguments: ReadFileArgs) -> Result<String> {
        let path = self.resolve_existing(&arguments.path)?;
        if !path.is_file() {
            bail!("Not a file: {}", arguments.path);
        }
        let content = read_utf8_file(&path)?;
        let start = arguments.start_line.unwrap_or(1);
        let end = arguments.end_line.unwrap_or(start.saturating_add(399));
        if start == 0 || end < start {
            bail!("Invalid line range: {start}..{end}");
        }

        let output = content
            .lines()
            .enumerate()
            .skip(start - 1)
            .take(end - start + 1)
            .map(|(index, line)| format!("{}: {}", index + 1, line))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(if output.is_empty() {
            "(no lines in requested range)".to_string()
        } else {
            output
        })
    }

    fn search_files(&self, arguments: SearchFilesArgs) -> Result<String> {
        if arguments.query.is_empty() {
            bail!("Search query cannot be empty");
        }
        let start = self.resolve_existing(&arguments.path)?;
        let mut files = Vec::new();
        collect_files(&start, &mut files)?;
        files.sort();

        let needle = if arguments.case_sensitive {
            arguments.query.clone()
        } else {
            arguments.query.to_lowercase()
        };
        let mut matches = Vec::new();
        for path in files {
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if metadata.len() > MAX_FILE_BYTES as u64 {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            for (index, line) in content.lines().enumerate() {
                let haystack = if arguments.case_sensitive {
                    line.to_string()
                } else {
                    line.to_lowercase()
                };
                if haystack.contains(&needle) {
                    let relative = path.strip_prefix(&self.workspace).unwrap_or(&path);
                    matches.push(format!(
                        "{}:{}: {}",
                        relative.display(),
                        index + 1,
                        truncate(line.trim(), 300)
                    ));
                    if matches.len() == MAX_SEARCH_RESULTS {
                        return Ok(format!("{}\n(result limit reached)", matches.join("\n")));
                    }
                }
            }
        }

        Ok(if matches.is_empty() {
            "(no matches)".to_string()
        } else {
            matches.join("\n")
        })
    }

    fn write_file(&self, arguments: WriteFileArgs) -> Result<String> {
        let path = self.resolve_for_write(&arguments.path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create directory: {}", parent.display()))?;
        }
        fs::write(&path, arguments.content.as_bytes())
            .with_context(|| format!("Failed to write file: {}", arguments.path))?;
        Ok(format!(
            "Wrote {} bytes to {}",
            arguments.content.len(),
            arguments.path
        ))
    }

    fn replace_in_file(&self, arguments: ReplaceInFileArgs) -> Result<String> {
        if arguments.old.is_empty() {
            bail!("Replacement target cannot be empty");
        }
        let path = self.resolve_existing(&arguments.path)?;
        let content = read_utf8_file(&path)?;
        let occurrences = content.matches(&arguments.old).count();
        if occurrences != 1 {
            bail!(
                "Expected replacement target to occur exactly once, found {occurrences} occurrences"
            );
        }
        let updated = content.replacen(&arguments.old, &arguments.new, 1);
        fs::write(&path, updated)
            .with_context(|| format!("Failed to write file: {}", arguments.path))?;
        Ok(format!("Updated {}", arguments.path))
    }

    async fn run_command(&self, arguments: RunCommandArgs) -> Result<String> {
        let timeout_seconds = arguments.timeout_seconds.unwrap_or(120).clamp(1, 300);
        let output = sandbox::run_command(
            &self.workspace,
            &arguments.command,
            Duration::from_secs(timeout_seconds),
        )
        .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(truncate(
            &format!(
                "exit status: {}\nstdout:\n{}\nstderr:\n{}",
                output.status, stdout, stderr
            ),
            MAX_OUTPUT_CHARS,
        ))
    }

    fn resolve_existing(&self, input: &str) -> Result<PathBuf> {
        let relative = normalize_relative(input)?;
        let resolved = self
            .workspace
            .join(relative)
            .canonicalize()
            .with_context(|| {
                format!("Workspace path does not exist or cannot be resolved: {input}")
            })?;
        self.ensure_in_workspace(resolved)
    }

    fn resolve_for_write(&self, input: &str) -> Result<PathBuf> {
        let relative = normalize_relative(input)?;
        let candidate = self.workspace.join(relative);

        if candidate.exists() {
            return self.ensure_in_workspace(candidate.canonicalize()?);
        }

        let mut ancestor = candidate.as_path();
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .context("Workspace path has no existing ancestor")?;
        }
        self.ensure_in_workspace(ancestor.canonicalize()?)?;
        Ok(candidate)
    }

    fn ensure_in_workspace(&self, path: PathBuf) -> Result<PathBuf> {
        if path.starts_with(&self.workspace) {
            Ok(path)
        } else {
            bail!("Path escapes workspace: {}", path.display())
        }
    }
}

#[derive(Debug, Deserialize)]
struct ListFilesArgs {
    #[serde(default = "default_path")]
    path: String,
}

#[derive(Debug, Deserialize)]
struct ReadFileArgs {
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct SearchFilesArgs {
    query: String,
    #[serde(default = "default_path")]
    path: String,
    #[serde(default)]
    case_sensitive: bool,
}

#[derive(Debug, Deserialize)]
struct WriteFileArgs {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ReplaceInFileArgs {
    path: String,
    old: String,
    new: String,
}

#[derive(Debug, Deserialize)]
struct RunCommandArgs {
    command: String,
    timeout_seconds: Option<u64>,
}

fn parse_arguments<T>(arguments: Value) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(arguments).context("Invalid tool arguments")
}

fn default_path() -> String {
    ".".to_string()
}

fn normalize_relative(input: &str) -> Result<PathBuf> {
    let path = Path::new(if input.is_empty() { "." } else { input });
    if path.is_absolute() {
        bail!("Absolute paths are not allowed: {input}");
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("Parent or rooted paths are not allowed: {input}")
            }
        }
    }
    Ok(normalized)
}

fn read_utf8_file(path: &Path) -> Result<String> {
    let bytes =
        fs::read(path).with_context(|| format!("Failed to read file: {}", path.display()))?;
    if bytes.len() > MAX_FILE_BYTES {
        bail!(
            "File is too large ({} bytes, limit is {} bytes)",
            bytes.len(),
            MAX_FILE_BYTES
        );
    }
    String::from_utf8(bytes).with_context(|| format!("File is not valid UTF-8: {}", path.display()))
}

fn collect_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    if path.is_file() {
        files.push(path.to_path_buf());
        return Ok(());
    }

    for entry in fs::read_dir(path)
        .with_context(|| format!("Failed to search directory: {}", path.display()))?
    {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        if file_type.is_dir() {
            if name != ".git" && name != "target" {
                collect_files(&entry.path(), files)?;
            }
        } else if file_type.is_file() {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}\n(output truncated)")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    struct TestWorkspace(PathBuf);

    impl TestWorkspace {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "{}-agent-test-{}-{unique}",
                crate::APP_NAME,
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn rejects_paths_outside_workspace() {
        let workspace = TestWorkspace::new();
        let registry =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(false)).unwrap();

        let error = registry
            .execute("read_file", json!({"path": "../secret"}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("not allowed"));
    }

    #[tokio::test]
    async fn writes_reads_and_replaces_workspace_file() {
        let workspace = TestWorkspace::new();
        let registry =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(false)).unwrap();

        registry
            .execute(
                "write_file",
                json!({"path": "src/example.txt", "content": "first\nsecond\n"}),
            )
            .await
            .unwrap();
        let content = registry
            .execute(
                "read_file",
                json!({"path": "src/example.txt", "start_line": 2, "end_line": 2}),
            )
            .await
            .unwrap();
        assert_eq!(content, "2: second");

        registry
            .execute(
                "replace_in_file",
                json!({"path": "src/example.txt", "old": "second", "new": "updated"}),
            )
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(workspace.0.join("src/example.txt")).unwrap(),
            "first\nupdated\n"
        );
    }

    #[test]
    fn shell_tool_is_only_advertised_when_enabled() {
        let workspace = TestWorkspace::new();
        let without_shell =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(false)).unwrap();
        let with_shell =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(true)).unwrap();

        assert!(!without_shell.definitions_json().contains("run_command"));
        assert!(with_shell.definitions_json().contains("run_command"));
    }
}
