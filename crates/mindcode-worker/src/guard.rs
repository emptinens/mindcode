//! The ownership guard: tier-aware boundary + deny-list enforcement for
//! every worker tool call (§10.4.2). The credential store is unreachable on
//! every tier; `.git`/`target`/`dist` and the config home are write-protected
//! outside `FullAccess`.

use crate::permission::PermissionTier;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolAccess {
    /// The action may run without asking.
    Allowed,
    /// The action must be approved by the user first.
    NeedsApproval,
    /// The action is hard-denied and must not even be offered.
    Denied,
}

/// Tier + workspace + config-home boundary checks. The workspace root is the
/// directory `mindcode` was launched from.
pub struct OwnershipGuard {
    workspace_root: PathBuf,
    config_home: PathBuf,
    tier: PermissionTier,
}

impl OwnershipGuard {
    /// Build a guard around a canonicalized workspace root and config home.
    /// Non-canonicalizable inputs fail closed.
    pub fn new(
        workspace_root: PathBuf,
        config_home: PathBuf,
        tier: PermissionTier,
    ) -> Result<Self, String> {
        let workspace_root = std::fs::canonicalize(&workspace_root)
            .map_err(|_| "workspace root is not a readable directory".to_owned())?;
        let config_home = std::fs::canonicalize(&config_home)
            .map_err(|_| "config home is not a readable directory".to_owned())?;
        Ok(Self {
            workspace_root,
            config_home,
            tier,
        })
    }

    pub fn tier(&self) -> PermissionTier {
        self.tier
    }

