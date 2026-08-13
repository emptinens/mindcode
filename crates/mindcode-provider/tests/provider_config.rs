//! Integration tests for the provider profile model. No secrets are used:
//! credential references name environment variables or store keys only.

use mindcode_provider::{CredentialRef, ModelId, Protocol, ProviderConfig, ProviderId};
use serde_json::json;

#[test]
fn provider_config_rejects_unknown_fields() {
    let result = serde_json::from_str::<ProviderConfig>(
        r#"{
            "id": "a", "name": "b", "protocol": "anthropic-compatible",
            "base_url": "x", "credential": {"store": "s"}, "active": false,
            "bogus": 1
        }"#,
    );
    assert!(result.is_err(), "extra keys must be rejected: {result:?}");
}

#[test]
fn provider_config_allowlist_defaults_empty() {
    let config: ProviderConfig = serde_json::from_str(
        r#"{
            "id": "vexzy",
            "name": "VEXZY",
            "protocol": "openai-compatible",
            "base_url": "https://api.echogate.one/v1",
            "credential": {"env": "VEXZY_API_KEY"},
            "active": true
        }"#,
    )
    .unwrap();
    assert!(config.allowlist.is_empty());
    assert!(!config.allows_model(&ModelId::new("gpt-5.6-luna".to_owned()).unwrap()));
}

#[test]
fn provider_config_allowlist_enables_explicit_models_only() {
    let config: ProviderConfig = serde_json::from_value(json!({
        "id": "custom",
        "name": "Custom",
        "protocol": "anthropic-compatible",
        "base_url": "https://example.com/v1",
        "credential": {"store": "custom"},
        "allowlist": ["model-a", "model-b"],
        "active": true,
    }))
    .unwrap();
    assert_eq!(config.allowlist.len(), 2);
    assert!(config.allows_model(&ModelId::new("model-a".to_owned()).unwrap()));
    assert!(config.allows_model(&ModelId::new("model-b".to_owned()).unwrap()));
    assert!(!config.allows_model(&ModelId::new("model-c".to_owned()).unwrap()));
}

#[test]
fn invalid_model_and_provider_ids_are_rejected() {
    for invalid in ["", "   ", "has space", "has\ttab"] {
        assert!(ModelId::new(invalid.to_owned()).is_err(), "{invalid:?}");
        assert!(ProviderId::new(invalid.to_owned()).is_err(), "{invalid:?}");
        assert!(serde_json::from_str::<ModelId>(&json!(invalid).to_string()).is_err());
        assert!(serde_json::from_str::<ProviderId>(&json!(invalid).to_string()).is_err());
    }
    assert!(serde_json::from_str::<ProviderConfig>(
        r#"{
            "id": "a", "name": "b", "protocol": "openai-compatible", "base_url": "x",
            "credential": {"env": "K"}, "active": false, "allowlist": ["has space"]
        }"#,
    )
    .is_err());
}

#[test]
fn credential_ref_round_trips_both_shapes() {
    let env_ref = CredentialRef::env("VEXZY_API_KEY");
    let json = serde_json::to_string(&env_ref).unwrap();
    assert_eq!(json, r#"{"env":"VEXZY_API_KEY"}"#);
    assert_eq!(
        serde_json::from_str::<CredentialRef>(&json).unwrap(),
        env_ref
    );

    let store_ref = CredentialRef::store("vexzy");
    let json = serde_json::to_string(&store_ref).unwrap();
    assert_eq!(json, r#"{"store":"vexzy"}"#);
    assert_eq!(
        serde_json::from_str::<CredentialRef>(&json).unwrap(),
        store_ref
    );
    assert!(serde_json::from_str::<CredentialRef>(r#"{"env":"a","store":"b"}"#).is_err());
}

#[test]
fn protocol_round_trips_contract_renames() {
    for (protocol, rename) in [
        (Protocol::OpenAiCompatible, "openai-compatible"),
        (Protocol::AnthropicCompatible, "anthropic-compatible"),
    ] {
        assert_eq!(
            serde_json::to_string(&protocol).unwrap(),
            format!("\"{rename}\"")
        );
        assert_eq!(
            serde_json::from_str::<Protocol>(&format!("\"{rename}\"")).unwrap(),
            protocol
        );
        assert_eq!(protocol.as_str(), rename);
        assert_eq!(protocol.to_string(), rename);
        assert_eq!(rename.parse::<Protocol>().unwrap(), protocol);
    }
    assert!("anthropic".parse::<Protocol>().is_err());
}
