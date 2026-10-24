use std::path::Path;
use std::process::Output;
use std::time::Duration;

use anyhow::Result;

#[cfg(target_os = "linux")]
use anyhow::Context;
#[cfg(target_os = "linux")]
use std::collections::BTreeSet;
#[cfg(target_os = "linux")]
use std::ffi::OsString;
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io::{Seek, SeekFrom, Write};
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use tokio::process::Command;

pub async fn run_command(workspace: &Path, script: &str, timeout: Duration) -> Result<Output> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (workspace, script, timeout);
        anyhow::bail!("Sandboxed command execution currently requires Linux and bubblewrap");
    }

    #[cfg(target_os = "linux")]
    run_linux_command(workspace, script, timeout).await
}

/// A bubblewrap command prepared for a PTY host. The seccomp descriptor is
/// deliberately retained by this value until the caller has spawned the
/// process; it is referenced by number in `args` and must be inherited by
/// bubblewrap.
#[cfg(target_os = "linux")]
pub struct PreparedInteractiveCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
    seccomp_path: PathBuf,
}

#[cfg(target_os = "linux")]
impl Drop for PreparedInteractiveCommand {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.seccomp_path);
    }
}

/// Builds the same Linux sandbox used by `run_command`, but leaves process
/// spawning to a PTY owner. This keeps interactive API terminals inside the
/// exact same workspace and seccomp boundary as one-shot shell tools.
#[cfg(target_os = "linux")]
pub fn prepare_interactive_command(
    workspace: &Path,
    script: &str,
) -> Result<PreparedInteractiveCommand> {
    let seccomp = create_seccomp_filter()?;
    let seccomp_path = persist_seccomp_filter(seccomp)?;
    let mut args = vec![
        "--die-with-parent".into(),
        "--new-session".into(),
        "--unshare-user".into(),
        "--unshare-ipc".into(),
        "--unshare-pid".into(),
        "--unshare-uts".into(),
        "--unshare-cgroup-try".into(),
        "--hostname".into(),
        "maicli-sandbox".into(),
        "--ro-bind".into(),
        "/".into(),
        "/".into(),
        "--tmpfs".into(),
        "/home".into(),
        "--tmpfs".into(),
        "/tmp".into(),
        "--tmpfs".into(),
        "/run".into(),
        "--dev".into(),
        "/dev".into(),
    ];
    add_interactive_proc_mount(&mut args);

    let support_mounts = sandbox_support_mounts(workspace);
    let mut destinations = support_mounts
        .iter()
        .map(|mount| mount.destination.clone())
        .collect::<Vec<_>>();
    destinations.push(workspace.to_path_buf());
    destinations.push(PathBuf::from("/tmp/maicli-home"));
    destinations.push(PathBuf::from("/tmp/maicli-cargo"));

    let mut directories = BTreeSet::new();
    for destination in destinations {
        let directory = if destination.is_file() {
            destination.parent().unwrap_or(Path::new("/"))
        } else {
            destination.as_path()
        };
        for ancestor in directory.ancestors().collect::<Vec<_>>().into_iter().rev() {
            if ancestor != Path::new("/") {
                directories.insert(ancestor.to_path_buf());
            }
        }
    }
    for directory in directories {
        args.push("--dir".into());
        args.push(directory.into_os_string());
    }

    for mount in support_mounts {
        args.push("--ro-bind".into());
        args.push(mount.source.into_os_string());
        args.push(mount.destination.into_os_string());
    }
    args.push("--bind".into());
    args.push(workspace.as_os_str().to_owned());
    args.push(workspace.as_os_str().to_owned());
    for protected in [".git", ".agents", ".codex"] {
        let path = workspace.join(protected);
        if path.exists() {
            args.push("--ro-bind".into());
            args.push(path.as_os_str().to_owned());
            args.push(path.into_os_string());
        }
    }

    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string());
    let lang = std::env::var("LANG").unwrap_or_else(|_| "C.UTF-8".to_string());
    args.push("--clearenv".into());
    for (key, value) in [
        ("PATH", path),
        ("HOME", "/tmp/maicli-home".to_string()),
        ("TMPDIR", "/tmp".to_string()),
        ("CARGO_HOME", "/tmp/maicli-cargo".to_string()),
        ("LANG", lang),
        ("TERM", "xterm-256color".to_string()),
    ] {
        args.push("--setenv".into());
        args.push(key.into());
        args.push(value.into());
    }

    if let Some(rustup_home) = host_tool_home("RUSTUP_HOME", ".rustup")
        && rustup_home.exists()
    {
        args.push("--setenv".into());
        args.push("RUSTUP_HOME".into());
        args.push(rustup_home.into_os_string());
    }

    args.push("--chdir".into());
    args.push(workspace.as_os_str().to_owned());
    args.push("--seccomp".into());
    // portable-pty deliberately closes all non-stdio descriptors before
    // exec. A tiny shell wrapper therefore opens the filter *after* that
    // cleanup and passes it to bubblewrap on stable descriptor 3.
    args.push("3".into());
    args.push("--".into());
    args.push("sh".into());
    args.push("-lc".into());
    args.push(script.into());

    let mut wrapped = vec![
        "-c".into(),
        "exec 3<\"$1\"; shift; exec \"$@\"".into(),
        "mai-sandbox-pty".into(),
        seccomp_path.as_os_str().to_owned(),
        "bwrap".into(),
    ];
    wrapped.extend(args);

    Ok(PreparedInteractiveCommand {
        program: "sh".into(),
        args: wrapped,
        seccomp_path,
    })
}

