use std::collections::BTreeSet;

use rms_connect_protocol::catalog::{self, CatalogFile, HASH_RULE};
use rms_connect_protocol::{PROTOCOL_MAJOR, is_tool_name};
use serde_json::{Map, Value};
use thiserror::Error;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded.rs"));
}

pub const PRODUCT_VERSION: &str = embedded::PRODUCT_VERSION;

pub const CONNECTOR_TOOLS: &[&str] = &["read_guide"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServedBy {
    Ide,
    Connector,
}

#[derive(Clone, Debug)]
pub struct Tool {
    pub name: String,
    pub served_by: ServedBy,
    pub definition: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    pub stdin_line_bytes: usize,
    pub arguments_json_bytes: usize,
    pub progress_per_second: u32,
}

#[derive(Clone, Debug)]
pub struct PromptArgument {
    pub name: String,
    pub description: String,
    pub required: bool,
    pub max_length: usize,
    pub values: Option<Vec<String>>,
    pub absent: String,
}

#[derive(Clone, Debug)]
pub struct Prompt {
    pub name: String,
    pub title: String,
    pub description: String,
    pub arguments: Vec<PromptArgument>,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct Topic {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct Catalog {
    pub hash: [u8; 32],
    pub tools: Vec<Tool>,
    pub limits: Limits,
    pub prompts: Vec<Prompt>,
    pub instructions: String,
    pub topics: Vec<Topic>,
}

#[derive(Debug, Error, PartialEq)]
pub enum CatalogLoadError {
    #[error("the catalog does not follow its hash rule: {0}")]
    Rule(#[from] catalog::CatalogError),
    #[error("the catalog hash {computed} differs from the recorded {recorded}")]
    HashMismatch { computed: String, recorded: String },
    #[error("the catalog file {0} is missing")]
    Missing(String),
    #[error("the catalog file {file} is not valid: {reason}")]
    Invalid { file: String, reason: String },
}

impl Catalog {
    pub fn embedded() -> Result<Self, CatalogLoadError> {
        let files: Vec<CatalogFile<'_>> = embedded::FILES
            .iter()
            .map(|(path, bytes)| CatalogFile { path, bytes })
            .collect();
        Self::load(embedded::MANIFEST, &files)
    }

    pub fn load(manifest: &[u8], files: &[CatalogFile<'_>]) -> Result<Self, CatalogLoadError> {
        let manifest = json("catalog.json", manifest)?;
        major_one("catalog.json", &manifest)?;
        if manifest.get("hashRule").and_then(Value::as_str) != Some(HASH_RULE) {
            return Err(invalid(
                "catalog.json",
                "hashRule is not the supported rule",
            ));
        }
        let listed: Vec<&str> = manifest
            .get("files")
            .and_then(Value::as_array)
            .map(|files| files.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let embedded: Vec<&str> = files.iter().map(|file| file.path).collect();
        if listed != embedded {
            return Err(invalid(
                "catalog.json",
                "files differ from the embedded files",
            ));
        }
        let hash = catalog::catalog_hash(files)?;
        let computed = hex(&hash);
        let recorded = manifest
            .get("sha256")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if computed != recorded {
            return Err(CatalogLoadError::HashMismatch { computed, recorded });
        }

        let file = |path: &str| -> Result<String, CatalogLoadError> {
            let bytes = files
                .iter()
                .find(|file| file.path == path)
                .ok_or_else(|| CatalogLoadError::Missing(path.to_owned()))?
                .bytes;
            Ok(String::from_utf8_lossy(bytes).replace("\r\n", "\n"))
        };

        let tools_file = json("tools.v1.json", file("tools.v1.json")?.as_bytes())?;
        major_one("tools.v1.json", &tools_file)?;
        let range = tools_file.get("compatibility");
        let minimum = range
            .and_then(|range| range.get("minimumMajor"))
            .and_then(Value::as_u64);
        let maximum = range
            .and_then(|range| range.get("maximumMajor"))
            .and_then(Value::as_u64);
        if !matches!((minimum, maximum), (Some(minimum), Some(maximum))
            if minimum <= u64::from(PROTOCOL_MAJOR) && u64::from(PROTOCOL_MAJOR) <= maximum)
        {
            return Err(invalid(
                "tools.v1.json",
                "compatibility excludes this protocol major",
            ));
        }
        let limits = parse_limits(&tools_file)?;
        let tools = parse_tools(&tools_file)?;

        let prompts_file = json("prompts.json", file("prompts.json")?.as_bytes())?;
        major_one("prompts.json", &prompts_file)?;
        let prompts = parse_prompts(&prompts_file)?;

        let instructions = file("instructions.md")?.trim_end().to_owned();
        if instructions.is_empty() {
            return Err(invalid("instructions.md", "the instructions are empty"));
        }

        let index = json("guide/index.json", file("guide/index.json")?.as_bytes())?;
        major_one("guide/index.json", &index)?;
        let mut topics = Vec::new();
        for entry in array(&index, "topics", "guide/index.json")? {
            let id = text(entry, "id", "guide/index.json")?;
            if id == "topics" || !id.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
                return Err(invalid("guide/index.json", "a topic id is not canonical"));
            }
            topics.push(Topic {
                text: file(&format!("guide/{id}.md"))?,
                id,
                title: text(entry, "title", "guide/index.json")?,
                summary: text(entry, "summary", "guide/index.json")?,
            });
        }
        unique(
            topics.iter().map(|topic| topic.id.as_str()),
            "guide/index.json",
        )?;

        Ok(Self {
            hash,
            tools,
            limits,
            prompts,
            instructions,
            topics,
        })
    }

    pub fn tool(&self, name: &str) -> Option<&Tool> {
        self.tools.iter().find(|tool| tool.name == name)
    }

    pub fn topic(&self, id: &str) -> Option<&Topic> {
        self.topics.iter().find(|topic| topic.id == id)
    }

    pub fn prompt(&self, name: &str) -> Option<&Prompt> {
        self.prompts.iter().find(|prompt| prompt.name == name)
    }
}

fn parse_limits(tools_file: &Value) -> Result<Limits, CatalogLoadError> {
    let limits = tools_file
        .get("limits")
        .ok_or_else(|| invalid("tools.v1.json", "limits are missing"))?;
    let number = |name: &str| -> Result<u64, CatalogLoadError> {
        limits
            .get(name)
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .ok_or_else(|| invalid("tools.v1.json", &format!("limits.{name} is missing")))
    };
    let arguments_json_bytes = number("argumentsJsonBytes")?;
    if arguments_json_bytes != rms_connect_protocol::MAX_ARGUMENTS_JSON_BYTES as u64 {
        return Err(invalid(
            "tools.v1.json",
            "limits.argumentsJsonBytes differs from the protocol",
        ));
    }
    let stdin_line_bytes = number("stdinLineBytes")?;
    let progress_per_second = number("progressPerSecond")?;
    if stdin_line_bytes > 16 * 1024 * 1024 || progress_per_second > 1000 {
        return Err(invalid("tools.v1.json", "a relay limit is out of range"));
    }
    Ok(Limits {
        stdin_line_bytes: stdin_line_bytes as usize,
        arguments_json_bytes: arguments_json_bytes as usize,
        progress_per_second: progress_per_second as u32,
    })
}

fn parse_tools(tools_file: &Value) -> Result<Vec<Tool>, CatalogLoadError> {
    let mut tools = Vec::new();
    for entry in array(tools_file, "tools", "tools.v1.json")? {
        let name = text(entry, "name", "tools.v1.json")?;
        if !is_tool_name(&name) {
            return Err(invalid("tools.v1.json", "a tool name is not canonical"));
        }
        let served_by = match entry.get("servedBy").and_then(Value::as_str) {
            Some("ide") => ServedBy::Ide,
            Some("connector") if CONNECTOR_TOOLS.contains(&name.as_str()) => ServedBy::Connector,
            _ => {
                return Err(invalid(
                    "tools.v1.json",
                    &format!("the relay cannot serve the tool {name}"),
                ));
            }
        };
        let title = text(entry, "title", "tools.v1.json")?;
        let schema = entry
            .get("inputSchema")
            .filter(|schema| schema.get("type").and_then(Value::as_str) == Some("object"))
            .ok_or_else(|| invalid("tools.v1.json", "an input schema is not an object schema"))?;
        let mut annotations = entry
            .get("annotations")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| invalid("tools.v1.json", "a tool has no annotations"))?;
        annotations.insert("title".to_owned(), Value::String(title.clone()));
        let mut definition = Map::new();
        definition.insert("name".to_owned(), Value::String(name.clone()));
        definition.insert("title".to_owned(), Value::String(title));
        definition.insert(
            "description".to_owned(),
            Value::String(text(entry, "description", "tools.v1.json")?),
        );
        definition.insert("inputSchema".to_owned(), schema.clone());
        definition.insert("annotations".to_owned(), Value::Object(annotations));
        tools.push(Tool {
            name,
            served_by,
            definition: Value::Object(definition),
        });
    }
    unique(tools.iter().map(|tool| tool.name.as_str()), "tools.v1.json")?;
    for name in CONNECTOR_TOOLS {
        if !tools
            .iter()
            .any(|tool| tool.name == *name && tool.served_by == ServedBy::Connector)
        {
            return Err(invalid(
                "tools.v1.json",
                &format!("the relay tool {name} is missing"),
            ));
        }
    }
    Ok(tools)
}

fn parse_prompts(prompts_file: &Value) -> Result<Vec<Prompt>, CatalogLoadError> {
    let mut prompts = Vec::new();
    for entry in array(prompts_file, "prompts", "prompts.json")? {
        let mut arguments = Vec::new();
        for argument in array(entry, "arguments", "prompts.json")? {
            let required = argument
                .get("required")
                .and_then(Value::as_bool)
                .ok_or_else(|| invalid("prompts.json", "an argument has no required flag"))?;
            let max_length = argument
                .get("maxLength")
                .and_then(Value::as_u64)
                .filter(|length| (1..=100_000).contains(length))
                .ok_or_else(|| invalid("prompts.json", "an argument has no maxLength"))?;
            let values = match argument.get("values") {
                None => None,
                Some(values) => Some(
                    values
                        .as_array()
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect::<Vec<_>>()
                        })
                        .filter(|values| !values.is_empty())
                        .ok_or_else(|| invalid("prompts.json", "argument values are not texts"))?,
                ),
            };
            let absent = match argument.get("absent").and_then(Value::as_str) {
                Some(absent) => absent.to_owned(),
                None if required => String::new(),
                None => {
                    return Err(invalid(
                        "prompts.json",
                        "an optional argument has no absent text",
                    ));
                }
            };
            arguments.push(PromptArgument {
                name: text(argument, "name", "prompts.json")?,
                description: text(argument, "description", "prompts.json")?,
                required,
                max_length: max_length as usize,
                values,
                absent,
            });
        }
        unique(
            arguments.iter().map(|argument| argument.name.as_str()),
            "prompts.json",
        )?;
        prompts.push(Prompt {
            name: text(entry, "name", "prompts.json")?,
            title: text(entry, "title", "prompts.json")?,
            description: text(entry, "description", "prompts.json")?,
            arguments,
            text: text(entry, "text", "prompts.json")?,
        });
    }
    unique(
        prompts.iter().map(|prompt| prompt.name.as_str()),
        "prompts.json",
    )?;
    Ok(prompts)
}

fn json(file: &str, bytes: &[u8]) -> Result<Value, CatalogLoadError> {
    serde_json::from_slice(bytes).map_err(|error| invalid(file, &error.to_string()))
}

fn major_one(file: &str, value: &Value) -> Result<(), CatalogLoadError> {
    let version = value
        .get("schemaVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() == 3
        && parts[0] == "1"
        && parts[1..]
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        Ok(())
    } else {
        Err(invalid(
            file,
            "schemaVersion is not a supported 1.x version",
        ))
    }
}

fn array<'a>(value: &'a Value, key: &str, file: &str) -> Result<&'a Vec<Value>, CatalogLoadError> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(file, &format!("{key} is not a list")))
}

fn text(value: &Value, key: &str, file: &str) -> Result<String, CatalogLoadError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(file, &format!("{key} is missing")))
}

fn unique<'a>(names: impl Iterator<Item = &'a str>, file: &str) -> Result<(), CatalogLoadError> {
    let mut seen = BTreeSet::new();
    for name in names {
        if !seen.insert(name) {
            return Err(invalid(file, &format!("{name} appears twice")));
        }
    }
    Ok(())
}

fn invalid(file: &str, reason: &str) -> CatalogLoadError {
    CatalogLoadError::Invalid {
        file: file.to_owned(),
        reason: reason.to_owned(),
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
