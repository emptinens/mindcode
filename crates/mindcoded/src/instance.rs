use anyhow::{Context, Result};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

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

    /// Adopt the already-locked file descriptor inherited during a daemon
    /// exec handoff. Re-opening the path would contend with our own flock, so
    /// the new image must keep the original open file description.
    #[cfg(unix)]
    pub fn from_inherited_fd(path: &Path, socket: &Path, build_id: &str, fd: i32) -> Result<Self> {
        if fd <= 2 {
            anyhow::bail!("inherited daemon lock fd is invalid");
        }
        // SAFETY: the reload parent transferred ownership of this descriptor
        // through exec; this process adopts it exactly once.
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.seek(SeekFrom::Start(0))?;
        file.set_len(0)?;
        let mut permissions = file.metadata()?.permissions();
        permissions.set_mode(0o600);
        file.set_permissions(permissions)?;
        writeln!(file, "pid={}", std::process::id())?;
        writeln!(file, "socket={}", socket.display())?;
        writeln!(file, "build_id={build_id}")?;
        file.flush()?;
        let identity = FileIdentity::from_metadata(&file.metadata()?);
        Ok(Self {
            file,
            path: path.to_owned(),
            identity,
        })
    }

    #[cfg(unix)]
    pub fn raw_fd(&self) -> i32 {
        self.file.as_raw_fd()
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
