mindcode --help public compatibility fixture

Captured from the current 0.1.3 native binary (crates/mindcode-native) on
Linux x86_64.  Paths, credentials, timestamps, and terminal-control output
are intentionally excluded; the fixture records exact stdout, stderr, and
exit status only.

Capture procedure:

- `--help` / `--version` need no configuration.
- The `auth`/`print` missing-key vectors seed one settings.json with the
  built-in `vexzy` profile active (env credential `VEXZY_API_KEY`) inside a
  throwaway `XDG_CONFIG_HOME`, then run with no credential present, so no
  host configuration or secret can leak into the fixture:

    env -i HOME=<tmp-home> XDG_CONFIG_HOME=<tmp-xdg> ./target/debug/mindcode <args>

Vectors:

- mindcode-help-0.1.3.txt     `--help` (stdout, exit 0)
- mindcode-version-0.1.3.txt  `--version` (stdout, exit 0)
- auth-missing-key.*          `auth status` with the active vexzy profile and
                              no credential (exit 1, JSON "not configured")
- print-missing-key.*         a regular prompt with the active vexzy profile
                              and no credential (exit 1, not-migrated
                              diagnostic on stderr)
- setup-token-missing-key.*   `setup-token` (no key required, exit 0)
