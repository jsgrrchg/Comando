use std::io;

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();

    comando_native_backend::run_stdio(stdin.lock(), stdout.lock())
}