    pub fn set_tier(&mut self, tier: PermissionTier) {
        self.tier = tier;
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn config_home(&self) -> &Path {
        &self.config_home
    }

    /// Canonicalize a path that may not exist yet by resolving its deepest
    /// existing ancestor and re-appending the missing tail. Returns `None`
    /// when the path has no resolvable ancestor.
    pub fn canonicalize(&self, path: &Path) -> Option<PathBuf> {
        let mut missing: Vec<&OsStr> = Vec::new();
        let mut cursor = path;
        loop {
            if let Ok(canonical) = std::fs::canonicalize(cursor) {
                let mut out = canonical;
                for segment in missing.iter().rev() {
                    out.push(segment);
                }
                return Some(out);
            }
            missing.push(cursor.file_name()?);
            cursor = cursor.parent()?;
        }
    }

    /// Decide access for a read against an absolute path.
    pub fn check_read(&self, path: &Path) -> ToolAccess {
        self.check(path, false)
    }

    /// Decide access for a write against an absolute path.
    pub fn check_write(&self, path: &Path) -> ToolAccess {
        self.check(path, true)
    }

    /// Decide access for a canonicalized absolute path.
    pub fn check_canonical(&self, canonical: &Path, write: bool) -> ToolAccess {
        if self.is_secret(canonical) {
            return ToolAccess::Denied;
        }
        if write && self.tier != PermissionTier::FullAccess && self.is_write_protected(canonical) {
            return ToolAccess::Denied;
        }
        let in_workspace = canonical.starts_with(&self.workspace_root);
        match self.tier {
            PermissionTier::AskEverything => ToolAccess::NeedsApproval,
            PermissionTier::Workspace => {
                if in_workspace {
                    ToolAccess::Allowed
                } else {
                    ToolAccess::NeedsApproval
                }
            }
            PermissionTier::FullAccess => ToolAccess::Allowed,
        }
    }

    /// Decide access for a command-based tool (shell/git/rg): only
    /// `ask-everything` gates these; path sandboxing for the shell is
    /// contract-level in v1 (§10.4.8).
    pub fn check_command(&self) -> ToolAccess {
        match self.tier {
            PermissionTier::AskEverything => ToolAccess::NeedsApproval,
            PermissionTier::Workspace | PermissionTier::FullAccess => ToolAccess::Allowed,
        }
    }

    fn check(&self, path: &Path, write: bool) -> ToolAccess {
        match self.canonicalize(path) {
            Some(canonical) => self.check_canonical(&canonical, write),
            None => ToolAccess::Denied,
        }
    }

    /// Credential-shaped content is unreachable on every tier.
    fn is_secret(&self, path: &Path) -> bool {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let credential_file =
            path.starts_with(&self.config_home) && name.starts_with("credentials.json");
        credential_file
            || name == ".env"
            || name.starts_with(".env.")
            || name.ends_with(".key")
            || name.ends_with(".pem")
            || name.ends_with(".crt")
    }

    /// Everything in the config home and the build/VCS dirs is write-protected
    /// outside `FullAccess`.
    fn is_write_protected(&self, path: &Path) -> bool {
        if self.is_secret(path) || path.starts_with(&self.config_home) {
            return true;
        }
        path.components().any(|component| match component {
            Component::Normal(name) => name == ".git" || name == "target" || name == "dist",
            _ => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard(tier: PermissionTier) -> (tempfile::TempDir, tempfile::TempDir, OwnershipGuard) {
        let workspace = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let guard = OwnershipGuard::new(
            workspace.path().to_path_buf(),
            config.path().to_path_buf(),
            tier,
        )
        .unwrap();
        (workspace, config, guard)
    }

    #[test]
    fn ask_everything_prompts_for_everything_except_secrets() {
        let (workspace, config, guard) = guard(PermissionTier::AskEverything);
        std::fs::write(workspace.path().join("a.txt"), "x").unwrap();
        assert_eq!(
            guard.check_read(&workspace.path().join("a.txt")),
            ToolAccess::NeedsApproval
        );
        assert_eq!(
            guard.check_write(&workspace.path().join("new.txt")),
            ToolAccess::NeedsApproval
        );
        // Secrets are denied outright, never merely prompted.
        std::fs::write(config.path().join("credentials.json"), "{}").unwrap();
        assert_eq!(
            guard.check_read(&config.path().join("credentials.json")),
            ToolAccess::Denied
        );
    }

    #[test]
    fn workspace_tier_allows_inside_and_prompts_outside() {
        let (workspace, _config, guard) = guard(PermissionTier::Workspace);
        std::fs::write(workspace.path().join("a.txt"), "x").unwrap();
        assert_eq!(
            guard.check_read(&workspace.path().join("a.txt")),
            ToolAccess::Allowed
        );
        assert_eq!(
            guard.check_write(&workspace.path().join("b.txt")),
            ToolAccess::Allowed
        );
        // Outside the launch folder -> prompt.
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("c.txt"), "x").unwrap();
        assert_eq!(
            guard.check_read(&outside.path().join("c.txt")),
            ToolAccess::NeedsApproval
        );
    }

    #[test]
    fn full_access_allows_everything_but_credentials() {
        let (_workspace, config, guard) = guard(PermissionTier::FullAccess);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("c.txt"), "x").unwrap();
        assert_eq!(
            guard.check_read(&outside.path().join("c.txt")),
            ToolAccess::Allowed
        );
        assert_eq!(
            guard.check_write(&outside.path().join("new.txt")),
            ToolAccess::Allowed
        );
        std::fs::write(config.path().join("credentials.json"), "{}").unwrap();
        assert_eq!(
            guard.check_read(&config.path().join("credentials.json")),
            ToolAccess::Denied
        );
        assert_eq!(
            guard.check_write(&config.path().join("credentials.json")),
            ToolAccess::Denied
        );
    }

    #[test]
    fn write_protected_dirs_are_denied_outside_full_access() {
        let (workspace, _config, guard) = guard(PermissionTier::Workspace);
        std::fs::create_dir_all(workspace.path().join(".git")).unwrap();
        std::fs::create_dir_all(workspace.path().join("target")).unwrap();
        assert_eq!(
            guard.check_write(&workspace.path().join(".git/config")),
            ToolAccess::Denied
        );
        assert_eq!(
            guard.check_write(&workspace.path().join("target/out")),
            ToolAccess::Denied
        );
        // Reads of non-secret build/VCS files stay tier-governed.
        std::fs::write(workspace.path().join(".git/config"), "x").unwrap();
        assert_eq!(
            guard.check_read(&workspace.path().join(".git/config")),
            ToolAccess::Allowed
        );
    }

    #[test]
    fn full_access_relaxes_write_protection() {
        let (workspace, _config, guard) = guard(PermissionTier::FullAccess);
        std::fs::create_dir_all(workspace.path().join("target")).unwrap();
        assert_eq!(
            guard.check_write(&workspace.path().join("target/out")),
            ToolAccess::Allowed
        );
    }

    #[test]
    fn secret_shaped_filenames_are_denied_everywhere() {
        let (workspace, _config, guard) = guard(PermissionTier::FullAccess);
        std::fs::write(workspace.path().join(".env"), "x").unwrap();
        std::fs::write(workspace.path().join("key.pem"), "x").unwrap();
        assert_eq!(
            guard.check_read(&workspace.path().join(".env")),
            ToolAccess::Denied
        );
        assert_eq!(
            guard.check_read(&workspace.path().join("key.pem")),
            ToolAccess::Denied
        );
    }

    #[test]
    fn command_tools_gate_only_on_ask_everything() {
        let (_w, _c, g) = guard(PermissionTier::AskEverything);
        assert_eq!(g.check_command(), ToolAccess::NeedsApproval);
        let (_w, _c, g) = guard(PermissionTier::Workspace);
        assert_eq!(g.check_command(), ToolAccess::Allowed);
        let (_w, _c, g) = guard(PermissionTier::FullAccess);
        assert_eq!(g.check_command(), ToolAccess::Allowed);
    }

    #[test]
    fn canonicalize_resolves_missing_tails() {
        let (workspace, _config, guard) = guard(PermissionTier::Workspace);
        std::fs::create_dir_all(workspace.path().join("a")).unwrap();
        let resolved = guard
            .canonicalize(&workspace.path().join("a/b/c.txt"))
            .unwrap();
        assert_eq!(
            resolved,
            workspace.path().canonicalize().unwrap().join("a/b/c.txt")
        );
    }
}
