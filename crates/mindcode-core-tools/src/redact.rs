//! Secret redaction for decoded text (§13.1 hardening, shared with §11.8).
//!
//! A conservative defense-in-depth filter, not a parser: it catches the common
//! credential shapes (bearer tokens, `sk-` keys, `key = value` assignments)
//! plus long high-entropy tokens, and never writes the original text back out.
//! Used to scrub shell tool output before it reaches the model transcript, and
//! to scrub frame dumps before they touch disk.

/// Redact credential-shaped values from already-decoded text.
pub fn redact_secrets(text: &str) -> String {
    let mut output = text.to_owned();
    output = redact_bearer_tokens(&output);
    output = redact_sk_tokens(&output);
    output = redact_key_value(&output);
    output = redact_high_entropy_tokens(&output);
    output = redact_encoded_tokens(&output);
    output
}

fn redact_bearer_tokens(text: &str) -> String {
    replace_each(text, "Bearer ", |token| {
        let length = token
            .find(|character: char| character.is_whitespace() || character == ',')
            .unwrap_or(token.len());
        (length >= 8, "Bearer [redacted]".to_owned(), length)
    })
}

fn redact_sk_tokens(text: &str) -> String {
    replace_each(text, "sk-", |token| {
        let length = token
            .find(|character: char| character.is_whitespace() || character == '"')
            .unwrap_or(token.len());
        (length >= 8, "sk-[redacted]".to_owned(), length)
    })
}

fn redact_key_value(text: &str) -> String {
    const KEY_NAMES: [&str; 8] = [
        "api_key",
        "apikey",
        "api-key",
        "secret",
        "password",
        "credential",
        "token",
        "authorization",
    ];
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    'outer: while !rest.is_empty() {
        for name in KEY_NAMES {
            let Some(prefix) = rest.get(..name.len()) else {
                continue;
            };
            if !prefix.eq_ignore_ascii_case(name) {
                continue;
            }
            let after = &rest[name.len()..];
            let mut cursor = 0;
            for byte in after.bytes() {
                if matches!(byte, b' ' | b':' | b'=' | b'\t') {
                    cursor += 1;
                } else {
                    break;
                }
            }
            if cursor == 0 || cursor >= after.len() {
                continue;
            }
            let value = &after[cursor..];
            let length = value
                .find(|character: char| {
                    character.is_whitespace() || character == ',' || character == '"'
                })
                .unwrap_or(value.len().min(128));
            if length == 0 {
                continue;
            }
            let consumed = name.len() + cursor + length;
            output.push_str(&rest[..name.len() + cursor]);
            output.push_str("[redacted]");
            rest = &rest[consumed..];
            continue 'outer;
        }
        let next = rest
            .char_indices()
            .nth(1)
            .map(|(index, _)| index)
            .unwrap_or(rest.len());
        output.push_str(&rest[..next]);
        rest = &rest[next..];
    }
    output
}

fn redact_high_entropy_tokens(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        let length = rest
            .find(|character: char| {
                !(character.is_ascii_alphanumeric()
                    || matches!(character, '+' | '/' | '=' | '_' | '-'))
            })
            .unwrap_or(rest.len());
        if length >= 24 {
            let token = &rest[..length];
            let has_upper = token.bytes().any(|byte| byte.is_ascii_uppercase());
            let has_lower = token.bytes().any(|byte| byte.is_ascii_lowercase());
            let has_digit = token.bytes().any(|byte| byte.is_ascii_digit());
            if has_upper && has_lower && has_digit {
                output.push_str("[redacted]");
                rest = &rest[length..];
                continue;
            }
        }
        let next = next_char_len(rest);
        output.push_str(&rest[..next]);
        rest = &rest[next..];
    }
    output
}

/// Catch encoded credential material even when it avoids the ordinary key
/// prefixes. Hex/base32 are common output encodings for a protected file;
/// ROT13 catches simple obfuscation of a recognizable marker such as `sk-` or
/// `bearer`. This is intentionally conservative and only redacts long tokens.
fn redact_encoded_tokens(text: &str) -> String {
    let text = redact_hex_tokens(text);
    let text = redact_base32_tokens(&text);
    redact_rot13_tokens(&text)
}

