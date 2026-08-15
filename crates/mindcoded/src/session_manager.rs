//! Long-lived daemon session lifecycle for the 0.1.5 convergence slice.
//!
//! `SessionIndex` owns durable metadata; this module owns only live leases and
//! connection presence. A client can reconnect with a new connection id,
//! resume the same session, and explicitly close its lease. Stale leases are
//! reaped from a bounded in-memory registry so a client disappearing without a
//! close frame cannot pin a session forever.

use mindcode_state::session_index::{
    MAX_SESSION_FIRST_PROMPT_BYTES, MAX_SESSION_ID_BYTES, MAX_SESSION_PROJECT_PATH_BYTES,
    MAX_SESSION_TITLE_BYTES, MAX_SESSION_TRANSCRIPT_PATH_BYTES,
};
use mindcode_state::{SessionIndex, SessionRecord, StateError, StateResult, JS_MAX_SAFE_INTEGER};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_ACTIVE_SESSIONS: usize = 256;
pub const MAX_LEASES_PER_SESSION: usize = 32;
pub const DEFAULT_LEASE_IDLE_MS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Clone)]
pub struct OpenSessionInput {
    pub session_id: String,
    pub connection_id: String,
    pub project_path: String,
    pub transcript_path: String,
    pub size_bytes: u64,
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub now_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ManagedSession {
    pub session_id: String,
    pub project_path: String,
    pub created_at_ms: u64,
    pub last_seen_at_ms: u64,
    pub active_leases: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionHandle {
    pub session: ManagedSession,
    pub lease_id: String,
    pub resumed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionCloseResult {
    pub session_id: String,
    pub closed: bool,
    pub session: Option<ManagedSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionManagerStatus {
    pub active_sessions: usize,
    pub sessions: Vec<ManagedSession>,
}

#[derive(Debug)]
struct ActiveSession {
    session_id: String,
    project_path: String,
    created_at_ms: u64,
    last_seen_at_ms: u64,
    leases: BTreeMap<String, Lease>,
}

#[derive(Debug)]
struct Lease {
    connection_id: String,
    last_seen_at_ms: u64,
}

#[derive(Debug, Default)]
struct SessionRegistry {
    sessions: BTreeMap<String, ActiveSession>,
    next_lease_id: u64,
}

#[derive(Debug)]
pub struct SessionManager {
    index: Arc<SessionIndex>,
    registry: Mutex<SessionRegistry>,
}

impl SessionManager {
    pub fn new(index: Arc<SessionIndex>) -> Self {
        Self {
            index,
            registry: Mutex::new(SessionRegistry::default()),
        }
    }

    /// Open or reconnect one logical session. Repeating the same
    /// `(session_id, connection_id)` pair is idempotent and returns the same
    /// lease instead of inflating the live-session count.
    pub fn open(&self, input: OpenSessionInput) -> StateResult<SessionHandle> {
        validate_open_input(&input)?;
        let now_ms = input.now_ms.unwrap_or_else(unix_time_ms);
        validate_timestamp(now_ms, "now_ms")?;

        let mut registry = self
            .registry
            .lock()
            .map_err(|_| StateError::InvalidSession("session registry poisoned".into()))?;
        let existing = self.index.get(&input.session_id)?;
        if let Some(record) = &existing {
            if record.project_path != input.project_path {
                return Err(StateError::InvalidSession(format!(
                    "session {} belongs to a different project",
                    input.session_id
                )));
            }
        }
        if let Some(active) = registry.sessions.get(&input.session_id) {
            if active.project_path != input.project_path {
                return Err(StateError::InvalidSession(format!(
                    "session {} belongs to a different project",
                    input.session_id
                )));
            }
        } else if registry.sessions.len() >= MAX_ACTIVE_SESSIONS {
            return Err(StateError::InvalidSession(format!(
                "active session limit reached ({MAX_ACTIVE_SESSIONS})"
            )));
        }
        let existing_lease_id = registry.sessions.get(&input.session_id).and_then(|active| {
            active
                .leases
                .iter()
                .find(|(_, lease)| lease.connection_id == input.connection_id)
                .map(|(lease_id, _)| lease_id.clone())
        });
        if let Some(active) = registry.sessions.get(&input.session_id) {
            if active.leases.len() >= MAX_LEASES_PER_SESSION && existing_lease_id.is_none() {
                return Err(StateError::InvalidSession(format!(
                    "session lease limit reached ({MAX_LEASES_PER_SESSION})"
                )));
            }
        }
        let lease_id = existing_lease_id
            .clone()
            .unwrap_or_else(|| next_lease_id(&mut registry));

        let record = SessionRecord {
            session_id: input.session_id.clone(),
            project_path: input.project_path.clone(),
            transcript_path: input.transcript_path,
            modified_at_ms: now_ms,
            size_bytes: input.size_bytes,
            title: input.title,
            first_prompt: input.first_prompt,
        };
        // Persist metadata before mutating the live registry. A failed SQLite
        // write therefore cannot leave a lease that has no durable session.
        self.index.upsert(record)?;

        let active = match registry.sessions.entry(input.session_id.clone()) {
            std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::btree_map::Entry::Vacant(entry) => entry.insert(ActiveSession {
                session_id: input.session_id.clone(),
                project_path: input.project_path.clone(),
                created_at_ms: existing
                    .as_ref()
                    .map(|record| record.modified_at_ms)
                    .unwrap_or(now_ms),
                last_seen_at_ms: now_ms,
                leases: BTreeMap::new(),
            }),
        };

        let resumed = existing_lease_id.is_some();
        active.leases.insert(
            lease_id.clone(),
            Lease {
                connection_id: input.connection_id,
                last_seen_at_ms: now_ms,
            },
        );
        active.last_seen_at_ms = active.last_seen_at_ms.max(now_ms);

        Ok(SessionHandle {
            session: view(active),
            lease_id,
            resumed,
        })
    }

    pub fn touch(
        &self,
        session_id: &str,
        lease_id: &str,
        now_ms: Option<u64>,
    ) -> StateResult<ManagedSession> {
        let now_ms = now_ms.unwrap_or_else(unix_time_ms);
        validate_timestamp(now_ms, "now_ms")?;
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| StateError::InvalidSession("session registry poisoned".into()))?;
        let active = registry
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| StateError::InvalidSession(format!("unknown session: {session_id}")))?;
        let lease = active.leases.get_mut(lease_id).ok_or_else(|| {
            StateError::LeaseOwnerMismatch(format!("unknown session lease: {lease_id}"))
        })?;
        lease.last_seen_at_ms = now_ms;
        active.last_seen_at_ms = active.last_seen_at_ms.max(now_ms);
        Ok(view(active))
    }

    pub fn close(&self, session_id: &str, lease_id: &str) -> StateResult<SessionCloseResult> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| StateError::InvalidSession("session registry poisoned".into()))?;
        let Some(active) = registry.sessions.get_mut(session_id) else {
            return Ok(SessionCloseResult {
                session_id: session_id.to_owned(),
                closed: false,
                session: None,
            });
        };
        if active.leases.remove(lease_id).is_none() {
            return Err(StateError::LeaseOwnerMismatch(format!(
                "unknown session lease: {lease_id}"
            )));
        }
        let session = if active.leases.is_empty() {
            registry.sessions.remove(session_id);
            None
        } else {
            Some(view(active))
        };
        Ok(SessionCloseResult {
            session_id: session_id.to_owned(),
            closed: true,
            session,
        })
    }

