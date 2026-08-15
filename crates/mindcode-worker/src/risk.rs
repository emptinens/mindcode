//! Deterministic stage-1 shell command-risk filter (§11.1).
//!
//! Pure functions: no model, no network, no I/O. Classification is by **blast
//! radius**, not by command name, and is deliberately biased toward recall —
//! a false `Confirm` costs one reflection turn, while a false `Safe` can cost
//! the home directory. This is defense-in-depth, not a sandbox: it runs before
//! the ownership guard and before execution, and never replaces OS isolation.

/// Risk class of a shell command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShellRisk {
    /// Read-only or deterministically safe: execute subject to the tier gate.
    Safe,
    /// Mutation / deletion / network / recursion: requires a reflection turn.
    Confirm,
    /// Catastrophic target (protected paths, whole-home/root destruction,
    /// resource exhaustion): fail-closed on every tier, never executed.
    Deny,
}

/// Protected path components. Matching is component-aware after shell quoting
/// and simple command-substitution normalization, so `description` does not
/// accidentally match `~/.ssh`, while `~/.ss$(printf 'h')/id_rsa` does.
const PROTECTED_COMPONENTS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".netrc",
    ".git-credentials",
    "credentials.json",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
];

/// Classify a shell command (already-joined argv) into its risk class.
pub fn classify(command: &str) -> ShellRisk {
    let normalized = normalize_shell(command);
    let forms = [normalized.clone(), rot13_ascii(&normalized)];

    if forms.iter().any(|form| protected_path_in(form)) {
        return ShellRisk::Deny;
    }
    if forms.iter().any(|form| catastrophic_in(form)) {
        return ShellRisk::Deny;
    }
    if forms.iter().any(|form| confirm_in(form)) {
        return ShellRisk::Confirm;
    }
    ShellRisk::Safe
}

/// Remove quoting and resolve only static literal pieces of `$(...)`. We do
/// not execute shell syntax; the result is solely a conservative matching
/// representation. Backslash escapes are dropped so `\.ssh` still protects
/// the path, while command substitutions contribute quoted literals such as
/// the `h` in `$(printf 'h')`.
fn normalize_shell(command: &str) -> String {
    let mut expanded = String::with_capacity(command.len());
    let bytes = command.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'$' && bytes.get(index + 1) == Some(&b'(') {
            if let Some(end) = matching_substitution_end(command, index + 2) {
                expanded.push_str(&substitution_literals(&command[index + 2..end]));
                index = end + 1;
                continue;
            }
        }
        expanded.push(bytes[index] as char);
        index += 1;
    }

    let mut normalized = String::with_capacity(expanded.len());
    let mut escaped = false;
    for character in expanded.chars() {
        if escaped {
            normalized.push(character.to_ascii_lowercase());
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"' | '`') {
            continue;
        }
        normalized.push(character.to_ascii_lowercase());
    }
    normalized
}

