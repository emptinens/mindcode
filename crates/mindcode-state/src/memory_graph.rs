//! Semantic memory graph (§12.2).
//!
//! A human-readable, disableable memory store. Records carry a
//! `memory_type`, `scope`, provenance, and a confidence that decays with a
//! type-specific half-life; retrieval is cosine similarity over an embedder
//! trait. The default embedder is a deterministic hashing fallback (no ONNX, no
//! runtime RAM beyond the records themselves); a real all-MiniLM-L6-v2
//! embedder can be plugged in behind the same trait when the feature is
//! enabled. Credential-shaped text never enters the graph.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::Path;

/// Maximum size of a memory-graph file accepted by the loader.
const MAX_MEMORY_FILE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryType {
    Fact,
    Preference,
    Procedure,
    Correction,
    Negative,
}

impl MemoryType {
    pub const ALL: [Self; 5] = [
        Self::Fact,
        Self::Preference,
        Self::Procedure,
        Self::Correction,
        Self::Negative,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Preference => "preference",
            Self::Procedure => "procedure",
            Self::Correction => "correction",
            Self::Negative => "negative",
        }
    }

    /// Confidence half-life in days (§12.2): corrections and negative feedback
    /// fade faster than stable facts and preferences.
    pub const fn half_life_days(self) -> f64 {
        match self {
            Self::Fact => 90.0,
            Self::Preference => 180.0,
            Self::Procedure => 60.0,
            Self::Correction => 30.0,
            Self::Negative => 14.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryScope {
    Global,
    Project,
    Session,
    /// Shared team/repository graph (§14.4): local shared files, not a server
    /// account (no OAuth/logins).
    Team,
}

impl MemoryScope {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
            Self::Session => "session",
            Self::Team => "team",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: String,
    pub memory_type: MemoryType,
    pub scope: MemoryScope,
    pub text: String,
    pub provenance: String,
    pub created_at_ms: u64,
    pub reinforced_at_ms: u64,
    pub reinforcement: u32,
    pub confidence: f64,
    /// Per-user private record (§14.4): never exported into a shared team
    /// graph. Defaults to `false` (shareable).
    #[serde(default)]
    pub private: bool,
}

impl MemoryRecord {
    /// Effective confidence after half-life decay and reinforcement bonus.
    pub fn effective_confidence(&self, now_ms: u64) -> f64 {
        let age_days = now_ms.saturating_sub(self.reinforced_at_ms) as f64 / 86_400_000.0;
        let decay = 0.5_f64.powf(age_days / self.memory_type.half_life_days());
        let reinforcement_bonus = 1.0 + 0.1 * (self.reinforcement as f64).min(10.0);
        (self.confidence * decay * reinforcement_bonus).clamp(0.0, 1.0)
    }
}

/// An embedding provider.  The production embedder (all-MiniLM-L6-v2 via
/// tract-ONNX) implements this; the hashing fallback keeps the feature usable
/// (and testable) without ONNX or the ~140 MB of model RAM.
pub trait Embedder {
    fn embed(&self, text: &str) -> Vec<f32>;
}

/// Deterministic hashing embedder: a bag-of-character-ngram FNV hash projected
/// into a fixed dimension, L2-normalized.  Deterministic across runs, tiny, and
/// good enough to rank related short texts above unrelated ones.
pub struct HashingEmbedder {
    dimensions: usize,
}

impl HashingEmbedder {
    pub fn new(dimensions: usize) -> Self {
        Self {
            dimensions: dimensions.max(16),
        }
    }
}

impl Default for HashingEmbedder {
    fn default() -> Self {
        Self::new(64)
    }
}

impl Embedder for HashingEmbedder {
    fn embed(&self, text: &str) -> Vec<f32> {
        let mut vector = vec![0.0_f32; self.dimensions];
        let normalized: String = text
            .to_lowercase()
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        let bytes = normalized.as_bytes();
        if bytes.is_empty() {
            return vector;
        }
        for n in [2usize, 3] {
            for window in bytes.windows(n) {
                let hash = fnv1a(window);
                let slot = (hash % self.dimensions as u64) as usize;
                vector[slot] += 1.0;
            }
        }
        let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm > 0.0 {
            for value in &mut vector {
                *value /= norm;
            }
        }
        vector
    }
}

pub(crate) fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn cosine(left: &[f32], right: &[f32]) -> f32 {
    let length = left.len().min(right.len());
    if length == 0 {
        return 0.0;
    }
    let mut dot = 0.0;
    for index in 0..length {
        dot += left[index] * right[index];
    }
    // Both vectors are unit-normalized by the embedder, but clamping keeps the
    // score bounded even for an external embedder that does not normalize.
    dot.clamp(-1.0, 1.0)
}

pub struct MemoryStore {
    records: Vec<MemoryRecord>,
    enabled: bool,
    embedder: Box<dyn Embedder + Send + Sync>,
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self {
            records: Vec::new(),
            enabled: true,
            embedder: Box::new(HashingEmbedder::default()),
        }
    }
}

impl MemoryStore {
    /// A disabled store keeps no records and performs no embedding work.
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            ..Self::default()
        }
    }

    pub fn with_embedder(embedder: Box<dyn Embedder + Send + Sync>) -> Self {
        Self {
            embedder,
            ..Self::default()
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Insert a record, refusing credential-shaped text (§12.2 privacy).  When
    /// disabled this is a no-op and returns `false`.
    pub fn insert(&mut self, record: MemoryRecord) -> Result<bool, MemoryError> {
        if !self.enabled {
            return Ok(false);
        }
        if record.confidence < 0.0 || record.confidence > 1.0 {
            return Err(MemoryError::InvalidConfidence);
        }
        if record.text.trim().is_empty() {
            return Err(MemoryError::EmptyText);
        }
        if contains_credential_shaped(&record.text) {
            return Err(MemoryError::CredentialShaped);
        }
        self.records.retain(|existing| existing.id != record.id);
        self.records.push(record);
        Ok(true)
    }

    /// Reinforce an existing memory (breadcrumb): bumps reinforcement and
    /// refreshes `reinforced_at_ms`.
    pub fn reinforce(&mut self, id: &str, now_ms: u64) -> bool {
        let Some(record) = self.records.iter_mut().find(|record| record.id == id) else {
            return false;
        };
        record.reinforcement = record.reinforcement.saturating_add(1);
        record.reinforced_at_ms = now_ms;
        true
    }

    /// Look up one record by id.
    pub fn get(&self, id: &str) -> Option<&MemoryRecord> {
        self.records.iter().find(|record| record.id == id)
    }

    /// Mark a record per-user private (§14.4): it stays in this store but is
    /// excluded from every team merge/export.
    pub fn mark_private(&mut self, id: &str) -> bool {
        let Some(record) = self.records.iter_mut().find(|record| record.id == id) else {
            return false;
        };
        record.private = true;
        true
    }

    /// Cosine-ranked retrieval with a relevance floor (the deterministic stand-in
    /// for the sidecar-LLM filter; the sidecar can raise the floor at runtime).
    pub fn search(&self, query: &str, limit: usize, min_score: f32) -> Vec<(MemoryRecord, f32)> {
        if !self.enabled {
            return Vec::new();
        }
        let query_embedding = self.embedder.embed(query);
        let mut scored: Vec<(MemoryRecord, f32)> = self
            .records
            .iter()
            .map(|record| {
                let score = cosine(&query_embedding, &self.embedder.embed(&record.text));
                (record.clone(), score)
            })
            .filter(|(_, score)| *score >= min_score)
            .collect();
        scored.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        scored
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(&self.records)
    }

    pub fn from_json(json: &str) -> Result<Self, MemoryError> {
        let records: Vec<MemoryRecord> =
            serde_json::from_str(json).map_err(|error| MemoryError::Json(error.to_string()))?;
        let mut store = Self::default();
        for record in records {
            store
                .insert(record)
                .map_err(|_| MemoryError::Json("invalid stored record".to_owned()))?;
        }
        Ok(store)
    }

    /// Persist the graph as human-readable JSON (§14.1: survives restart).
    pub fn save_to_file(&self, path: &Path) -> Result<(), MemoryError> {
        let json = self
            .to_json()
            .map_err(|error| MemoryError::Json(error.to_string()))?;
        std::fs::write(path, json).map_err(|error| MemoryError::Io(error.to_string()))
    }

    /// Load a persisted graph with a size bound; missing files are an error
    /// (callers decide whether that means "empty").
    pub fn load_from_file(path: &Path) -> Result<Self, MemoryError> {
        let metadata =
            std::fs::metadata(path).map_err(|error| MemoryError::Io(error.to_string()))?;
        if metadata.len() > MAX_MEMORY_FILE_BYTES {
            return Err(MemoryError::Oversized);
        }
        let raw =
            std::fs::read_to_string(path).map_err(|error| MemoryError::Io(error.to_string()))?;
        Self::from_json(&raw)
    }

    /// Drop records whose effective confidence has decayed below
    /// `min_confidence` (§14.1 decay).  Returns the number dropped.
    pub fn prune(&mut self, now_ms: u64, min_confidence: f64) -> usize {
        let before = self.records.len();
        self.records
            .retain(|record| record.effective_confidence(now_ms) >= min_confidence);
        before - self.records.len()
    }

    /// Merge another store's records, resolving same-id conflicts (§14.1): a
    /// `Correction` supersedes a `Fact`, which supersedes the rest; a tie is
    /// broken by the newer `reinforced_at_ms`.  Returns the number of records
    /// newly added.
    pub fn merge(&mut self, other: &MemoryStore) -> usize {
        self.merge_filtered(other, true)
    }

    /// Merge only shareable records (§14.4): per-user private records are never
    /// pulled into a shared team graph.
    pub fn merge_shared(&mut self, other: &MemoryStore) -> usize {
        self.merge_filtered(other, false)
    }

    fn merge_filtered(&mut self, other: &MemoryStore, include_private: bool) -> usize {
        let mut added = 0;
        for record in &other.records {
            if !include_private && record.private {
                continue;
            }
            match self
                .records
                .iter_mut()
                .find(|existing| existing.id == record.id)
            {
                Some(existing) => {
                    let existing_priority = type_priority(existing.memory_type);
                    let incoming_priority = type_priority(record.memory_type);
                    if incoming_priority > existing_priority
                        || (incoming_priority == existing_priority
                            && record.reinforced_at_ms > existing.reinforced_at_ms)
                    {
                        *existing = record.clone();
                    }
                }
                None => {
                    if self.enabled && !contains_credential_shaped(&record.text) {
                        self.records.push(record.clone());
                        added += 1;
                    }
                }
            }
        }
        added
    }
}

/// Conflict precedence for merge (§14.1): Correction > Fact > the rest.
fn type_priority(memory_type: MemoryType) -> u8 {
    match memory_type {
        MemoryType::Correction => 3,
        MemoryType::Fact => 2,
        MemoryType::Preference | MemoryType::Procedure | MemoryType::Negative => 1,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryError {
    InvalidConfidence,
    EmptyText,
    CredentialShaped,
    Json(String),
    Io(String),
    Oversized,
}

impl fmt::Display for MemoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfidence => formatter.write_str("confidence must be in 0.0..=1.0"),
            Self::EmptyText => formatter.write_str("memory text must not be empty"),
            Self::CredentialShaped => {
                formatter.write_str("credential-shaped text is never stored in memory")
            }
            Self::Json(message) => write!(formatter, "memory JSON error: {message}"),
            Self::Io(message) => write!(formatter, "memory I/O error: {message}"),
            Self::Oversized => formatter.write_str("memory graph file exceeds the size limit"),
        }
    }
}

