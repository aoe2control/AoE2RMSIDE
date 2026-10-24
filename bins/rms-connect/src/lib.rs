use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::Arc;
use std::sync::mpsc::{self, Sender};
use std::time::Instant;

use rms_connect_protocol::key::KEY_FILE_RELATIVE_PATH;
use rms_connect_protocol::{FrameError, v1};
use serde_json::Value;

pub mod catalog;
pub mod connect;
pub mod content;
pub mod guide;
pub mod jsonrpc;
pub mod mcp;
pub mod platform;
pub mod prompts;
pub mod relay;
pub mod server_check;

use catalog::{Catalog, PRODUCT_VERSION};
use connect::{Connector, FrameSource};
use mcp::{Action, Server};
use relay::{ConnectFailure, Connected, Out, Relay};

pub const DEFAULT_IDE_DATA_FOLDER: &str = r"@rmside\desktop";
pub const MAX_IDE_DATA_CHARS: usize = 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Command {
    Serve { ide_data: Option<PathBuf> },
    Version,
}

pub fn parse_arguments(arguments: &[String]) -> Result<Command, String> {
    match arguments {
        [] => Ok(Command::Serve { ide_data: None }),
        [flag] if flag == "--version" => Ok(Command::Version),
        [flag, folder] if flag == "--ide-data" => Ok(Command::Serve {
            ide_data: Some(validate_ide_data(folder)?),
        }),
        _ => Err("usage: rms-connect [--ide-data <folder>] | --version".to_owned()),
    }
}

pub fn validate_ide_data(folder: &str) -> Result<PathBuf, String> {
    let folder = folder.replace('/', r"\");
    let folder = folder.as_str();
    let path = PathBuf::from(folder);
    let mut components = path.components();
    let local_drive = matches!(
        components.next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))
    ) && matches!(components.next(), Some(Component::RootDir));
    if folder.chars().count() > MAX_IDE_DATA_CHARS
        || !local_drive
        || folder
            .split('\\')
            .any(|segment| segment == "." || segment == "..")
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(
            "--ide-data must be an absolute folder on a local drive, without . or .. parts"
                .to_owned(),
        );
    }
    Ok(path)
}

pub fn default_ide_data() -> Option<PathBuf> {
    let appdata = PathBuf::from(std::env::var_os("APPDATA")?);
    appdata
        .is_absolute()
        .then(|| appdata.join(DEFAULT_IDE_DATA_FOLDER))
}

pub fn key_path(ide_data: &Path) -> PathBuf {
    KEY_FILE_RELATIVE_PATH
        .split('\\')
        .fold(ide_data.to_path_buf(), |path, segment| path.join(segment))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    InputClosed,
    IdeUpdating,
    OutputFailed,
}

enum Event {
    Line(Vec<u8>),
    LineTooLong,
    InputClosed,
    Connected(u64, Result<Connected, ConnectFailure>),
    Received(u64, Result<v1::Envelope, FrameError>),
}

pub fn run(
    input: Box<dyn Read + Send>,
    mut output: impl Write,
    catalog: Arc<Catalog>,
    connector: Connector,
) -> Outcome {
    let (events, receiver) = mpsc::channel();
    let line_bound = catalog.limits.stdin_line_bytes;
    let reader_events = events.clone();
    std::thread::spawn(move || read_lines(input, line_bound, &reader_events));

    let mut server = Server::new(catalog.clone());
    let mut relay = Relay::new(
        PRODUCT_VERSION,
        catalog.hash,
        launcher_image(),
        catalog.limits.progress_per_second,
    );
    let connector = Arc::new(connector);

    while let Ok(event) = receiver.recv() {
        let outs = match event {
            Event::Line(line) => server
                .handle_line(&line)
                .into_iter()
                .flat_map(|action| match action {
                    Action::Send(message) => vec![Out::Send(message)],
                    Action::Identify { client, revision } => {
                        relay.identify(client, revision);
                        Vec::new()
                    }
                    Action::Connect => relay.connect_hint(),
                    Action::Call(call) => relay.call(call),
                    Action::Cancel(request_id) => relay.cancel(&request_id),
                })
                .collect(),
            Event::LineTooLong => match server.line_too_long() {
                Action::Send(message) => vec![Out::Send(message)],
                _ => Vec::new(),
            },
            Event::InputClosed => {
                relay.shutdown();
                return Outcome::InputClosed;
            }
            Event::Connected(generation, result) => relay.connected(generation, result),
            Event::Received(generation, result) => {
                relay.received(generation, result, Instant::now())
            }
        };
        for out in outs {
            match out {
                Out::Send(message) => {
                    if write_message(&mut output, &message).is_err() {
                        relay.shutdown();
                        return Outcome::OutputFailed;
                    }
                }
                Out::Connect(request) => {
                    let connector = connector.clone();
                    let events = events.clone();
                    std::thread::spawn(move || {
                        let generation = request.generation;
                        match connector.connect(&request) {
                            Ok((connected, source)) => {
                                let _ = events.send(Event::Connected(generation, Ok(connected)));
                                read_envelopes(generation, source, &events);
                            }
                            Err(failure) => {
                                let _ = events.send(Event::Connected(generation, Err(failure)));
                            }
                        }
                    });
                }
                Out::Exit => {
                    relay.shutdown();
                    let _ = output.flush();
                    return Outcome::IdeUpdating;
                }
            }
        }
    }
    Outcome::InputClosed
}

fn write_message(output: &mut impl Write, message: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(message)?;
    line.push(b'\n');
    output.write_all(&line)?;
    output.flush()
}

fn read_envelopes(generation: u64, mut source: Box<dyn FrameSource>, events: &Sender<Event>) {
    loop {
        let result = source.next();
        let end = result.is_err();
        if events.send(Event::Received(generation, result)).is_err() || end {
            return;
        }
    }
}

fn read_lines(input: Box<dyn Read + Send>, bound: usize, events: &Sender<Event>) {
    let mut reader = BufReader::with_capacity(64 * 1024, input);
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let (consumed, complete) = match reader.fill_buf() {
            Ok([]) => {
                if !line.is_empty() && !too_long {
                    let _ = events.send(Event::Line(std::mem::take(&mut line)));
                }
                let _ = events.send(Event::InputClosed);
                return;
            }
            Ok(buffer) => match buffer.iter().position(|byte| *byte == b'\n') {
                Some(end) => {
                    if !too_long {
                        line.extend_from_slice(&buffer[..end]);
                    }
                    (end + 1, true)
                }
                None => {
                    if !too_long {
                        line.extend_from_slice(buffer);
                    }
                    (buffer.len(), false)
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                let _ = events.send(Event::InputClosed);
                return;
            }
        };
        reader.consume(consumed);
        if !too_long && line.len() > bound {
            too_long = true;
            line = Vec::new();
        }
        if complete {
            let event = if too_long {
                Event::LineTooLong
            } else {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.iter().all(u8::is_ascii_whitespace) {
                    line.clear();
                    continue;
                }
                Event::Line(std::mem::take(&mut line))
            };
            too_long = false;
            if events.send(event).is_err() {
                return;
            }
        }
    }
}

fn launcher_image() -> String {
    let name = mcp::display_text(
        &platform::parent_image_name(),
        rms_connect_protocol::MAX_LAUNCHER_IMAGE_CHARS,
    );
    if name.contains(['\\', '/', ':']) {
        String::new()
    } else {
        name
    }
}
