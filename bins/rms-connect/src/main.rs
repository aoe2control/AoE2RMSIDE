use std::process::ExitCode;
use std::sync::Arc;

use rms_connect::catalog::{Catalog, PRODUCT_VERSION};
use rms_connect::connect::Connector;
use rms_connect::server_check::ServerPolicy;
use rms_connect::{Command, Outcome, default_ide_data, key_path, parse_arguments, run};

fn main() -> ExitCode {
    let arguments: Vec<String> = match std::env::args_os()
        .skip(1)
        .map(|argument| argument.into_string())
        .collect()
    {
        Ok(arguments) => arguments,
        Err(_) => {
            eprintln!("rms-connect: the arguments are not valid Unicode");
            return ExitCode::from(2);
        }
    };
    let ide_data = match parse_arguments(&arguments) {
        Ok(Command::Version) => {
            println!("rms-connect {PRODUCT_VERSION}");
            return ExitCode::SUCCESS;
        }
        Ok(Command::Serve { ide_data }) => ide_data.or_else(default_ide_data),
        Err(message) => {
            eprintln!("rms-connect: {message}");
            return ExitCode::from(2);
        }
    };
    let catalog = match Catalog::embedded() {
        Ok(catalog) => Arc::new(catalog),
        Err(error) => {
            eprintln!("rms-connect: {error}");
            return ExitCode::from(2);
        }
    };
    let connector = Connector {
        key_path: ide_data.as_deref().map(key_path),
        policy: ServerPolicy::for_this_relay(),
    };
    let outcome = run(
        Box::new(std::io::stdin()),
        std::io::stdout(),
        catalog,
        connector,
    );
    match outcome {
        Outcome::InputClosed => ExitCode::SUCCESS,
        Outcome::IdeUpdating => {
            eprintln!("rms-connect: AoE2RMSIDE is updating; exiting");
            ExitCode::SUCCESS
        }
        Outcome::OutputFailed => ExitCode::from(1),
    }
}
