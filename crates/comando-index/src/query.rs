const PATH_SEPARATOR_CHARS: &[char] = &['/', '_', '.', '-', ' ', '\t', '\n', '\r'];
const MAX_PROJECT_SEARCH_TOKEN_LENGTH: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSearchQuery {
    normalized: String,
    tokens: Vec<String>,
}

impl ProjectSearchQuery {
    pub fn new(query: &str) -> Self {
        let normalized = normalize_project_search_query(query);
        let tokens = normalized
            .split_whitespace()
            .filter(|token| !token.is_empty())
            .map(str::to_string)
            .collect();

        Self { normalized, tokens }
    }

    pub fn normalized(&self) -> &str {
        &self.normalized
    }

    pub fn tokens(&self) -> &[String] {
        &self.tokens
    }

    pub fn is_empty(&self) -> bool {
        self.normalized.is_empty()
    }

    pub fn has_pathological_token(&self) -> bool {
        self.tokens
            .iter()
            .any(|token| token.len() > MAX_PROJECT_SEARCH_TOKEN_LENGTH)
    }
}

pub fn normalize_project_search_query(query: &str) -> String {
    query.trim().to_lowercase()
}

pub fn compact_project_search_value(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|value| !PATH_SEPARATOR_CHARS.contains(value))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_path_lowercases_and_removes_separators() {
        assert_eq!(
            compact_project_search_value("Path/To_File.name"),
            "pathtofilename"
        );
    }

    #[test]
    fn normalizes_query() {
        assert_eq!(normalize_project_search_query("  HELLO  "), "hello");
    }

    #[test]
    fn rejects_long_tokens() {
        let query = ProjectSearchQuery::new(&"a".repeat(201));

        assert!(query.has_pathological_token());
    }
}
