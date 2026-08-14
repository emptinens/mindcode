//! On-demand JavaScript runtime resolution (§12.7, AGENTS.md contract).
//!
//! JS plugins and hooks are optional extensions.  The core must not depend on
//! Bun or Node at startup, build time, or runtime, so this module only *locates*
//! a runtime — it never spawns one eagerly.  Resolution is **Bun first, then
//! Node**, and when neither is present the caller fails closed: there is no
//! silent core fallback to a JS engine.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsRuntimeKind {
    Bun,
    Node,
}

impl JsRuntimeKind {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::Node => "node",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsRuntime {
    pub kind: JsRuntimeKind,
    pub path: PathBuf,
}

impl JsRuntime {
    /// Bun-first, then Node.  `None` means no JS runtime is available and the
    /// caller must fail closed rather than degrade to a silent fallback.
    pub fn resolve() -> Option<Self> {
        Self::resolve_from_dirs(&default_search_dirs())
    }

    /// Search the given directories for `bun` and then `node`.  Directories are
    /// checked in order; within one directory `bun` wins over `node` (contract:
    /// resolve Bun first, then Node).
    pub fn resolve_from_dirs(dirs: &[PathBuf]) -> Option<Self> {
        for executable in ["bun", "node"] {
            for dir in dirs {
                let candidate = dir.join(executable);
                if is_executable(&candidate) {
                    let kind = if executable == "bun" {
                        JsRuntimeKind::Bun
                    } else {
                        JsRuntimeKind::Node
                    };
                    return Some(Self {
                        kind,
                        path: candidate,
                    });
                }
            }
        }
        None
    }

    /// Arguments to run one script: `bun <script>` or `node <script>`.
    pub fn args_for_script(&self, script: &Path) -> Vec<String> {
        vec![script.to_string_lossy().into_owned()]
    }

    /// Human-readable, secret-free description of the resolved runtime.
    pub fn describe(&self) -> String {
        format!("{} ({})", self.kind.label(), self.path.display())
    }
}

/// Directories searched by default: `$PATH` plus common Bun/Node install roots.
fn default_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".bun").join("bin"));
        dirs.push(home.join(".nvm").join("current").join("bin"));
        dirs.push(home.join(".local").join("bin"));
    }
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    dirs
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        std::fs::metadata(path)
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn touch_executable(path: &Path) {
        fs::write(path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn empty_search_space_resolves_to_none() {
        assert_eq!(JsRuntime::resolve_from_dirs(&[]), None);
    }

    #[test]
    fn bun_wins_over_node() {
        let dir = std::env::temp_dir().join(format!(
            "mindcode-jsruntime-bun-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        touch_executable(&dir.join("node"));
        touch_executable(&dir.join("bun"));
        let runtime = JsRuntime::resolve_from_dirs(std::slice::from_ref(&dir)).unwrap();
        assert_eq!(runtime.kind, JsRuntimeKind::Bun);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn node_is_used_when_bun_is_absent() {
        let dir = std::env::temp_dir().join(format!(
            "mindcode-jsruntime-node-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        touch_executable(&dir.join("node"));
        let runtime = JsRuntime::resolve_from_dirs(std::slice::from_ref(&dir)).unwrap();
        assert_eq!(runtime.kind, JsRuntimeKind::Node);
        assert!(runtime.describe().contains("node"));
        let _ = fs::remove_dir_all(&dir);
    }
}