#[cfg(target_os = "linux")]
fn persist_seccomp_filter(seccomp: OwnedFd) -> Result<PathBuf> {
    use std::fs::OpenOptions;
    use std::time::{SystemTime, UNIX_EPOCH};

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("maicli-seccomp-{}-{unique}", std::process::id()));
    let mut source = File::from(seccomp);
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .context("Failed to create temporary interactive seccomp filter")?;
    std::io::copy(&mut source, &mut destination)
        .context("Failed to persist interactive seccomp filter")?;
    destination
        .flush()
        .context("Failed to flush interactive seccomp filter")?;
    Ok(path)
}

#[cfg(target_os = "linux")]
async fn run_linux_command(workspace: &Path, script: &str, timeout: Duration) -> Result<Output> {
    let seccomp = create_seccomp_filter()?;
    let mut command = Command::new("bwrap");
    command
        .arg("--die-with-parent")
        .arg("--new-session")
        .arg("--unshare-user")
        .arg("--unshare-ipc")
        .arg("--unshare-pid");
    command
        .arg("--unshare-uts")
        .arg("--unshare-cgroup-try")
        .arg("--hostname")
        .arg("maicli-sandbox")
        .arg("--ro-bind")
        .arg("/")
        .arg("/")
        // Hide host homes and runtime sockets, then mount back only the
        // workspace and executable/toolchain paths required by PATH.
        .arg("--tmpfs")
        .arg("/home")
        .arg("--tmpfs")
        .arg("/tmp")
        .arg("--tmpfs")
        .arg("/run")
        .arg("--dev")
        .arg("/dev");
    add_proc_mount(&mut command);

    let support_mounts = sandbox_support_mounts(workspace);
    let mut destinations = support_mounts
        .iter()
        .map(|mount| mount.destination.clone())
        .collect::<Vec<_>>();
    destinations.push(workspace.to_path_buf());
    destinations.push(PathBuf::from("/tmp/maicli-home"));
    destinations.push(PathBuf::from("/tmp/maicli-cargo"));
    add_destination_directories(&mut command, &destinations);

    for mount in support_mounts {
        command
            .arg("--ro-bind")
            .arg(&mount.source)
            .arg(&mount.destination);
    }
    command.arg("--bind").arg(workspace).arg(workspace);
    for protected in [".git", ".agents", ".codex"] {
        let path = workspace.join(protected);
        if path.exists() {
            command.arg("--ro-bind").arg(&path).arg(&path);
        }
    }

    command
        .arg("--chdir")
        .arg(workspace)
        .arg("--clearenv")
        .arg("--setenv")
        .arg("PATH")
        .arg(std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string()))
        .arg("--setenv")
        .arg("HOME")
        .arg("/tmp/maicli-home")
        .arg("--setenv")
        .arg("TMPDIR")
        .arg("/tmp")
        .arg("--setenv")
        .arg("CARGO_HOME")
        .arg("/tmp/maicli-cargo")
        .arg("--setenv")
        .arg("LANG")
        .arg(std::env::var("LANG").unwrap_or_else(|_| "C.UTF-8".to_string()))
        .arg("--setenv")
        .arg("TERM")
        .arg(std::env::var("TERM").unwrap_or_else(|_| "dumb".to_string()));

    if let Some(rustup_home) = host_tool_home("RUSTUP_HOME", ".rustup")
        && rustup_home.exists()
    {
        command.arg("--setenv").arg("RUSTUP_HOME").arg(rustup_home);
    }

    command
        .arg("--seccomp")
        .arg(seccomp.as_raw_fd().to_string())
        .arg("--")
        .arg("sh")
        .arg("-c")
        .arg(script)
        .kill_on_drop(true);

    tokio::time::timeout(timeout, command.output())
        .await
        .with_context(|| format!("Command timed out after {} seconds", timeout.as_secs()))?
        .context(
            "Failed to start the Linux sandbox. Install bubblewrap and ensure unprivileged user namespaces are enabled",
        )
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SandboxMount {
    source: PathBuf,
    destination: PathBuf,
}

