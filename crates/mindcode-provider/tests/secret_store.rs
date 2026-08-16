//! Integration tests for the on-disk secret store. All key material lives in
//! `tempfile` temp dirs and never touches the real `~/.config/mindcode`.

use mindcode_provider::{
    load_store, resolve_credential, save_store, CredentialError, CredentialRef, ProviderId,
    SecretKey, SecretStore, StoreError,
};
use std::collections::HashMap;
use std::fs;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn env_from(map: HashMap<&'static str, &'static str>) -> impl Fn(&str) -> Option<String> {
    move |name| map.get(name).map(|value| (*value).to_owned())
}

#[test]
fn store_write_read_remove_round_trip() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config/mindcode/credentials.json");

    let mut store = SecretStore::new();
    let id = ProviderId::new("custom-a".to_owned()).unwrap();
    store.write(id.clone(), SecretKey::new("forge-value".to_owned()));
    save_store(&path, &store).unwrap();

    let loaded = load_store(&path).unwrap();
    assert_eq!(loaded.read(&id).unwrap().as_secret(), "forge-value");
    assert_eq!(loaded.len(), 1);

    let mut loaded = loaded;
    assert!(loaded.remove(&id).is_some());
    assert!(loaded.read(&id).is_none());
    save_store(&path, &loaded).unwrap();
    assert!(load_store(&path).unwrap().is_empty());
}

#[test]
fn atomic_save_leaves_no_temp_files_and_overwrites() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config/mindcode/credentials.json");

    let mut store = SecretStore::new();
    store.write(
        ProviderId::new("p".to_owned()).unwrap(),
        SecretKey::new("first".to_owned()),
    );
    save_store(&path, &store).unwrap();
    store.write(
        ProviderId::new("p".to_owned()).unwrap(),
        SecretKey::new("second".to_owned()),
    );
    save_store(&path, &store).unwrap();

    assert_eq!(
        load_store(&path)
            .unwrap()
            .read(&ProviderId::new("p".to_owned()).unwrap())
            .unwrap()
            .as_secret(),
        "second"
    );
    let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "temp files left behind: {leftovers:?}"
    );
}

#[cfg(unix)]
#[test]
fn store_file_is_0600_and_directory_0700() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config/mindcode/credentials.json");
    let mut store = SecretStore::new();
    store.write(
        ProviderId::new("p".to_owned()).unwrap(),
        SecretKey::new("value".to_owned()),
    );
    save_store(&path, &store).unwrap();

    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
fn missing_store_file_is_an_empty_store() {
    let temp = tempfile::tempdir().unwrap();
    let store = load_store(&temp.path().join("does/not/exist/credentials.json")).unwrap();
    assert!(store.is_empty());
    assert_eq!(store.len(), 0);
}

#[test]
fn store_rejects_malformed_json_and_non_string_values() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("credentials.json");

    fs::write(&path, b"{").unwrap();
    assert!(matches!(load_store(&path), Err(StoreError::Json(_))));

    fs::write(&path, br#"{"id": 42}"#).unwrap();
    assert!(matches!(load_store(&path), Err(StoreError::Json(_))));

    fs::write(&path, br#"{"bad id":"value"}"#).unwrap();
    assert!(matches!(load_store(&path), Err(StoreError::Json(_))));
}

#[test]
fn env_wins_over_store_then_store_then_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config/mindcode/credentials.json");
    let mut store = SecretStore::new();
    store.write(
        ProviderId::new("SHARED".to_owned()).unwrap(),
        SecretKey::new("stored-value".to_owned()),
    );
    save_store(&path, &store).unwrap();
    let store = load_store(&path).unwrap();

    let env_set = env_from(HashMap::from([("SHARED", "env-value")]));
    let resolved =
        resolve_credential(&CredentialRef::Env("SHARED".to_owned()), &store, env_set).unwrap();
    assert_eq!(resolved.as_secret(), "env-value");

    let env_empty = env_from(HashMap::new());
    let resolved =
        resolve_credential(&CredentialRef::Env("SHARED".to_owned()), &store, env_empty).unwrap();
    assert_eq!(resolved.as_secret(), "stored-value");

    let env_empty = env_from(HashMap::new());
    let resolved = resolve_credential(
        &CredentialRef::Store("SHARED".to_owned()),
        &store,
        env_empty,
    )
    .unwrap();
    assert_eq!(resolved.as_secret(), "stored-value");

    assert!(matches!(
        resolve_credential(
            &CredentialRef::Env("NEITHER".to_owned()),
            &store,
            env_from(HashMap::new()),
        ),
        Err(CredentialError::Missing)
    ));
    assert!(matches!(
        resolve_credential(
            &CredentialRef::Store("NEITHER".to_owned()),
            &store,
            env_from(HashMap::new()),
        ),
        Err(CredentialError::Missing)
    ));
}

#[test]
fn redaction_and_status_never_leak_raw_value() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config/mindcode/credentials.json");
    let raw = "ultra-secret-token-987654";
    let mut store = SecretStore::new();
    store.write(
        ProviderId::new("p".to_owned()).unwrap(),
        SecretKey::new(raw.to_owned()),
    );
    save_store(&path, &store).unwrap();

    let key = store
        .read(&ProviderId::new("p".to_owned()).unwrap())
        .unwrap();
    assert_eq!(key.status(), "configured");
    assert_eq!(key.mask(), mindcode_provider::REDACTED_SECRET);
    assert!(!key.status().contains(raw));
    assert!(!key.mask().contains(raw));
    assert_eq!(
        mindcode_provider::redact_secret(raw),
        mindcode_provider::REDACTED_SECRET
    );
}
