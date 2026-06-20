const SECRET_KEY_FRAGMENTS: &[&str] = &[
    "api_key",
    "apikey",
    "auth",
    "bearer",
    "client_secret",
    "cookie",
    "credential",
    "key",
    "password",
    "secret",
    "session",
    "token",
];

const REDACTED: &str = "[redacted]";

pub fn redact_env_key_value(key: &str, value: &str) -> String {
    if is_sensitive_key(key) || looks_like_secret(value) {
        REDACTED.to_string()
    } else {
        value.to_string()
    }
}

pub fn redact_text(text: &str) -> String {
    text.split_whitespace()
        .map(|part| {
            if looks_like_secret(part) {
                REDACTED
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn bound_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }

    let truncated = text.chars().take(max_chars).collect::<String>();
    format!("{truncated}...")
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    SECRET_KEY_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
}

fn looks_like_secret(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() < 20 {
        return false;
    }
    trimmed.starts_with("sk-")
        || trimmed.starts_with("xai-")
        || trimmed.starts_with("ghp_")
        || trimmed.starts_with("gho_")
        || trimmed.starts_with("Bearer ")
        || trimmed
            .chars()
            .filter(|char| char.is_ascii_alphanumeric())
            .count()
            >= 40
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secret_key_values() {
        assert_eq!(redact_env_key_value("OPENAI_API_KEY", "sk-test"), REDACTED);
        assert_eq!(redact_env_key_value("PATH", "/usr/bin"), "/usr/bin");
    }

    #[test]
    fn bounds_text_without_leaking_tail() {
        assert_eq!(bound_text("abcdef", 3), "abc...");
    }
}
