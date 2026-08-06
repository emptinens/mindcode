//! Keyless, in-memory VEXZY model-catalog cache.
//!
//! Only normalized model metadata crosses this boundary. No API key, provider
//! payload, prompt, completion, or network client is represented or retained.

use serde::{ser::SerializeStruct, Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

pub const CATALOG_SCHEMA_VERSION: u16 = 1;
pub const MAX_CATALOG_MODELS: usize = 1_024;
pub const MAX_SNAPSHOT_BYTES: usize = 1_024 * 1_024;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_FUTURE_SKEW_MS: u64 = 300_000;
const MAX_ID_BYTES: usize = 256;
const MAX_DISPLAY_NAME_BYTES: usize = 512;
const MAX_STATUS_BYTES: usize = 128;
const MAX_DIGEST_BYTES: usize = 64;
const MAX_LIST_ITEMS: usize = 32;
const MAX_CAPABILITIES: usize = 64;
const MAX_ITEM_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogModalities {
    pub input: Vec<String>,
    pub output: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogModel {
    pub id: String,
    pub display_name: String,
    pub available: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub status: Option<String>,
    pub context_length: u64,
    pub efforts: Vec<String>,
    pub modalities: CatalogModalities,
    pub capabilities: BTreeMap<String, bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub output_limit: Option<u64>,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub output_credits_per_million: Option<serde_json::Number>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogSnapshot {
    pub schema_version: u16,
    pub fetched_at_ms: u64,
    pub digest: String,
    pub models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CatalogGetResult {
    pub snapshot: Option<Arc<CatalogSnapshot>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogCacheState {
    Empty,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CatalogStatus {
    pub state: CatalogCacheState,
    pub has_snapshot: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CatalogPutResult {
    pub stored: bool,
}

impl Serialize for CatalogGetResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut value = serializer.serialize_struct("ModelCatalogGetResult", 1)?;
        value.serialize_field("snapshot", &self.snapshot.as_deref())?;
        serde::ser::SerializeStruct::end(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogPutError {
    InvalidSnapshot(String),
    Conflict(String),
    Stale(String),
}

impl CatalogPutError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidSnapshot(_) => "catalog_invalid_snapshot",
            Self::Conflict(_) => "catalog_conflict",
            Self::Stale(_) => "catalog_stale",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::InvalidSnapshot(message) | Self::Conflict(message) | Self::Stale(message) => {
                message
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogPutParams {
    pub snapshot: CatalogSnapshot,
}

#[derive(Debug)]
struct CatalogState {
    generation: u64,
    snapshot: Option<Arc<CatalogSnapshot>>,
}

#[derive(Debug)]
pub struct CatalogCache {
    state: RwLock<CatalogState>,
}

impl Default for CatalogCache {
    fn default() -> Self {
        Self::new()
    }
}

impl CatalogCache {
    pub fn new() -> Self {
        Self {
            state: RwLock::new(CatalogState {
                generation: 0,
                snapshot: None,
            }),
        }
    }

    pub fn get(&self) -> CatalogGetResult {
        let state = self.state.read().expect("catalog cache poisoned");
        CatalogGetResult {
            snapshot: state.snapshot.clone(),
        }
    }

    pub fn status(&self) -> CatalogStatus {
        let state = self.state.read().expect("catalog cache poisoned");
        match state.snapshot.as_deref() {
            Some(snapshot) => CatalogStatus {
                state: CatalogCacheState::Ready,
                has_snapshot: true,
                fetched_at_ms: Some(snapshot.fetched_at_ms),
                digest: Some(snapshot.digest.clone()),
            },
            None => CatalogStatus {
                state: CatalogCacheState::Empty,
                has_snapshot: false,
                fetched_at_ms: None,
                digest: None,
            },
        }
    }

    /// Atomically publishes a validated immutable snapshot. The generation is
    /// internal only: wire clients use monotonic timestamp/digest semantics.
    pub fn put(&self, params: CatalogPutParams) -> Result<CatalogPutResult, CatalogPutError> {
        validate_snapshot(&params.snapshot).map_err(CatalogPutError::InvalidSnapshot)?;
        let incoming = Arc::new(params.snapshot);
        let mut state = self.state.write().expect("catalog cache poisoned");

        if let Some(current) = state.snapshot.as_deref() {
            if incoming.fetched_at_ms < current.fetched_at_ms {
                return Err(CatalogPutError::Stale(format!(
                    "snapshot timestamp {} is older than current timestamp {}",
                    incoming.fetched_at_ms, current.fetched_at_ms
                )));
            }
            if incoming.fetched_at_ms == current.fetched_at_ms {
                if incoming.digest == current.digest {
                    return Ok(CatalogPutResult { stored: false });
                }
                return Err(CatalogPutError::Conflict(
                    "equal-timestamp snapshot has a different digest".into(),
                ));
            }
        }

        state.generation = state.generation.checked_add(1).ok_or_else(|| {
            CatalogPutError::InvalidSnapshot("catalog generation overflow".into())
        })?;
        state.snapshot = Some(incoming);
        Ok(CatalogPutResult { stored: true })
    }
}

pub fn validate_snapshot(snapshot: &CatalogSnapshot) -> Result<(), String> {
    if snapshot.schema_version != CATALOG_SCHEMA_VERSION {
        return Err(format!("schema_version must be {CATALOG_SCHEMA_VERSION}"));
    }
    validate_safe_integer(snapshot.fetched_at_ms, "fetched_at_ms")?;
    let max_timestamp = unix_time_ms()?.saturating_add(MAX_FUTURE_SKEW_MS);
    if snapshot.fetched_at_ms > max_timestamp {
        return Err("fetched_at_ms is too far in the future".into());
    }
    validate_digest(&snapshot.digest)?;
    if snapshot.models.len() > MAX_CATALOG_MODELS {
        return Err(format!("models exceeds {MAX_CATALOG_MODELS} items"));
    }
    let mut ids = std::collections::HashSet::with_capacity(snapshot.models.len());
    for (index, model) in snapshot.models.iter().enumerate() {
        validate_model(model).map_err(|error| format!("models[{index}]: {error}"))?;
        if !ids.insert(&model.id) {
            return Err(format!("models[{index}] duplicate model id"));
        }
    }
    if compute_digest(snapshot)? != snapshot.digest {
        return Err("digest does not match the canonical snapshot".into());
    }
    let bytes =
        serde_json::to_vec(snapshot).map_err(|error| format!("serialize snapshot: {error}"))?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(format!(
            "normalized snapshot exceeds {MAX_SNAPSHOT_BYTES} bytes"
        ));
    }
    Ok(())
}

fn validate_model(model: &CatalogModel) -> Result<(), String> {
    validate_text(&model.id, MAX_ID_BYTES, "id")?;
    validate_text(&model.display_name, MAX_DISPLAY_NAME_BYTES, "display_name")?;
    if let Some(status) = &model.status {
        validate_text(status, MAX_STATUS_BYTES, "status")?;
    }
    validate_safe_integer(model.context_length, "context_length")?;
    if model.context_length == 0 {
        return Err("context_length must be positive".into());
    }
    validate_string_list(&model.efforts, "efforts")?;
    validate_string_list(&model.modalities.input, "modalities.input")?;
    validate_string_list(&model.modalities.output, "modalities.output")?;
    if model.capabilities.len() > MAX_CAPABILITIES {
        return Err(format!("capabilities exceeds {MAX_CAPABILITIES} entries"));
    }
    for key in model.capabilities.keys() {
        validate_text(key, MAX_ITEM_BYTES, "capabilities key")?;
    }
    if let Some(limit) = model.output_limit {
        validate_safe_integer(limit, "output_limit")?;
        if limit == 0 || limit > model.context_length {
            return Err("output_limit must be positive and <= context_length".into());
        }
    }
    if let Some(credits) = &model.output_credits_per_million {
        if credits
            .as_f64()
            .is_none_or(|value| !value.is_finite() || value < 0.0)
        {
            return Err("output_credits_per_million must be finite and non-negative".into());
        }
    }
    Ok(())
}

fn validate_string_list(values: &[String], name: &str) -> Result<(), String> {
    if values.len() > MAX_LIST_ITEMS {
        return Err(format!("{name} exceeds {MAX_LIST_ITEMS} items"));
    }
    for value in values {
        validate_text(value, MAX_ITEM_BYTES, name)?;
    }
    Ok(())
}

fn deserialize_non_null_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(serde::de::Error::custom(
            "null is not valid for an optional field",
        ));
    }
    T::deserialize(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

fn validate_text(value: &str, max_bytes: usize, name: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > max_bytes {
        return Err(format!("{name} has invalid length"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{name} contains control characters"));
    }
    Ok(())
}

fn validate_safe_integer(value: u64, name: &str) -> Result<(), String> {
    if value > MAX_SAFE_INTEGER {
        return Err(format!("{name} exceeds the safe integer bound"));
    }
    Ok(())
}

fn unix_time_ms() -> Result<u64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch".to_string())?;
    u64::try_from(elapsed.as_millis()).map_err(|_| "system clock exceeds u64 milliseconds".into())
}

fn validate_digest(value: &str) -> Result<(), String> {
    if value.len() != MAX_DIGEST_BYTES
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("digest must be lowercase hexadecimal SHA-256".into());
    }
    Ok(())
}

#[derive(Serialize)]
struct DigestPayload<'a> {
    schema_version: u16,
    fetched_at_ms: u64,
    models: Vec<DigestCatalogModel<'a>>,
}

// Field order is part of the cross-language canonical digest. It mirrors the
// normalized TypeScript projection rather than the inbound wire struct.
#[derive(Serialize)]
struct DigestCatalogModel<'a> {
    id: &'a str,
    display_name: &'a str,
    available: bool,
    context_length: u64,
    efforts: &'a [String],
    modalities: &'a CatalogModalities,
    capabilities: &'a BTreeMap<String, bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_credits_per_million: Option<&'a serde_json::Number>,
}

fn compute_digest(snapshot: &CatalogSnapshot) -> Result<String, String> {
    let payload = DigestPayload {
        schema_version: snapshot.schema_version,
        fetched_at_ms: snapshot.fetched_at_ms,
        models: snapshot
            .models
            .iter()
            .map(|model| DigestCatalogModel {
                id: &model.id,
                display_name: &model.display_name,
                available: model.available,
                context_length: model.context_length,
                efforts: &model.efforts,
                modalities: &model.modalities,
                capabilities: &model.capabilities,
                status: model.status.as_deref(),
                output_limit: model.output_limit,
                output_credits_per_million: model.output_credits_per_million.as_ref(),
            })
            .collect(),
    };
    let bytes = serde_json::to_vec(&payload)
        .map_err(|error| format!("serialize digest payload: {error}"))?;
    Ok(sha256_hex(&bytes))
}

fn sha256_hex(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut data = input.to_vec();
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in data.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (index, bytes) in chunk.chunks_exact(4).take(16).enumerate() {
            w[index] = u32::from_be_bytes(bytes.try_into().expect("four bytes"));
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let mut work = h;
        for index in 0..64 {
            let s1 = work[4].rotate_right(6) ^ work[4].rotate_right(11) ^ work[4].rotate_right(25);
            let ch = (work[4] & work[5]) ^ ((!work[4]) & work[6]);
            let temp1 = work[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = work[0].rotate_right(2) ^ work[0].rotate_right(13) ^ work[0].rotate_right(22);
            let maj = (work[0] & work[1]) ^ (work[0] & work[2]) ^ (work[1] & work[2]);
            let temp2 = s0.wrapping_add(maj);
            work = [
                temp1.wrapping_add(temp2),
                work[0],
                work[1],
                work[2],
                work[3].wrapping_add(temp1),
                work[4],
                work[5],
                work[6],
            ];
        }
        for index in 0..8 {
            h[index] = h[index].wrapping_add(work[index]);
        }
    }
    let mut output = String::with_capacity(64);
    for word in h {
        output.push_str(&format!("{word:08x}"));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, sync::Arc, thread};

    fn model(id: &str) -> CatalogModel {
        CatalogModel {
            id: id.into(),
            display_name: id.into(),
            available: true,
            status: Some("working".into()),
            context_length: 1_100_000,
            efforts: vec!["none".into(), "low".into(), "max".into()],
            modalities: CatalogModalities {
                input: vec!["text".into()],
                output: vec!["text".into()],
            },
            capabilities: BTreeMap::from([
                (String::from("reasoning"), true),
                (String::from("tools"), true),
            ]),
            output_limit: Some(128_000),
            output_credits_per_million: serde_json::Number::from_f64(37.5),
        }
    }

    fn snapshot(timestamp: u64, models: Vec<CatalogModel>) -> CatalogSnapshot {
        let mut value = CatalogSnapshot {
            schema_version: 1,
            fetched_at_ms: timestamp,
            digest: String::new(),
            models,
        };
        value.digest = compute_digest(&value).unwrap();
        value
    }

    #[test]
    fn digest_matches_sha256_and_status_wire_shape() {
        let empty = snapshot(100, vec![]);
        assert_eq!(
            empty.digest,
            "fdccc8661cf7582246eb441b934761d82e768a0116dc57491002e30aad826c04"
        );
        let cache = CatalogCache::new();
        assert_eq!(
            serde_json::to_value(cache.status()).unwrap(),
            serde_json::json!({"state":"empty","has_snapshot":false})
        );
        cache.put(CatalogPutParams { snapshot: empty }).unwrap();
        assert_eq!(
            serde_json::to_value(cache.status()).unwrap()["state"],
            "ready"
        );
        assert!(serde_json::to_value(cache.status())
            .unwrap()
            .get("fetched_at_ms")
            .is_some());
    }

    #[test]
    fn monotonic_put_is_idempotent_and_rejects_stale_or_conflicting_equal_time() {
        let cache = CatalogCache::new();
        let first = snapshot(10, vec![model("a")]);
        cache
            .put(CatalogPutParams {
                snapshot: first.clone(),
            })
            .unwrap();
        assert!(
            !cache
                .put(CatalogPutParams { snapshot: first })
                .unwrap()
                .stored
        );
        assert!(matches!(
            cache.put(CatalogPutParams {
                snapshot: snapshot(9, vec![])
            }),
            Err(CatalogPutError::Stale(_))
        ));
        let mut conflicting = snapshot(10, vec![]);
        conflicting.digest = compute_digest(&conflicting).unwrap();
        assert!(matches!(
            cache.put(CatalogPutParams {
                snapshot: conflicting
            }),
            Err(CatalogPutError::Conflict(_))
        ));
    }

    #[test]
    fn validation_enforces_exact_bounds_and_projection() {
        let mut duplicate = snapshot(1, vec![model("a"), model("a")]);
        duplicate.digest = compute_digest(&duplicate).unwrap();
        assert!(validate_snapshot(&duplicate).is_err());
        let mut too_many = Vec::new();
        for index in 0..=MAX_CATALOG_MODELS {
            too_many.push(model(&format!("model-{index:04}")));
        }
        assert!(validate_snapshot(&snapshot(1, too_many)).is_err());
        let mut invalid = snapshot(1, vec![model("a")]);
        invalid.models[0].output_limit = Some(invalid.models[0].context_length + 1);
        invalid.digest = compute_digest(&invalid).unwrap();
        assert!(validate_snapshot(&invalid).is_err());
        let future = snapshot(MAX_SAFE_INTEGER, vec![]);
        assert!(validate_snapshot(&future)
            .unwrap_err()
            .contains("too far in the future"));
        invalid = snapshot(1, vec![model("a")]);
        invalid.models[0].output_credits_per_million = Some((-1).into());
        invalid.digest = compute_digest(&invalid).unwrap();
        assert!(validate_snapshot(&invalid).is_err());
        invalid = snapshot(1, vec![model("a")]);
        invalid.models[0].efforts = (0..=MAX_LIST_ITEMS).map(|_| "x".into()).collect();
        invalid.digest = compute_digest(&invalid).unwrap();
        assert!(validate_snapshot(&invalid).is_err());
        invalid = snapshot(1, vec![model("a")]);
        invalid.models[0].capabilities = (0..=MAX_CAPABILITIES)
            .map(|i| (format!("c{i}"), true))
            .collect();
        invalid.digest = compute_digest(&invalid).unwrap();
        assert!(validate_snapshot(&invalid).is_err());
    }

    #[test]
    fn validation_enforces_the_one_mebibyte_snapshot_bound() {
        let mut models = Vec::with_capacity(128);
        for index in 0..128 {
            let mut item = model(&format!("model-{index:03}"));
            item.display_name = "d".repeat(MAX_DISPLAY_NAME_BYTES);
            item.efforts = (0..MAX_LIST_ITEMS)
                .map(|_| "e".repeat(MAX_ITEM_BYTES))
                .collect();
            item.modalities.input = (0..MAX_LIST_ITEMS)
                .map(|_| "i".repeat(MAX_ITEM_BYTES))
                .collect();
            item.modalities.output = (0..MAX_LIST_ITEMS)
                .map(|_| "o".repeat(MAX_ITEM_BYTES))
                .collect();
            models.push(item);
        }
        assert!(validate_snapshot(&snapshot(1, models)).is_err());
    }

    #[test]
    fn readers_observe_immutable_arcs_during_concurrent_puts() {
        let cache = Arc::new(CatalogCache::new());
        let writer_cache = Arc::clone(&cache);
        let writer = thread::spawn(move || {
            for timestamp in 1..=32 {
                writer_cache
                    .put(CatalogPutParams {
                        snapshot: snapshot(timestamp, vec![]),
                    })
                    .unwrap();
            }
        });
        let readers: Vec<_> = (0..4)
            .map(|_| {
                let cache = Arc::clone(&cache);
                thread::spawn(move || {
                    for _ in 0..100 {
                        let _ = cache.get();
                    }
                })
            })
            .collect();
        writer.join().unwrap();
        for reader in readers {
            reader.join().unwrap();
        }
        assert!(cache.get().snapshot.is_some());
    }

    #[test]
    fn serde_rejects_old_wire_names_and_secrets() {
        let value = serde_json::json!({"schema":1,"fetched_at_ms":1,"digest":"a","models":[],"api_key":"forge-secret"});
        assert!(serde_json::from_value::<CatalogSnapshot>(value).is_err());
    }
}
