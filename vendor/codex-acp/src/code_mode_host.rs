#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!(
            "codex-code-mode-host {}",
            env!("COMANDO_CODEX_RUNTIME_VERSION")
        );
        return Ok(());
    }
    codex_code_mode_host::run_stdio().await
}
