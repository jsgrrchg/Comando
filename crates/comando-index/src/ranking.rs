use crate::cancellation::CancellationToken;
use crate::entry::IndexedProjectEntry;
use crate::error::{IndexError, IndexResult};
use crate::query::{ProjectSearchQuery, compact_project_search_value};

#[derive(Debug, Clone, PartialEq)]
pub struct SearchMatch {
    pub entry: IndexedProjectEntry,
    pub score: f64,
}

pub fn score_project_search_candidate(
    entry: &IndexedProjectEntry,
    query: &ProjectSearchQuery,
) -> Option<f64> {
    if query.is_empty() {
        return Some(0.0);
    }

    let mut total_score = 0.0_f64;
    for token in query.tokens() {
        let token_score = score_project_search_token(entry, token)?;
        total_score += token_score;
    }

    Some(total_score - entry.depth as f64 * 4.0 - entry.lower_path.len().min(160) as f64 * 0.02)
}

pub fn search_entries(
    entries: &[IndexedProjectEntry],
    query: &ProjectSearchQuery,
    limit: usize,
) -> Vec<SearchMatch> {
    search_entries_cancellable(entries, query, limit, None)
        .expect("uncancelled search should not fail")
}

pub fn search_entries_cancellable(
    entries: &[IndexedProjectEntry],
    query: &ProjectSearchQuery,
    limit: usize,
    cancellation: Option<&CancellationToken>,
) -> IndexResult<Vec<SearchMatch>> {
    if query.is_empty() || query.has_pathological_token() {
        return Ok(Vec::new());
    }

    collect_top_project_search_entries(entries, query, limit.max(1), cancellation)
}

fn score_project_search_token(entry: &IndexedProjectEntry, token: &str) -> Option<f64> {
    let mut score = 0.0_f64;
    let compact_token = compact_project_search_value(token);

    if entry.lower_name == token {
        score += 420.0;
    }

    if entry.lower_path == token {
        score += 390.0;
    }

    if entry.lower_name.starts_with(token) {
        score += 220.0;
    }

    if entry.lower_path.starts_with(token) {
        score += 150.0;
    }

    if let Some(name_index) = entry.lower_name.find(token) {
        score += 190.0 - (name_index * 8).min(80) as f64;
    }

    if let Some(path_index) = entry.lower_path.find(token) {
        score += 120.0 - (path_index * 2).min(70) as f64;
    }

    if !compact_token.is_empty() && is_compact_subsequence(&compact_token, &entry.compact_path) {
        let extra_len = entry.compact_path.len().saturating_sub(compact_token.len());
        score += 70.0 - extra_len.min(28) as f64;
    }

    (score > 0.0).then_some(score)
}

fn collect_top_project_search_entries(
    entries: &[IndexedProjectEntry],
    query: &ProjectSearchQuery,
    limit: usize,
    cancellation: Option<&CancellationToken>,
) -> IndexResult<Vec<SearchMatch>> {
    let mut top_entries = Vec::<SearchMatch>::new();

    for (index, entry) in entries.iter().enumerate() {
        if index % 256 == 0 && cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(IndexError::Cancelled);
        }
        let Some(score) = score_project_search_candidate(entry, query) else {
            continue;
        };
        let candidate = SearchMatch {
            entry: entry.clone(),
            score,
        };
        let worst = top_entries.last();

        if top_entries.len() >= limit
            && worst.is_some_and(|worst| compare_search_matches(&candidate, worst).is_ge())
        {
            continue;
        }

        let insert_index = find_search_insert_index(&top_entries, &candidate);
        top_entries.insert(insert_index, candidate);
        if top_entries.len() > limit {
            top_entries.pop();
        }
    }

    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        return Err(IndexError::Cancelled);
    }

    Ok(top_entries)
}

pub fn compare_search_matches(left: &SearchMatch, right: &SearchMatch) -> std::cmp::Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| {
            left.entry
                .relative_path
                .len()
                .cmp(&right.entry.relative_path.len())
        })
        .then_with(|| locale_like_path_cmp(&left.entry.relative_path, &right.entry.relative_path))
}

fn locale_like_path_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| left.cmp(right))
}

fn find_search_insert_index(entries: &[SearchMatch], candidate: &SearchMatch) -> usize {
    let mut low = 0_usize;
    let mut high = entries.len();

    while low < high {
        let middle = (low + high) / 2;
        if compare_search_matches(candidate, &entries[middle]).is_lt() {
            high = middle;
        } else {
            low = middle + 1;
        }
    }

    low
}

fn is_compact_subsequence(query: &str, target: &str) -> bool {
    if query.is_empty() {
        return true;
    }

    let mut query_chars = query.chars();
    let Some(mut current_query) = query_chars.next() else {
        return true;
    };

    for target_char in target.chars() {
        if target_char == current_query {
            match query_chars.next() {
                Some(next_query) => current_query = next_query,
                None => return true,
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use comando_types::ids::ProjectId;

    use crate::entry::IndexEntryKind;
    use crate::policy::IndexPolicyState;

    use super::*;

    fn entry(relative_path: &str) -> IndexedProjectEntry {
        let name = relative_path.rsplit('/').next().unwrap_or(relative_path);
        IndexedProjectEntry::new(
            ProjectId("project_1".to_string()),
            None,
            name.to_string(),
            relative_path.to_string(),
            IndexEntryKind::File,
            false,
            IndexPolicyState::Indexed,
        )
    }

    #[test]
    fn exact_filename_ranks_before_subsequence_matches() {
        let entries = vec![entry("src/indexer.ts"), entry("src/index.ts")];
        let matches = search_entries(&entries, &ProjectSearchQuery::new("index.ts"), 10);

        assert_eq!(matches[0].entry.relative_path, "src/index.ts");
    }

    #[test]
    fn shallow_paths_win_ties() {
        let entries = vec![entry("a/b/c/d/foo.ts"), entry("foo.ts")];
        let matches = search_entries(&entries, &ProjectSearchQuery::new("foo"), 10);

        assert_eq!(matches[0].entry.relative_path, "foo.ts");
    }

    #[test]
    fn multi_token_requires_all_tokens() {
        let entries = vec![entry("src/file.ts")];

        assert!(search_entries(&entries, &ProjectSearchQuery::new("file missing"), 10).is_empty());
    }

    #[test]
    fn stable_sort_uses_path_length_then_path() {
        let entries = vec![entry("src/beta.ts"), entry("src/alpha.ts")];
        let matches = search_entries(&entries, &ProjectSearchQuery::new("ts"), 10);
        let paths = matches
            .iter()
            .map(|entry| entry.entry.relative_path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["src/beta.ts", "src/alpha.ts"]);
    }

    #[test]
    fn stable_sort_is_case_insensitive_before_original_path() {
        let entries = vec![entry("src/Beta.ts"), entry("src/Alfa.ts")];
        let matches = search_entries(&entries, &ProjectSearchQuery::new("ts"), 10);
        let paths = matches
            .iter()
            .map(|entry| entry.entry.relative_path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["src/Alfa.ts", "src/Beta.ts"]);
    }
}
