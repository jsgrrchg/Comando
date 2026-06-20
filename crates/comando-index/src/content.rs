use crate::error::{IndexError, IndexResult};

pub fn search_project_content() -> IndexResult<()> {
    Err(IndexError::ContentSearchDisabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_search_is_explicitly_disabled() {
        assert!(matches!(
            search_project_content(),
            Err(IndexError::ContentSearchDisabled)
        ));
    }
}