fn redact_hex_tokens(text: &str) -> String {
    redact_token_runs(text, |token| {
        token.len() >= 32
            && token.len().is_multiple_of(2)
            && token.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn redact_base32_tokens(text: &str) -> String {
    redact_token_runs(text, |token| {
        if token.len() < 24 {
            return false;
        }
        let mut digits = 0;
        let valid = token.bytes().all(|byte| {
            let upper = byte.to_ascii_uppercase();
            if matches!(upper, b'2'..=b'7') {
                digits += 1;
            }
            upper.is_ascii_uppercase() || matches!(upper, b'2'..=b'7') || upper == b'='
        });
        valid && digits >= 2
    })
}

fn redact_rot13_tokens(text: &str) -> String {
    redact_token_runs(text, |token| {
        if token.len() < 16 {
            return false;
        }
        let decoded = token
            .chars()
            .map(|character| match character {
                'a'..='m' => ((character as u8) + 13) as char,
                'n'..='z' => ((character as u8) - 13) as char,
                'A'..='M' => ((character as u8) + 13) as char,
                'N'..='Z' => ((character as u8) - 13) as char,
                _ => character,
            })
            .collect::<String>()
            .to_ascii_lowercase();
        [
            "sk-",
            "bearer",
            "api_key",
            "apikey",
            "secret",
            "password",
            "token",
            "authorization",
        ]
        .iter()
        .any(|marker| decoded.contains(marker))
    })
}

fn redact_token_runs(text: &str, is_secret: impl Fn(&str) -> bool) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        let length = rest
            .find(|character: char| {
                !(character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '='))
            })
            .unwrap_or(rest.len());
        if length > 0 && is_secret(&rest[..length]) {
            output.push_str("[redacted]");
            rest = &rest[length..];
            continue;
        }
        let next = next_char_len(rest);
        output.push_str(&rest[..next]);
        rest = &rest[next..];
    }
    output
}

fn next_char_len(text: &str) -> usize {
    text.char_indices()
        .nth(1)
        .map(|(index, _)| index)
        .unwrap_or(text.len())
}

/// Replace occurrences of `marker` using `decide`, which inspects the text
/// after the marker and returns `(is_secret, replacement, bytes_of_secret)`.
fn replace_each(
    text: &str,
    marker: &str,
    decide: impl Fn(&str) -> (bool, String, usize),
) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(marker) {
        output.push_str(&rest[..start]);
        let after = &rest[start + marker.len()..];
        let (is_secret, replacement, length) = decide(after);
        if is_secret {
            output.push_str(&replacement);
            rest = &after[length..];
        } else {
            output.push_str(&rest[start..start + marker.len()]);
            rest = &rest[start + marker.len()..];
        }
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_and_sk_tokens() {
        let text = "Bearer abcDEF1234567890 and sk-abcdef1234567890abcdef";
        let redacted = redact_secrets(text);
        assert!(redacted.contains("Bearer [redacted]"));
        assert!(redacted.contains("sk-[redacted]"));
        assert!(!redacted.contains("abcDEF1234567890"));
        assert!(!redacted.contains("abcdef1234567890abcdef"));
    }

    #[test]
    fn redacts_authorization_header_entirely() {
        let text = "Authorization: Bearer abcDEF1234567890";
        let redacted = redact_secrets(text);
        assert!(!redacted.contains("abcDEF1234567890"));
        assert!(redacted.contains("[redacted]"));
    }

    #[test]
    fn redacts_key_value_secrets() {
        let text = "api_key = \"sk-secret-value-here\"\npassword= hunter2hunter2";
        let redacted = redact_secrets(text);
        assert!(!redacted.contains("sk-secret-value-here"));
        assert!(!redacted.contains("hunter2hunter2"));
    }

    #[test]
    fn preserves_plain_text_and_short_tokens() {
        let text = "rendered frame: command /status, 200K context budget, no secrets here";
        assert_eq!(redact_secrets(text), text);
    }

    #[test]
    fn redacts_hex_and_base32_encoded_material() {
        let hex = "2f686f6d652f757365722f2e7373682f69645f727361";
        let base32 = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
        let redacted = redact_secrets(&format!("hex={hex} base32={base32}"));
        assert!(!redacted.contains(hex));
        assert!(!redacted.contains(base32));
        assert_eq!(redacted.matches("[redacted]").count(), 2);
    }

    #[test]
    fn redacts_rot13_of_recognizable_secret_marker() {
        let encoded = "fx-fhcre-frperg-gbxra-123456";
        let redacted = redact_secrets(encoded);
        assert!(!redacted.contains(encoded));
        assert!(redacted.contains("[redacted]"));
    }
}
