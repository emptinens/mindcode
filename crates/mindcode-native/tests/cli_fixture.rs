//! Canonical CLI compatibility vectors (§5.6.1).
//!
//! These cases never contact a provider: the auth/prompt vectors run with an
//! isolated HOME/XDG_CONFIG_HOME and no credential environment variable.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/native-parity")
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(fixture_root().join(name)).unwrap_or_else(|error| {
        panic!("read parity fixture {name}: {error}");
    })
}

fn run_isolated(args: &[&str], home: &Path) -> Output {
    let config = home.join("xdg");
    Command::new(env!("CARGO_BIN_EXE_mindcode"))
        .env_clear()
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", config)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("run mindcode {args:?}: {error}"))
}

fn assert_vector(name: &str, args: &[&str], home: &Path) {
    let output = run_isolated(args, home);
    let expected_exit: i32 = String::from_utf8(fixture(&format!("{name}.exit")))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(expected_exit),
        "exit mismatch for {name}"
    );
    assert_eq!(
        output.stdout,
        fixture(&format!("{name}.stdout")),
        "stdout mismatch for {name}"
    );
    assert_eq!(
        output.stderr,
        fixture(&format!("{name}.stderr")),
        "stderr mismatch for {name}"
    );
}

#[test]
fn native_cli_matches_canonical_parity_vectors() {
    let home = tempfile::tempdir().unwrap();
    let help = run_isolated(&["--help"], home.path());
    assert_eq!(help.status.code(), Some(0));
    assert_eq!(help.stdout, fixture("mindcode-help-0.1.4.txt"));
    assert!(help.stderr.is_empty());
    let version = run_isolated(&["--version"], home.path());
    assert_eq!(version.status.code(), Some(0));
    assert_eq!(version.stdout, fixture("mindcode-version-0.1.4.txt"));
    assert!(version.stderr.is_empty());
    assert_vector("auth-missing-key", &["auth", "status"], home.path());
    assert_vector("print-missing-key", &["hello"], home.path());
    assert_vector("setup-token-missing-key", &["setup-token"], home.path());
}

#[test]
fn compatibility_fixture_keeps_the_multi_provider_contract_machine_readable() {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/compatibility.json");
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(value["version"], "0.1.4");
    assert_eq!(value["platform"], "linux-x64");
    assert_eq!(value["providers"]["presets"], false);
    assert_eq!(
        value["credentials"]["precedence"],
        serde_json::json!(["env", "store", "fail-closed"])
    );
    assert_eq!(value["commands"]["config"]["status"], "removed");
    assert_eq!(value["commands"]["submodel"]["status"], "removed");
    assert_eq!(value["js_runtime"]["core_required"], false);
}