    /// Remove leases that have not heartbeated inside `idle_ms` and return the
    /// number of leases reclaimed. This is deterministic when the caller
    /// supplies `now_ms`, which makes reconnect tests race-free.
    pub fn reap_expired(&self, now_ms: u64, idle_ms: u64) -> StateResult<usize> {
        validate_timestamp(now_ms, "now_ms")?;
        if !(1_000..=24 * 60 * 60 * 1_000).contains(&idle_ms) {
            return Err(StateError::InvalidSession(
                "lease idle timeout must be between 1000 and 86400000 ms".into(),
            ));
        }
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| StateError::InvalidSession("session registry poisoned".into()))?;
        let mut reclaimed = 0;
        let mut empty_sessions = Vec::new();
        for (session_id, active) in &mut registry.sessions {
            active.leases.retain(|_, lease| {
                let keep = now_ms.saturating_sub(lease.last_seen_at_ms) < idle_ms;
                if !keep {
                    reclaimed += 1;
                }
                keep
            });
            if active.leases.is_empty() {
                empty_sessions.push(session_id.clone());
            } else {
                active.last_seen_at_ms = active
                    .leases
                    .values()
                    .map(|lease| lease.last_seen_at_ms)
                    .max()
                    .unwrap_or(active.last_seen_at_ms);
            }
        }
        for session_id in empty_sessions {
            registry.sessions.remove(&session_id);
        }
        Ok(reclaimed)
    }

    pub fn status(&self) -> StateResult<SessionManagerStatus> {
        self.status_at(unix_time_ms())
    }

    pub fn status_at(&self, now_ms: u64) -> StateResult<SessionManagerStatus> {
        self.reap_expired(now_ms, DEFAULT_LEASE_IDLE_MS)?;
        let registry = self
            .registry
            .lock()
            .map_err(|_| StateError::InvalidSession("session registry poisoned".into()))?;
        let sessions = registry.sessions.values().map(view).collect::<Vec<_>>();
        Ok(SessionManagerStatus {
            active_sessions: sessions.len(),
            sessions,
        })
    }

    pub fn active_count(&self) -> usize {
        self.registry
            .lock()
            .map(|registry| registry.sessions.len())
            .unwrap_or(0)
    }
}