#[cfg(target_os = "linux")]
fn sandbox_support_mounts(workspace: &Path) -> Vec<SandboxMount> {
    let mut mounts = BTreeSet::new();
    // `/run` is replaced with an empty tmpfs below. On systems where
    // `/etc/resolv.conf` points into `/run` (notably systemd-resolved), mount
    // the resolved file back so commands sharing the host network can also
    // resolve DNS names.
    if let Ok(resolver) = std::fs::canonicalize("/etc/resolv.conf")
        && resolver.starts_with("/run")
        && resolver.is_file()
    {
        mounts.insert(SandboxMount {
            source: resolver.clone(),
            destination: resolver,
        });
    }
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            if entry.is_absolute() && entry.exists() && !entry.starts_with(workspace) {
                mounts.insert(SandboxMount {
                    source: entry.clone(),
                    destination: entry,
                });
            }
        }
    }

    if let Some(rustup_home) = host_tool_home("RUSTUP_HOME", ".rustup")
        && rustup_home.exists()
        && !rustup_home.starts_with(workspace)
    {
        mounts.insert(SandboxMount {
            source: rustup_home.clone(),
            destination: rustup_home,
        });
    }
    if let Some(cargo_home) = host_tool_home("CARGO_HOME", ".cargo") {
        for child in ["registry", "git"] {
            let source = cargo_home.join(child);
            if source.exists() && !source.starts_with(workspace) {
                mounts.insert(SandboxMount {
                    source,
                    destination: PathBuf::from("/tmp/maicli-cargo").join(child),
                });
            }
        }
    }
    mounts.into_iter().collect()
}

#[cfg(target_os = "linux")]
fn host_tool_home(variable: &str, default_child: &str) -> Option<PathBuf> {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(default_child)))
}

#[cfg(target_os = "linux")]
fn add_destination_directories(command: &mut Command, destinations: &[PathBuf]) {
    let mut directories = BTreeSet::new();
    for destination in destinations {
        let directory = if destination.is_file() {
            destination.parent().unwrap_or(Path::new("/"))
        } else {
            destination.as_path()
        };
        for ancestor in directory.ancestors().collect::<Vec<_>>().into_iter().rev() {
            if ancestor != Path::new("/") {
                directories.insert(ancestor.to_path_buf());
            }
        }
    }
    for directory in directories {
        command.arg("--dir").arg(directory);
    }
}

#[cfg(target_os = "linux")]
fn bind_existing_proc() -> bool {
    std::env::var("MAI_SANDBOX_PROC_MODE").is_ok_and(|value| value.eq_ignore_ascii_case("bind"))
}

#[cfg(target_os = "linux")]
fn add_interactive_proc_mount(args: &mut Vec<OsString>) {
    if bind_existing_proc() {
        // Docker applies restrictions to its procfs mount which prevent a
        // nested user namespace from creating a fresh procfs. Reusing that
        // already container-scoped procfs read-only preserves the outer
        // container boundary while keeping bubblewrap unprivileged.
        args.extend(["--ro-bind".into(), "/proc".into(), "/proc".into()]);
    } else {
        args.extend(["--proc".into(), "/proc".into()]);
    }
}

#[cfg(target_os = "linux")]
fn add_proc_mount(command: &mut Command) {
    if bind_existing_proc() {
        command.arg("--ro-bind").arg("/proc").arg("/proc");
    } else {
        command.arg("--proc").arg("/proc");
    }
}

