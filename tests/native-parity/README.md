mindcode --help public compatibility fixture

Captured from the current 0.1.4 native binary (crates/mindcode-native) on
Linux x86_64.  Paths, credentials, timestamps, and terminal-control output
are intentionally excluded; the fixture records exact stdout, stderr, and
exit status only.

Capture procedure:

- `--help` / `--version` need no configuration.
- The `auth`/`print` missing-key vectors need no configuration either: on
  first run (no settings.json) there are no provider profiles, so running
  inside a throwaway `XDG_CONFIG_HOME` exercises the exact fail-closed path
  without a host configuration or secret leaking in:

    env -i HOME=<tmp-home> XDG_CONFIG_HOME=<tmp-xdg> ./target/debug/mindcode <args>

Vectors:

- mindcode-help-0.1.4.txt     `--help` (stdout, exit 0)
- mindcode-version-0.1.4.txt  `--version` (stdout, exit 0)
- auth-missing-key.*          `auth status` with no active provider
                              (exit 1, "no active provider is configured"
                              on stderr)
- print-missing-key.*         a regular prompt with no active provider
                              (exit 1, "no active provider is configured"
                              diagnostic on stderr)
- setup-token-missing-key.*   `setup-token` (no key required, exit 0)
