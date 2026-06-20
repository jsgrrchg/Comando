use std::path::Path;

pub fn redact_path(path: &Path) -> String {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("<unknown>");
    format!("<redacted>/{file_name}")
}