impl std::error::Error for MemoryError {}

/// Credential-shaped text detection (§12.2 privacy): catches `sk-` keys,
/// bearer tokens, `key = value` secrets, and long high-entropy tokens.  Also
/// skips `.env`/`.gitignore`d paths by convention (callers skip those files
/// before reading, this is the value-level backstop).
pub fn contains_credential_shaped(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.contains("sk-") || lower.contains("bearer ") {
        return true;
    }
    for key in ["api_key", "apikey", "api-key", "secret", "password", "credential", "authorization", "token"] {
        if lower.contains(key) {
            return true;
        }
    }
    // Long high-entropy tokens (base64-ish).
    for token in text.split(|character: char| {
        !(character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=' | '_' | '-'))
    }) {
        if token.len() >= 24 {
            let has_upper = token.bytes().any(|byte| byte.is_ascii_uppercase());
            let has_lower = token.bytes().any(|byte| byte.is_ascii_lowercase());
            let has_digit = token.bytes().any(|byte| byte.is_ascii_digit());
            if has_upper && has_lower && has_digit {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, text: &str, memory_type: MemoryType) -> MemoryRecord {
        MemoryRecord {
            id: id.to_owned(),
            memory_type,
            scope: MemoryScope::Project,
            text: text.to_owned(),
            provenance: "test".to_owned(),
            created_at_ms: 0,
            reinforced_at_ms: 0,
            reinforcement: 0,
            confidence: 0.9,
            private: false,
        }
    }

    #[test]
    fn cosine_search_ranks_related_text_above_unrelated() {
        let mut store = MemoryStore::default();
        store
            .insert(record("a", "the build fails when rustc has no target", MemoryType::Fact))
            .unwrap();
        store
            .insert(record("b", "sushi is my favorite food", MemoryType::Preference))
            .unwrap();
        let results = store.search("rust build target fails", 2, 0.0);
        assert_eq!(results[0].0.id, "a");
        assert!(results[0].1 > results[1].1);
    }

    #[test]
    fn credential_shaped_text_is_refused() {
        let mut store = MemoryStore::default();
        assert!(store
            .insert(record("secret", "api_key = sk-abcdef1234567890", MemoryType::Fact))
            .is_err());
        assert!(store
            .insert(record(
                "bearer",
                "Authorization: Bearer abcDEF1234567890xyz",
                MemoryType::Fact
            ))
            .is_err());
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn disabled_store_does_no_work_and_stores_nothing() {
        let mut store = MemoryStore::disabled();
        assert!(!store
            .insert(record("x", "anything", MemoryType::Fact))
            .unwrap());
        assert!(store.search("anything", 10, 0.0).is_empty());
        assert!(!store.is_enabled());
    }

    #[test]
    fn json_round_trip_survives_restart_and_is_human_readable() {
        let mut store = MemoryStore::default();
        store
            .insert(record("a", "prefer snake_case in Rust", MemoryType::Preference))
            .unwrap();
        let json = store.to_json().unwrap();
        assert!(json.contains("\"memory_type\": \"preference\""));
        let restored = MemoryStore::from_json(&json).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored.search("snake case", 1, 0.0)[0].0.text, "prefer snake_case in Rust");
    }

    #[test]
    fn confidence_decays_by_type_half_life() {
        let fact = record("f", "x", MemoryType::Fact);
        let negative = record("n", "x", MemoryType::Negative);
        let day = 86_400_000_u64;
        assert!(fact.effective_confidence(day * 30) > negative.effective_confidence(day * 30));
    }

    #[test]
    fn reinforcement_boosts_and_refreshes_confidence() {
        let mut store = MemoryStore::default();
        store
            .insert(record("a", "commit messages in english", MemoryType::Preference))
            .unwrap();
        let now = 90 * 86_400_000_u64;
        let before = store.records[0].effective_confidence(now);
        assert!(store.reinforce("a", now));
        let after = store.records[0].effective_confidence(now);
        assert!(after > before);
    }

    #[test]
    fn prune_drops_decayed_records_but_keeps_fresh_ones() {
        let mut store = MemoryStore::default();
        store
            .insert(record("old-negative", "avoid x", MemoryType::Negative))
            .unwrap();
        store
            .insert(record("fresh-fact", "keep me", MemoryType::Fact))
            .unwrap();
        // 60 days later: Negative (14-day half-life) is fully decayed, Fact
        // (90-day half-life) survives at 0.9 confidence.
        let dropped = store.prune(60 * 86_400_000, 0.2);
        assert_eq!(dropped, 1);
        assert_eq!(store.len(), 1);
        assert!(store.reinforce("fresh-fact", 60 * 86_400_000));
    }

    #[test]
    fn merge_dedups_and_correction_supersedes_fact() {
        let mut base = MemoryStore::default();
        base.insert(record("subject", "old fact", MemoryType::Fact))
            .unwrap();

        let mut other = MemoryStore::default();
        other
            .insert(record("subject", "corrected", MemoryType::Correction))
            .unwrap();
        other
            .insert(record("new", "new memory", MemoryType::Fact))
            .unwrap();

        let added = base.merge(&other);
        assert_eq!(added, 1); // only "new" was added; "subject" was replaced
        assert_eq!(base.len(), 2);
        let subject = base
            .records
            .iter()
            .find(|record| record.id == "subject")
            .unwrap();
        assert_eq!(subject.text, "corrected");
        assert_eq!(subject.memory_type, MemoryType::Correction);
    }

    #[test]
    fn team_merge_excludes_private_records() {
        let mut other = MemoryStore::default();
        other
            .insert(record("shared", "team-wide fact", MemoryType::Fact))
            .unwrap();
        other
            .insert(record("secret-note", "personal preference", MemoryType::Preference))
            .unwrap();
        other.mark_private("secret-note");

        let mut base = MemoryStore::default();
        let added = base.merge_shared(&other);
        assert_eq!(added, 1);
        assert!(base.get("shared").is_some());
        assert!(base.get("secret-note").is_none());

        // Full merge (single-user) still pulls private records.
        let added_all = base.merge(&other);
        assert_eq!(added_all, 1);
        assert!(base.get("secret-note").is_some());
        assert_eq!(MemoryScope::Team.label(), "team");
    }

    #[test]
    fn save_and_load_round_trip_to_disk() {
        let mut store = MemoryStore::default();
        store
            .insert(record("a", "persisted memory", MemoryType::Preference))
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "mindcode-memory-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        store.save_to_file(&path).unwrap();
        let restored = MemoryStore::load_from_file(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(restored.len(), 1);
        assert_eq!(restored.search("persisted", 1, 0.0)[0].0.text, "persisted memory");
    }
}