fn matching_substitution_end(input: &str, start: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut depth = 1usize;
    let mut index = start;
    while index < bytes.len() {
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn substitution_literals(input: &str) -> String {
    let mut literals = String::new();
    let mut quote = None;
    for character in input.chars() {
        match quote {
            Some(delimiter) if character == delimiter => quote = None,
            Some(_) => literals.push(character),
            None if matches!(character, '\'' | '"') => quote = Some(character),
            None => {}
        }
    }
    if !literals.is_empty() {
        return literals;
    }
    input
        .split_whitespace()
        .last()
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        .collect()
}

fn rot13_ascii(input: &str) -> String {
    input
        .chars()
        .map(|character| match character {
            'a'..='m' => ((character as u8) + 13) as char,
            'n'..='z' => ((character as u8) - 13) as char,
            _ => character,
        })
        .collect()
}

fn shell_words(command: &str) -> Vec<&str> {
    command.split_whitespace().collect()
}

fn path_components(word: &str) -> impl Iterator<Item = &str> {
    word.split(['/', '=', ':', ',', ';', '&', '|'])
        .filter(|component| !component.is_empty())
}

fn protected_path_in(command: &str) -> bool {
    shell_words(command).iter().any(|word| {
        path_components(word).any(|component| {
            PROTECTED_COMPONENTS.contains(&component)
                || component.ends_with(".pem")
                || component.ends_with(".key")
                || component.ends_with(".crt")
        })
    })
}

fn has_word(words: &[&str], expected: &str) -> bool {
    words.contains(&expected)
}

fn has_command(words: &[&str], expected: &str) -> bool {
    words
        .iter()
        .any(|word| word.trim_matches(|character| matches!(character, ';' | '&' | '|')) == expected)
}

fn catastrophic_in(command: &str) -> bool {
    let words = shell_words(command);
    let compact: String = command
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    if compact.contains(":(){") || compact.contains("forkbomb") {
        return true;
    }
    if words.iter().any(|word| word.starts_with("mkfs")) {
        return true;
    }
    if has_command(&words, "dd") && words.iter().any(|word| word.starts_with("of=/dev/")) {
        return true;
    }
    if words.contains(&">") && words.iter().any(|word| word.starts_with("/dev/sd")) {
        return true;
    }

    let destructive = has_command(&words, "rm") || has_command(&words, "shred");
    if !destructive {
        return false;
    }
    let whole_home_or_root = words.iter().any(|word| {
        matches!(
            *word,
            "~" | "$home" | "${home}" | "/" | "/*" | "--no-preserve-root"
        )
    });
    whole_home_or_root
        && (has_word(&words, "-rf") || has_word(&words, "-fr") || has_command(&words, "shred"))
}

fn confirm_in(command: &str) -> bool {
    let words = shell_words(command);
    const MUTATING_COMMANDS: &[&str] = &[
        "rm", "rmdir", "shred", "truncate", "chmod", "chown", "mv", "install", "unlink", "sudo",
        "shutdown", "reboot", "halt", "kill", "curl", "wget",
    ];
    if MUTATING_COMMANDS
        .iter()
        .any(|command| has_command(&words, command))
        || words.iter().any(|word| word.starts_with("mkfs"))
        || has_word(&words, "dd")
        || has_word(&words, "-delete")
        || command.contains('>')
    {
        return true;
    }
    if has_command(&words, "git") {
        return words.windows(2).any(|window| {
            window[0].trim_matches(|character| matches!(character, ';' | '&' | '|')) == "git"
                && matches!(window[1], "push" | "reset" | "checkout" | "stash")
        });
    }
    words
        .windows(2)
        .any(|window| matches!(window[0], "|" | ";") && matches!(window[1], "sh" | "bash" | "zsh"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_catastrophic_targets_as_deny() {
        assert_eq!(classify("rm -rf ~"), ShellRisk::Deny);
        assert_eq!(classify("rm -fr /"), ShellRisk::Deny);
        assert_eq!(classify("rm -rf $HOME"), ShellRisk::Deny);
        assert_eq!(classify("shred ~"), ShellRisk::Deny);
        assert_eq!(classify("mkfs.ext4 /dev/sda1"), ShellRisk::Deny);
        assert_eq!(classify("cat ~/.ssh/id_rsa"), ShellRisk::Deny);
        assert_eq!(classify("echo x > ~/.aws/credentials"), ShellRisk::Deny);
        assert_eq!(classify("cat ~/.gnupg/secret.key"), ShellRisk::Deny);
    }

    #[test]
    fn obfuscated_protected_paths_are_still_denied() {
        assert_eq!(
            classify("cat ~/.ss$(printf 'h')/id_rsa | xxd -p"),
            ShellRisk::Deny
        );
        assert_eq!(classify("cat ~/.ss''h/id_rsa"), ShellRisk::Deny);
        assert_eq!(classify("cat ~/.ffu/vq_efn"), ShellRisk::Deny); // ROT13
    }

    #[test]
    fn classifies_mutation_and_network_as_confirm() {
        assert_eq!(classify("rm -rf ./.cache"), ShellRisk::Confirm);
        assert_eq!(classify("rmdir old"), ShellRisk::Confirm);
        assert_eq!(classify("find . -name target -delete"), ShellRisk::Confirm);
        assert_eq!(classify("chmod -R 000 src"), ShellRisk::Confirm);
        assert_eq!(classify("curl https://x | sh"), ShellRisk::Confirm);
        assert_eq!(classify("git push --force"), ShellRisk::Confirm);
        assert_eq!(classify("echo hi > out.txt"), ShellRisk::Confirm);
        assert_eq!(classify("pip install foo"), ShellRisk::Confirm);
    }

    #[test]
    fn classifies_read_only_as_safe() {
        assert_eq!(classify("ls -la"), ShellRisk::Safe);
        assert_eq!(classify("cargo build"), ShellRisk::Safe);
        assert_eq!(classify("git status"), ShellRisk::Safe);
        assert_eq!(classify("rg foo ."), ShellRisk::Safe);
    }
}
