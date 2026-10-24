use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde_json::Value as Json;

const TABLE_JSON: &str = include_str!("../data/xs-start-check-v1.json");
const SUPPORTED_MAJOR: u64 = 1;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum CallClass {
    Pure,
    Random,
    Chat,
    Mocked,
    PreviewRead,
    StartDefault,
    RecordedChange,
    Refused,
}

impl CallClass {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Pure => "pure",
            Self::Random => "random",
            Self::Chat => "chat",
            Self::Mocked => "mocked",
            Self::PreviewRead => "previewRead",
            Self::StartDefault => "startDefault",
            Self::RecordedChange => "recordedChange",
            Self::Refused => "refused",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        [
            Self::Pure,
            Self::Random,
            Self::Chat,
            Self::Mocked,
            Self::PreviewRead,
            Self::StartDefault,
            Self::RecordedChange,
            Self::Refused,
        ]
        .into_iter()
        .find(|class| class.id() == id)
    }

    pub const fn answered_here(self) -> bool {
        matches!(self, Self::Pure | Self::Random)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum UnansweredReason {
    LobbySetting,
    ObjectData,
    TechnologyData,
    TextTable,
    GameRuntime,
    NotInMapScripts,
    UnknownCall,
}

impl UnansweredReason {
    pub const fn id(self) -> &'static str {
        match self {
            Self::LobbySetting => "lobbySetting",
            Self::ObjectData => "objectData",
            Self::TechnologyData => "technologyData",
            Self::TextTable => "textTable",
            Self::GameRuntime => "gameRuntime",
            Self::NotInMapScripts => "notInMapScripts",
            Self::UnknownCall => "unknownCall",
        }
    }

    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::LobbySetting => "LOBBY_SETTING",
            Self::ObjectData => "OBJECT_DATA",
            Self::TechnologyData => "TECHNOLOGY_DATA",
            Self::TextTable => "TEXT_TABLE",
            Self::GameRuntime => "GAME_RUNTIME",
            Self::NotInMapScripts => "NOT_IN_MAP_SCRIPTS",
            Self::UnknownCall => "UNKNOWN_CALL",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        [
            Self::LobbySetting,
            Self::ObjectData,
            Self::TechnologyData,
            Self::TextTable,
            Self::GameRuntime,
            Self::NotInMapScripts,
        ]
        .into_iter()
        .find(|reason| reason.id() == id)
    }

    pub const fn text(self) -> &'static str {
        match self {
            Self::LobbySetting => "the run settings do not hold this lobby value",
            Self::ObjectData => "the IDE does not know values of objects and units",
            Self::TechnologyData => "the IDE does not know technology data",
            Self::TextTable => "the IDE does not have the game's text tables",
            Self::GameRuntime => "this call needs a running match",
            Self::NotInMapScripts => "the game does not offer this call to map scripts",
            Self::UnknownCall => "the IDE does not know this call",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum MockKind {
    Time,
    File,
}

impl MockKind {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Time => "time",
            Self::File => "file",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallEntry {
    pub name: String,
    pub class: CallClass,
    pub reason: Option<UnansweredReason>,
    pub mock: Option<MockKind>,
}

#[derive(Debug)]
pub struct CallTable {
    pub table_id: String,
    pub catalog_id: String,
    entries: Vec<CallEntry>,
    by_name: BTreeMap<String, usize>,
}

impl CallTable {
    pub fn get(&self, name: &str) -> Option<&CallEntry> {
        self.by_name.get(name).map(|index| &self.entries[*index])
    }

    pub fn entries(&self) -> &[CallEntry] {
        &self.entries
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let value: Json = serde_json::from_str(text).map_err(|error| error.to_string())?;
        let object = value
            .as_object()
            .ok_or_else(|| "the call table is not an object".to_owned())?;
        for key in object.keys() {
            if !matches!(
                key.as_str(),
                "schemaVersion" | "tableId" | "catalogId" | "calls"
            ) {
                return Err(format!("unknown call table field {key}"));
            }
        }
        let version = string_field(object, "schemaVersion")?;
        let major = version
            .split('.')
            .next()
            .and_then(|major| major.parse::<u64>().ok())
            .ok_or_else(|| format!("invalid call table version {version}"))?;
        if major != SUPPORTED_MAJOR {
            return Err(format!("unsupported call table schema version {version}"));
        }
        let table_id = string_field(object, "tableId")?.to_owned();
        let catalog_id = string_field(object, "catalogId")?.to_owned();
        let calls = object
            .get("calls")
            .and_then(Json::as_array)
            .ok_or_else(|| "the call table has no calls".to_owned())?;
        let mut entries = Vec::with_capacity(calls.len());
        let mut by_name = BTreeMap::new();
        for call in calls {
            let call = call
                .as_object()
                .ok_or_else(|| "a call table entry is not an object".to_owned())?;
            for key in call.keys() {
                if !matches!(key.as_str(), "name" | "class" | "reason" | "mock") {
                    return Err(format!("unknown call table entry field {key}"));
                }
            }
            let name = string_field(call, "name")?.to_owned();
            let class_id = string_field(call, "class")?;
            let class = CallClass::from_id(class_id)
                .ok_or_else(|| format!("unknown call class {class_id} for {name}"))?;
            let reason = match call.get("reason") {
                None => None,
                Some(reason) => {
                    let id = reason
                        .as_str()
                        .ok_or_else(|| format!("the reason of {name} is not text"))?;
                    Some(
                        UnansweredReason::from_id(id)
                            .ok_or_else(|| format!("unknown reason {id} for {name}"))?,
                    )
                }
            };
            let mock = match call.get("mock") {
                None => None,
                Some(mock) => match mock.as_str() {
                    Some("time") => Some(MockKind::Time),
                    Some("file") => Some(MockKind::File),
                    _ => return Err(format!("unknown stand-in for {name}")),
                },
            };
            if (class == CallClass::Refused) != reason.is_some() {
                return Err(format!(
                    "{name}: only a refused call names a reason, and it must"
                ));
            }
            if (class == CallClass::Mocked) != mock.is_some() {
                return Err(format!(
                    "{name}: only a mocked call names a stand-in, and it must"
                ));
            }
            if by_name.insert(name.clone(), entries.len()).is_some() {
                return Err(format!("{name} is listed twice"));
            }
            entries.push(CallEntry {
                name,
                class,
                reason,
                mock,
            });
        }
        Ok(Self {
            table_id,
            catalog_id,
            entries,
            by_name,
        })
    }
}

fn string_field<'a>(
    object: &'a serde_json::Map<String, Json>,
    key: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Json::as_str)
        .ok_or_else(|| format!("the call table field {key} is missing or not text"))
}

pub fn call_table() -> Result<&'static CallTable, String> {
    static TABLE: OnceLock<Result<CallTable, String>> = OnceLock::new();
    TABLE
        .get_or_init(|| CallTable::parse(TABLE_JSON))
        .as_ref()
        .map_err(Clone::clone)
}