fn next_lease_id(registry: &mut SessionRegistry) -> String {
    loop {
        registry.next_lease_id = registry.next_lease_id.wrapping_add(1).max(1);
        let candidate = format!("lease-{}", registry.next_lease_id);
        if !registry
            .sessions
            .values()
            .any(|session| session.leases.contains_key(&candidate))
        {
            return candidate;
        }
    }
}

fn view(active: &ActiveSession) -> ManagedSession {
    ManagedSession {
        session_id: active.session_id.clone(),
        project_path: active.project_path.clone(),
        created_at_ms: active.created_at_ms,
        last_seen_at_ms: active.last_seen_at_ms,
        active_leases: active.leases.len(),
    }
}

fn validate_open_input(input: &OpenSessionInput) -> StateResult<()> {
    validate_path_safe(&input.session_id, "session_id", MAX_SESSION_ID_BYTES)?;
    validate_nonempty_bounded(&input.connection_id, "connection_id", MAX_SESSION_ID_BYTES)?;
    validate_nonempty_bounded(
        &input.project_path,
        "project_path",
        MAX_SESSION_PROJECT_PATH_BYTES,
    )?;
    validate_nonempty_bounded(
        &input.transcript_path,
        "transcript_path",
        MAX_SESSION_TRANSCRIPT_PATH_BYTES,
    )?;
    validate_optional_bounded(input.title.as_deref(), "title", MAX_SESSION_TITLE_BYTES)?;
    validate_optional_bounded(
        input.first_prompt.as_deref(),
        "first_prompt",
        MAX_SESSION_FIRST_PROMPT_BYTES,
    )?;
    validate_timestamp(input.size_bytes, "size_bytes")?;
    Ok(())
}

fn validate_path_safe(value: &str, field: &str, max_bytes: usize) -> StateResult<()> {
    validate_nonempty_bounded(value, field, max_bytes)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(StateError::InvalidSession(format!(
            "{field} contains an unsafe character"
        )));
    }
    Ok(())
}

