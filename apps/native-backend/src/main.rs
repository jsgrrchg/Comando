use std::io::{self, BufReader};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();

    comando_native_backend::run_stdio(BufReader::new(stdin), stdout.lock())
}
