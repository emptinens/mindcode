use anyhow::{Context, Result};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

#[cfg(unix)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
}

#[cfg(unix)]
impl FileIdentity {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
        }
    }
}

pub struct InstanceLock {
    file: File,
    path: PathBuf,
    #[cfg(unix)]
    identity: FileIdentity,
}

impl InstanceLock {
    pub fn acquire(path: &Path, socket: &Path, build_id: &str) -> Result<Self> {
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let file = options
            .open(path)
            .with_context(|| format!("open instance lock {}", path.display()))?;

        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result != 0 {
                anyhow::bail!("another mindcoded instance owns {}", path.display());
            }
        }

        #[cfg(not(unix))]
        {
            // Windows is outside the daemon's supported target set. The
            // metadata still provides a useful best-effort guard there.
            let mut existing = String::new();
            (&file).read_to_string(&mut existing).ok();
            if !existing.trim().is_empty() {
                anyhow::bail!("another mindcoded instance owns {}", path.display());
            }
        }

        file.set_len(0)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = file.metadata()?.permissions();
            permissions.set_mode(0o600);
            file.set_permissions(permissions)?;
        }
        let mut file = file;
        writeln!(file, "pid={}", std::process::id())?;
        writeln!(file, "socket={}", socket.display())?;
        writeln!(file, "build_id={build_id}")?;
        file.flush()?;
        #[cfg(unix)]
        let identity = FileIdentity::from_metadata(&file.metadata()?);
        Ok(Self {
            file,
            path: path.to_owned(),
            #[cfg(unix)]
            identity,
        })
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
        #[cfg(unix)]
        {
            let remove = std::fs::symlink_metadata(&self.path)
                .map(|metadata| FileIdentity::from_metadata(&metadata) == self.identity)
                .unwrap_or(false);
            if remove {
                let _ = std::fs::remove_file(&self.path);
            }
        }
        #[cfg(not(unix))]
        let _ = std::fs::remove_file(&self.path);
    }
}

#[allow(dead_code)]
fn _metadata_reader(file: &mut File) -> std::io::Result<String> {
    let mut metadata = String::new();
    file.read_to_string(&mut metadata)?;
    Ok(metadata)
}
