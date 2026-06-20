use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitEnvironment {
    values: BTreeMap<String, String>,
}

impl GitEnvironment {
    pub fn from_current() -> Self {
        let mut values = std::env::vars().collect::<BTreeMap<_, _>>();
        remove_pager_vars(&mut values);
        Self { values }
    }

    pub fn empty() -> Self {
        Self {
            values: BTreeMap::new(),
        }
    }

    pub fn with_value(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.values.insert(key.into(), value.into());
        self
    }

    pub fn without_value(mut self, key: &str) -> Self {
        self.values.remove(key);
        self
    }

    pub fn command_values(&self, optional_locks: bool) -> BTreeMap<String, String> {
        let mut values = self.values.clone();
        remove_pager_vars(&mut values);
        if optional_locks {
            values.insert("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string());
        }
        values
    }
}

impl Default for GitEnvironment {
    fn default() -> Self {
        Self::from_current()
    }
}

fn remove_pager_vars(values: &mut BTreeMap<String, String>) {
    values.remove("GIT_PAGER");
    values.remove("PAGER");
}

#[cfg(test)]
mod tests {
    use super::GitEnvironment;

    #[test]
    fn removes_pager_variables_and_sets_optional_locks() {
        let env = GitEnvironment::empty()
            .with_value("GIT_PAGER", "less")
            .with_value("PAGER", "less")
            .with_value("PATH", "/bin");

        let values = env.command_values(true);

        assert_eq!(
            values.get("GIT_OPTIONAL_LOCKS").map(String::as_str),
            Some("0")
        );
        assert_eq!(values.get("PATH").map(String::as_str), Some("/bin"));
        assert!(!values.contains_key("GIT_PAGER"));
        assert!(!values.contains_key("PAGER"));
    }
}
