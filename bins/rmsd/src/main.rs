use std::io;

use anyhow::Result;
use rmsd::{ServiceOptions, run_service};

fn main() -> Result<()> {
    let mut stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();
    run_service(
        &mut stdin,
        &mut stdout,
        &mut stderr,
        ServiceOptions::from_environment(),
    )
}
