use std::collections::BTreeSet;
use std::fs;

fn main() {
    println!("cargo:rerun-if-changed=Cargo.toml");
    let manifest = fs::read_to_string("Cargo.toml").expect("read Cargo.toml");
    let versions = manifest
        .lines()
        .filter(|line| line.contains("github.com/openai/codex"))
        .filter_map(|line| line.split("tag = \"rust-v").nth(1))
        .filter_map(|suffix| suffix.split('"').next())
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        versions.len(),
        1,
        "Codex dependencies must use one exact rust-vX.Y.Z tag"
    );
    let version = versions.into_iter().next().expect("Codex runtime version");
    println!("cargo:rustc-env=COMANDO_CODEX_RUNTIME_VERSION={version}");
}