fn validate_nonempty_bounded(value: &str, field: &str, max_bytes: usize) -> StateResult<()> {
    if value.is_empty() {
        return Err(StateError::InvalidSession(format!(
            "{field} must not be empty"
        )));
    }
    if value.len() > max_bytes {
        return Err(StateError::InvalidSession(format!(
            "{field} exceeds maximum length of {max_bytes} bytes"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(StateError::InvalidSession(format!(
            "{field} must not contain control characters"
        )));
    }
    Ok(())
}

fn validate_optional_bounded(
    value: Option<&str>,
    field: &str,
    max_bytes: usize,
) -> StateResult<()> {
    if let Some(value) = value {
        if value.len() > max_bytes || value.chars().any(char::is_control) {
            return Err(StateError::InvalidSession(format!(
                "{field} exceeds its safe size"
            )));
        }
    }
    Ok(())
}

fn validate_timestamp(value: u64, field: &str) -> StateResult<()> {
    if value > JS_MAX_SAFE_INTEGER {
        return Err(StateError::InvalidSession(format!(
            "{field} must be a JavaScript-safe integer"
        )));
    }
    Ok(())
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn manager() -> SessionManager {
        let directory = tempdir().unwrap();
        // Leak only the test tempdir so the manager can outlive the local
        // helper; the process cleans its test directory on exit.
        let path = Box::leak(Box::new(directory));
        let index = Arc::new(
            SessionIndex::open(mindcode_state::SessionIndexConfig::with_state_dir(
                path.path().join("state"),
            ))
            .unwrap(),
        );
        SessionManager::new(index)
    }

    fn input(connection_id: &str, now_ms: u64) -> OpenSessionInput {
        OpenSessionInput {
            session_id: "session-a".into(),
            connection_id: connection_id.into(),
            project_path: "/project".into(),
            transcript_path: "/project/session-a.json".into(),
            size_bytes: 0,
            title: Some("Build".into()),
            first_prompt: Some("compile".into()),
            now_ms: Some(now_ms),
        }
    }

    #[test]
    fn repeated_connection_open_is_idempotent_and_reconnect_adds_a_lease() {
        let manager = manager();
        let first = manager.open(input("connection-1", 100)).unwrap();
        let repeated = manager.open(input("connection-1", 200)).unwrap();
        assert_eq!(repeated.lease_id, first.lease_id);
        assert!(repeated.resumed);
        assert_eq!(repeated.session.active_leases, 1);

        let reconnect = manager.open(input("connection-2", 300)).unwrap();
        assert!(!reconnect.resumed);
        assert_eq!(reconnect.session.active_leases, 2);
        assert_eq!(manager.active_count(), 1);
    }

    #[test]
    fn close_and_reap_release_only_their_own_leases() {
        let manager = manager();
        let first = manager.open(input("connection-1", 100)).unwrap();
        let second = manager.open(input("connection-2", 100)).unwrap();
        let closed = manager.close("session-a", &first.lease_id).unwrap();
        assert!(closed.closed);
        assert_eq!(closed.session.unwrap().active_leases, 1);
        assert_eq!(manager.reap_expired(1_200, 1_000).unwrap(), 1);
        assert_eq!(manager.active_count(), 0);
        assert!(!manager.close("session-a", &second.lease_id).unwrap().closed);
    }

    #[test]
    fn project_switch_and_unsafe_ids_fail_closed() {
        let manager = manager();
        let mut request = input("connection-1", 100);
        request.session_id = "../escape".into();
        assert!(matches!(
            manager.open(request),
            Err(StateError::InvalidSession(_))
        ));
        let mut request = input("connection-1", 100);
        request.session_id = "session-b".into();
        request.project_path = "/other".into();
        manager.open(request).unwrap();
        let mut reconnect = input("connection-2", 200);
        reconnect.session_id = "session-b".into();
        reconnect.project_path = "/different".into();
        assert!(matches!(
            manager.open(reconnect),
            Err(StateError::InvalidSession(_))
        ));
    }
}
