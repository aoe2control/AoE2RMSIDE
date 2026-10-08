use std::io;

use anyhow::Result;
use rms_ls::{ExitReason, run_server_detached};

fn main() -> Result<()> {
    let reason = run_server_detached(
        io::stdin(),
        &mut io::stdout().lock(),
        &mut io::stderr().lock(),
    )?;
    if reason == ExitReason::ExitWithoutShutdown {
        std::process::exit(1);
    }
    Ok(())
}
