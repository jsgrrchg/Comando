use std::fs;
use std::io::Read;
use std::path::Path;

use base64::Engine;
use comando_types::fs::NativeFsReadFileInput;
use comando_types::fs::NativeFsReadFileResult;
use sha2::{Digest, Sha256};

use crate::error::FsError;
use crate::path::{ScopedPathIntent, resolve_scoped_path};
use crate::registry::ProjectRoot;
use crate::system_time_to_millis;

pub const INLINE_EDITOR_MAX_BYTES: u64 = 12 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES: u64 = 12 * 1024 * 1024;
const BINARY_PROBE_BYTES: usize = 4096;

pub fn read_file(
    root: &ProjectRoot,
    input: &NativeFsReadFileInput,
) -> Result<NativeFsReadFileResult, FsError> {
    let resolved = resolve_scoped_path(
        &root.root_path,
        Some(input.relative_path.0.as_str()),
        false,
        ScopedPathIntent::ReadExisting,
    )?;
    let metadata = fs::metadata(&resolved.absolute_path)?;
    if metadata.is_dir() {
        return Err(FsError::IsDirectory);
    }

    let max_bytes = input.max_bytes.unwrap_or(INLINE_EDITOR_MAX_BYTES);
    let size_bytes = metadata.len();
    let is_too_large = size_bytes > max_bytes;
    let mime_type = resolve_mime_type(&resolved.absolute_path);
    let is_image = mime_type
        .as_deref()
        .is_some_and(|mime_type| mime_type.starts_with("image/"));
    let probe = read_probe_buffer(&resolved.absolute_path, BINARY_PROBE_BYTES)?;
    let is_binary = !is_image && buffer_looks_binary(&probe);
    let bytes_for_hash = fs::read(&resolved.absolute_path)?;
    let content_hash = Some(hash_content_bytes(&bytes_for_hash));
    let line_ending = (!is_binary && !is_image)
        .then(|| detect_line_ending(&bytes_for_hash))
        .flatten();

    let (kind, content, image_data_base64, encoding) = if is_image {
        if size_bytes > IMAGE_PREVIEW_MAX_BYTES {
            (
                "image".to_string(),
                Some(format!(
                    "This image is {} and exceeds the {} preview limit.",
                    format_byte_size(size_bytes),
                    format_byte_size(IMAGE_PREVIEW_MAX_BYTES)
                )),
                None,
                None,
            )
        } else {
            (
                "image".to_string(),
                Some("Image preview ready.".to_string()),
                Some(base64::engine::general_purpose::STANDARD.encode(&bytes_for_hash)),
                Some("base64".to_string()),
            )
        }
    } else if is_binary {
        (
            "binary".to_string(),
            Some(
                "Binary file preview is not available yet. Open it in the system editor if you need the raw bytes."
                    .to_string(),
            ),
            None,
            None,
        )
    } else if is_too_large {
        (
            "text".to_string(),
            Some(format!(
                "This file is {} and currently exceeds the {} inline editor limit.",
                format_byte_size(size_bytes),
                format_byte_size(max_bytes)
            )),
            None,
            Some("utf8".to_string()),
        )
    } else {
        (
            "text".to_string(),
            Some(String::from_utf8_lossy(&bytes_for_hash).into_owned()),
            None,
            Some("utf8".to_string()),
        )
    };

    Ok(NativeFsReadFileResult {
        project_id: root.project_id.clone(),
        worktree_id: root.worktree_id.clone(),
        path: resolved.absolute_path.to_string_lossy().to_string(),
        relative_path: input.relative_path.clone(),
        name: resolved
            .absolute_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string),
        content,
        encoding,
        line_ending,
        content_hash,
        size_bytes,
        mtime_ms: metadata
            .modified()
            .ok()
            .map(system_time_to_millis)
            .unwrap_or(0),
        mime_type,
        kind: Some(kind),
        image_data_base64,
        is_binary,
        is_too_large,
    })
}

pub fn hash_content_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn resolve_mime_type(path: &Path) -> Option<String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mime_type = match extension.as_str() {
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "jfif" | "jpeg" | "jpg" => "image/jpeg",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "css" | "csv" | "env" | "gitignore" | "html" | "js" | "json" | "jsx" | "md" | "rs"
        | "toml" | "ts" | "tsx" | "txt" | "xml" | "yaml" | "yml" => "text/plain",
        _ => {
            let file_name = path
                .file_name()
                .and_then(|file_name| file_name.to_str())
                .unwrap_or_default();
            if matches!(
                file_name,
                ".env" | ".env.local" | ".gitignore" | ".eslintrc" | "Dockerfile" | "Makefile"
            ) {
                "text/plain"
            } else {
                return None;
            }
        }
    };

    Some(mime_type.to_string())
}

fn read_probe_buffer(path: &Path, byte_length: usize) -> Result<Vec<u8>, FsError> {
    let mut file = fs::File::open(path)?;
    let mut buffer = vec![0; byte_length];
    let bytes_read = file.read(&mut buffer)?;
    buffer.truncate(bytes_read);
    Ok(buffer)
}

fn buffer_looks_binary(buffer: &[u8]) -> bool {
    buffer
        .iter()
        .take(BINARY_PROBE_BYTES)
        .any(|byte| *byte == 0)
}

fn detect_line_ending(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    if text.contains("\r\n") {
        Some("\r\n".to_string())
    } else if text.contains('\n') {
        Some("\n".to_string())
    } else {
        None
    }
}

fn format_byte_size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }

    if bytes < 1024 * 1024 {
        return format!("{:.1} KB", bytes as f64 / 1024.0);
    }

    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use comando_types::fs::NativeFsReadFileInput;
    use tempfile::TempDir;

    use super::*;
    use crate::test_support::project_root;

    #[test]
    fn reads_text_file_with_hash_and_metadata() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("main.rs"), "fn main() {}\n").expect("file");
        let root = project_root(temp.path());

        let result = read_file(
            &root,
            &NativeFsReadFileInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "main.rs".into(),
                max_bytes: None,
            },
        )
        .expect("read");

        assert_eq!(result.content.as_deref(), Some("fn main() {}\n"));
        assert_eq!(result.kind.as_deref(), Some("text"));
        assert_eq!(result.line_ending.as_deref(), Some("\n"));
        assert!(result.content_hash.is_some());
    }

    #[test]
    fn detects_binary_files() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("blob.bin"), b"abc\0def").expect("file");
        let root = project_root(temp.path());

        let result = read_file(
            &root,
            &NativeFsReadFileInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "blob.bin".into(),
                max_bytes: None,
            },
        )
        .expect("read");

        assert!(result.is_binary);
        assert_eq!(result.kind.as_deref(), Some("binary"));
    }

    #[test]
    fn reads_image_preview_as_base64() {
        let temp = TempDir::new().expect("temp");
        fs::write(temp.path().join("pixel.png"), b"not really png").expect("file");
        let root = project_root(temp.path());

        let result = read_file(
            &root,
            &NativeFsReadFileInput {
                project_id: root.project_id.clone(),
                worktree_id: root.worktree_id.clone(),
                relative_path: "pixel.png".into(),
                max_bytes: None,
            },
        )
        .expect("read");

        assert_eq!(result.kind.as_deref(), Some("image"));
        assert!(result.image_data_base64.is_some());
    }
}