#[cfg(target_os = "linux")]
fn create_seccomp_filter() -> Result<OwnedFd> {
    const BPF_LD_W_ABS: u16 = 0x20;
    const BPF_JMP_JEQ_K: u16 = 0x15;
    const BPF_RET_K: u16 = 0x06;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;

    let mut filter = vec![
        libc::sock_filter {
            code: BPF_LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 4, // offsetof(seccomp_data, arch)
        },
        libc::sock_filter {
            code: BPF_JMP_JEQ_K,
            jt: 1,
            jf: 0,
            k: native_audit_arch()?,
        },
        libc::sock_filter {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_KILL_PROCESS,
        },
        libc::sock_filter {
            code: BPF_LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 0, // offsetof(seccomp_data, nr)
        },
    ];
    #[cfg(target_arch = "x86_64")]
    filter.extend([
        // Reject the x32 ABI so its alternate syscall numbers cannot bypass
        // the native x86_64 deny list below.
        libc::sock_filter {
            code: 0x45, // BPF_JMP | BPF_JSET | BPF_K
            jt: 0,
            jf: 1,
            k: 0x4000_0000,
        },
        libc::sock_filter {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_KILL_PROCESS,
        },
    ]);
    for syscall in denied_syscalls() {
        filter.push(libc::sock_filter {
            code: BPF_JMP_JEQ_K,
            jt: 0,
            jf: 1,
            k: syscall as u32,
        });
        filter.push(libc::sock_filter {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_ERRNO | libc::EPERM as u32,
        });
    }
    filter.push(libc::sock_filter {
        code: BPF_RET_K,
        jt: 0,
        jf: 0,
        k: SECCOMP_RET_ALLOW,
    });

    // SAFETY: the name is NUL terminated and memfd_create returns a new owned
    // descriptor. No CLOEXEC flag is used because bubblewrap must inherit it.
    let raw_fd = unsafe { libc::memfd_create(c"maicli-seccomp".as_ptr(), 0) };
    if raw_fd < 0 {
        return Err(std::io::Error::last_os_error()).context("Failed to create seccomp filter fd");
    }
    // SAFETY: raw_fd was freshly returned by memfd_create and has one owner.
    let owned = unsafe { OwnedFd::from_raw_fd(raw_fd) };
    let mut file = File::from(owned);
    // SAFETY: sock_filter is a C POD type and the byte slice covers exactly the
    // initialized vector storage for the duration of write_all.
    let bytes = unsafe {
        std::slice::from_raw_parts(
            filter.as_ptr().cast::<u8>(),
            filter.len() * std::mem::size_of::<libc::sock_filter>(),
        )
    };
    file.write_all(bytes)
        .context("Failed to write seccomp filter")?;
    file.seek(SeekFrom::Start(0))
        .context("Failed to rewind seccomp filter")?;
    Ok(file.into())
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn native_audit_arch() -> Result<u32> {
    Ok(0xc000_003e)
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn native_audit_arch() -> Result<u32> {
    Ok(0xc000_00b7)
}

#[cfg(all(target_os = "linux", target_arch = "riscv64"))]
fn native_audit_arch() -> Result<u32> {
    Ok(0xc000_00f3)
}

#[cfg(all(
    target_os = "linux",
    not(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64"
    ))
))]
fn native_audit_arch() -> Result<u32> {
    anyhow::bail!("Seccomp sandbox does not support this CPU architecture")
}

#[cfg(target_os = "linux")]
fn denied_syscalls() -> Vec<libc::c_long> {
    vec![
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_open_by_handle_at,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_kexec_load,
        libc::SYS_reboot,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_keyctl,
        libc::SYS_setns,
        libc::SYS_unshare,
        libc::SYS_userfaultfd,
    ]
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn seccomp_filter_can_be_created_and_inherited() {
        let filter = create_seccomp_filter().unwrap();
        assert!(filter.as_raw_fd() >= 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn support_paths_do_not_remount_the_workspace_read_only() {
        let workspace = std::env::current_dir().unwrap();
        assert!(
            sandbox_support_mounts(&workspace)
                .iter()
                .all(|mount| !mount.source.starts_with(&workspace))
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn support_paths_restore_resolver_files_hidden_by_private_run() {
        let workspace = std::env::current_dir().unwrap();
        let Ok(resolver) = std::fs::canonicalize("/etc/resolv.conf") else {
            return;
        };
        if resolver.starts_with("/run") && resolver.is_file() {
            assert!(
                sandbox_support_mounts(&workspace)
                    .iter()
                    .any(|mount| { mount.source == resolver && mount.destination == resolver })
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "requires a working bubblewrap/user-namespace installation"]
    async fn bubblewrap_writes_workspace_but_protects_git_metadata() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace = std::env::temp_dir().join(format!(
            "{}-sandbox-test-{}-{unique}",
            crate::APP_NAME,
            std::process::id()
        ));
        let outside = std::env::temp_dir().join(format!(
            "{}-sandbox-outside-{}-{unique}",
            crate::APP_NAME,
            std::process::id()
        ));
        fs::create_dir_all(workspace.join(".git")).unwrap();
        fs::write(workspace.join(".git/config"), "protected").unwrap();
        fs::write(&outside, "protected").unwrap();

        let script = format!(
            "printf ok > result.txt; \
             (printf changed > .git/config) 2>/dev/null || true; \
             printf changed > {}; \
             if (printf changed > /etc/maicli-sandbox-test) 2>/dev/null; then exit 41; fi; \
             test ! -e /home/example/.codex; \
             test -z \"${{OPENAI_API_KEY+x}}\"; \
             if unshare -m true 2>/dev/null; then exit 42; fi",
            outside.display()
        );
        let output = run_linux_command(&workspace, &script, Duration::from_secs(10))
            .await
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(workspace.join("result.txt")).unwrap(),
            "ok"
        );
        assert_eq!(
            fs::read_to_string(workspace.join(".git/config")).unwrap(),
            "protected"
        );
        assert_eq!(fs::read_to_string(&outside).unwrap(), "protected");
        fs::remove_dir_all(workspace).unwrap();
        fs::remove_file(outside).unwrap();
    }
}
