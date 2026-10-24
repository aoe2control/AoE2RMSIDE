use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, OnceLock};

use rms_source::{ByteRange, SourceId};
use serde_json::Value as Json;

use crate::table::{CallClass, UnansweredReason};
use crate::text::number_text;
use crate::{FindingSeverity, HostAnswer, HostCall, HostNote, Program, Topic, Unanswered, Value};

pub const MAXIMUM_CHAT_LINES: usize = 1_000;
pub const MAXIMUM_CHAT_BYTES: usize = 2_048;
pub const MAXIMUM_REPORT_CHANGES: usize = 1_000;
pub const MAXIMUM_RECORDED_CALLS: usize = 5_000;
pub const MAXIMUM_VALUE_TEXT_BYTES: usize = 256;
const MAXIMUM_FILE_BYTES: usize = 1024 * 1024;
const CLASS_ID_OFFSET: i32 = 900;
const INVALID_VECTOR: [f32; 3] = [-1.0, -1.0, -1.0];

const COUNTS_JSON: &str = include_str!("../data/xs-technology-counts-v1.json");
const COUNTS_MAJOR: u64 = 1;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TechnologyCounts {
    counts: BTreeMap<String, i32>,
}

impl TechnologyCounts {
    pub fn get(&self, content_pack_id: &str) -> Option<i32> {
        self.counts.get(content_pack_id).copied()
    }

    fn parse(text: &str) -> Result<Self, String> {
        let json: Json =
            serde_json::from_str(text).map_err(|error| format!("not JSON: {error}"))?;
        let object = json.as_object().ok_or("the table is not an object")?;
        for key in object.keys() {
            if !matches!(key.as_str(), "schemaVersion" | "tableId" | "counts") {
                return Err(format!("unknown field {key}"));
            }
        }
        let version = object
            .get("schemaVersion")
            .and_then(Json::as_str)
            .ok_or("schemaVersion is missing")?;
        let major = version
            .split('.')
            .next()
            .and_then(|major| major.parse::<u64>().ok())
            .ok_or("schemaVersion is not a version")?;
        if major != COUNTS_MAJOR {
            return Err(format!("schema {version} is not supported"));
        }
        if object.get("tableId").and_then(Json::as_str) != Some("aoe2de-xs-technology-counts-v1") {
            return Err("tableId is not aoe2de-xs-technology-counts-v1".to_owned());
        }
        let mut counts = BTreeMap::new();
        for entry in object
            .get("counts")
            .and_then(Json::as_array)
            .ok_or("counts is missing")?
        {
            let entry = entry.as_object().ok_or("a count is not an object")?;
            for key in entry.keys() {
                if !matches!(key.as_str(), "contentPackId" | "technologyCount") {
                    return Err(format!("unknown count field {key}"));
                }
            }
            let pack = entry
                .get("contentPackId")
                .and_then(Json::as_str)
                .filter(|pack| !pack.is_empty())
                .ok_or("a count has no contentPackId")?;
            let count = entry
                .get("technologyCount")
                .and_then(Json::as_i64)
                .and_then(|count| i32::try_from(count).ok())
                .filter(|count| (1..=65_535).contains(count))
                .ok_or("a technologyCount is not 1 to 65535")?;
            if counts.insert(pack.to_owned(), count).is_some() {
                return Err(format!("{pack} is listed twice"));
            }
        }
        Ok(Self { counts })
    }
}

pub fn technology_counts() -> Result<&'static TechnologyCounts, String> {
    static TABLE: OnceLock<Result<TechnologyCounts, String>> = OnceLock::new();
    TABLE
        .get_or_init(|| TechnologyCounts::parse(COUNTS_JSON))
        .as_ref()
        .map_err(Clone::clone)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreviewPlayer {
    pub number: i32,
    pub team: u8,
    pub civilization: i32,
    pub color: i32,
    pub computer: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreviewUnit {
    pub id: i32,
    pub object_id: i32,
    pub owner: i32,
    pub position: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
pub struct PreviewTiles<'a> {
    pub width: usize,
    pub height: usize,
    pub terrain: &'a [u32],
    pub elevation: &'a [i16],
    pub layer: &'a [u16],
}

#[derive(Clone, Debug)]
pub struct PreviewState<'a> {
    pub map_width: i32,
    pub map_height: i32,
    pub map_seed: i32,
    pub map_file_name: String,
    pub players: Vec<PreviewPlayer>,
    pub units: Vec<PreviewUnit>,
    pub object_classes: BTreeMap<i32, i32>,
    pub tiles: Option<PreviewTiles<'a>>,
    pub technology_count: Option<i32>,
    pub game_mode_adds_objects: bool,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ChangeKind {
    Other,
    Resource,
    Technology,
    Diplomacy,
    PlayerName,
    CivilizationName,
    PlayerColor,
    ColorMood,
    UnitsCreated,
    UnitsRemoved,
    UnitsMoved,
    UnitsOwnerChanged,
    UnitValues,
    UnitText,
    ObjectData,
    TechnologyData,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Operation {
    None,
    Set,
    Add,
    Multiply,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StartChange {
    pub player: u32,
    pub kind: ChangeKind,
    pub target_id: i32,
    pub target_constant: String,
    pub operation: Operation,
    pub amount: f32,
    pub count: u32,
    pub position: Option<[f32; 3]>,
    pub text: String,
    pub value_id: i32,
    pub calls: u32,
    pub call: String,
    pub source_id: Option<SourceId>,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChatLine {
    pub text: String,
    pub call: String,
    pub source_id: Option<SourceId>,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RecordedCall {
    pub name: String,
    pub args: Vec<Value>,
    pub result: Option<Value>,
    pub source_id: Option<SourceId>,
    pub range: ByteRange,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct HostRecord {
    pub chat_lines: Vec<ChatLine>,
    pub omitted_chat_lines: u32,
    pub changes: Vec<StartChange>,
    pub omitted_changes: u32,
    pub recorded_calls: Vec<RecordedCall>,
    pub omitted_recorded_calls: u32,
}

pub fn bounded_text(text: &str, bytes: usize) -> String {
    if text.len() <= bytes {
        return text.to_owned();
    }
    let mut end = bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[derive(Default)]
struct MemoryFile {
    bytes: Vec<u8>,
    created: bool,
    open: bool,
    position: usize,
}

type ChangeKey = (u32, ChangeKind, i32, Operation, i32);

pub struct PreviewHost<'a> {
    state: &'a PreviewState<'a>,
    units: Vec<PreviewUnit>,
    unit_index: HashMap<i32, usize>,
    removed: Vec<bool>,
    next_unit_id: i32,
    attribute_names: BTreeMap<i32, Vec<String>>,
    record: HostRecord,
    change_index: HashMap<ChangeKey, usize>,
    row_units: Vec<BTreeSet<i32>>,
    notes: Vec<HostNote>,
    game_mode_noted: bool,
    file: MemoryFile,
}

impl<'a> PreviewHost<'a> {
    pub fn new(state: &'a PreviewState<'a>, program: &Program) -> Self {
        let mut units = state.units.clone();
        units.sort_by_key(|unit| unit.id);
        units.dedup_by_key(|unit| unit.id);
        let unit_index = units
            .iter()
            .enumerate()
            .map(|(index, unit)| (unit.id, index))
            .collect();
        let next_unit_id = units
            .iter()
            .map(|unit| unit.id)
            .max()
            .map_or(0, |id| id.saturating_add(1));
        Self {
            state,
            removed: vec![false; units.len()],
            units,
            unit_index,
            next_unit_id,
            attribute_names: resource_names(program),
            record: HostRecord::default(),
            change_index: HashMap::new(),
            row_units: Vec::new(),
            notes: Vec::new(),
            game_mode_noted: false,
            file: MemoryFile::default(),
        }
    }

    pub fn into_record(self) -> HostRecord {
        self.record
    }

    pub fn unanswerable_calls(&self, program: &Program) -> Vec<String> {
        let table = crate::call_table().ok();
        program
            .called_builtins()
            .iter()
            .filter(|name| {
                let class = table
                    .and_then(|table| table.get(name))
                    .map_or(CallClass::Refused, |entry| entry.class);
                class == CallClass::Refused
                    && !(name.as_str() == "xsGetPlayerNumberOfTechs"
                        && self.state.technology_count.is_some())
            })
            .cloned()
            .collect()
    }

    fn player(&self, number: i32) -> Option<&PreviewPlayer> {
        self.state
            .players
            .iter()
            .find(|player| player.number == number)
    }

    fn is_player(&self, number: i32) -> bool {
        number == 0 || self.player(number).is_some()
    }

    fn unit(&self, id: i32) -> Option<&PreviewUnit> {
        let index = *self.unit_index.get(&id)?;
        (!self.removed[index]).then(|| &self.units[index])
    }

    fn class_of(&self, object_id: i32) -> Option<i32> {
        self.state.object_classes.get(&object_id).copied()
    }

    fn matches(&self, unit: &PreviewUnit, object_or_class: i32) -> bool {
        if (CLASS_ID_OFFSET..CLASS_ID_OFFSET + 100).contains(&object_or_class) {
            self.class_of(unit.object_id) == Some(object_or_class - CLASS_ID_OFFSET)
        } else {
            unit.object_id == object_or_class
        }
    }

    fn live_units(&self) -> impl Iterator<Item = &PreviewUnit> {
        self.units
            .iter()
            .zip(&self.removed)
            .filter(|(_, removed)| !**removed)
            .map(|(unit, _)| unit)
    }

    fn note_game_mode_objects(&mut self) {
        if self.state.game_mode_adds_objects && !self.game_mode_noted {
            self.game_mode_noted = true;
            self.notes.push(HostNote::Finding {
                code: "XS5021",
                severity: FindingSeverity::Information,
                message: "Objects that the selected game mode adds at start are not in the preview"
                    .to_owned(),
                arguments: Vec::new(),
            });
        }
    }

    fn tile_attribute(&self, x: i32, y: i32, attribute: i32) -> HostAnswer {
        let Some(tiles) = self.state.tiles else {
            return HostAnswer::Value(Value::Int(-1));
        };
        let (Ok(x), Ok(y)) = (usize::try_from(x), usize::try_from(y)) else {
            return HostAnswer::Value(Value::Int(-1));
        };
        if x >= tiles.width || y >= tiles.height {
            return HostAnswer::Value(Value::Int(-1));
        }
        let index = y * tiles.width + x;
        let value = match attribute {
            0 => tiles.terrain.get(index).map(|value| *value as i32),
            1 => tiles.elevation.get(index).map(|value| i32::from(*value)),
            3 => tiles.layer.get(index).map(|value| i32::from(*value)),
            2 => {
                return HostAnswer::Unanswered(Unanswered::Reason(UnansweredReason::GameRuntime));
            }
            _ => None,
        };
        HostAnswer::Value(Value::Int(value.unwrap_or(-1)))
    }

    fn record_call(&mut self, call: &HostCall<'_>, result: Option<Value>) {
        if self.record.recorded_calls.len() >= MAXIMUM_RECORDED_CALLS {
            self.record.omitted_recorded_calls =
                self.record.omitted_recorded_calls.saturating_add(1);
            return;
        }
        self.record.recorded_calls.push(RecordedCall {
            name: call.name.to_owned(),
            args: call.args.iter().map(bounded_value).collect(),
            result: result.map(|value| bounded_value(&value)),
            source_id: call.source_id.cloned(),
            range: call.range,
        });
    }

    fn chat(&mut self, call: &HostCall<'_>, text: String) {
        if self.record.chat_lines.len() >= MAXIMUM_CHAT_LINES {
            self.record.omitted_chat_lines = self.record.omitted_chat_lines.saturating_add(1);
            return;
        }
        self.record.chat_lines.push(ChatLine {
            text: bounded_text(&text, MAXIMUM_CHAT_BYTES),
            call: call.name.to_owned(),
            source_id: call.source_id.cloned(),
            range: call.range,
        });
    }

    fn change(&mut self, call: &HostCall<'_>, change: ChangeInput) {
        let Ok(player) = u32::try_from(change.player) else {
            return;
        };
        let key_operation = if change.kind == ChangeKind::Resource {
            change.operation
        } else {
            Operation::None
        };
        let key_value = if change.kind == ChangeKind::UnitsOwnerChanged {
            change.value_id
        } else {
            0
        };
        let key = (
            player,
            change.kind,
            change.target_id,
            key_operation,
            key_value,
        );
        if let Some(index) = self.change_index.get(&key).copied() {
            let row = &mut self.record.changes[index];
            row.calls = row.calls.saturating_add(1);
            let new_unit = change
                .unit
                .is_none_or(|unit| self.row_units[index].insert(unit));
            if new_unit {
                row.count = row.count.saturating_add(change.count);
            }
            match change.operation {
                Operation::Add => row.amount += change.amount,
                Operation::Multiply => row.amount *= change.amount,
                Operation::Set | Operation::None => row.amount = change.amount,
            }
            if row.kind != ChangeKind::Resource {
                row.operation = change.operation;
            }
            if change.text.is_some() {
                row.text = change.text.unwrap_or_default();
            }
            if row.kind != ChangeKind::UnitsOwnerChanged {
                row.value_id = change.value_id;
            }
            if row.position.is_none() {
                row.position = change.position;
            }
            return;
        }
        if self.record.changes.len() >= MAXIMUM_REPORT_CHANGES {
            self.record.omitted_changes = self.record.omitted_changes.saturating_add(1);
            return;
        }
        let target_constant = if change.kind == ChangeKind::Resource {
            match self.attribute_names.get(&change.target_id) {
                Some(names) if names.len() == 1 => names[0].clone(),
                _ => String::new(),
            }
        } else {
            String::new()
        };
        self.change_index.insert(key, self.record.changes.len());
        self.row_units.push(change.unit.into_iter().collect());
        self.record.changes.push(StartChange {
            player,
            kind: change.kind,
            target_id: change.target_id,
            target_constant,
            operation: change.operation,
            amount: change.amount,
            count: change.count,
            position: change.position,
            text: change.text.unwrap_or_default(),
            value_id: change.value_id,
            calls: 1,
            call: call.name.to_owned(),
            source_id: call.source_id.cloned(),
            range: call.range,
        });
    }

    fn change_player(&mut self, call: &HostCall<'_>, player: i32) -> i32 {
        if player >= 0 {
            return player;
        }
        match call.context_player {
            Some(player) => player,
            None => {
                self.notes.push(HostNote::Topic(Topic::StartDefaults));
                0
            }
        }
    }

    fn answer_chat(&mut self, call: &HostCall<'_>) -> HostAnswer {
        let text = text_arg(call.args, 0);
        match call.name {
            "xsChatData" => {
                let value = int_arg(call.args, 1);
                let line = match text.find("%d") {
                    Some(at) => {
                        self.notes.push(HostNote::Topic(Topic::NumberText));
                        format!("{}{value}{}", &text[..at], &text[at + 2..])
                    }
                    None => text,
                };
                self.chat(call, line);
                HostAnswer::Void
            }
            _ => {
                self.chat(call, text);
                HostAnswer::Value(Value::Bool(true))
            }
        }
    }

    fn answer_mocked(&mut self, call: &HostCall<'_>) -> HostAnswer {
        let answer = match call.name {
            "xsGetTime" | "xsGetGameTime" | "xsGetWorldTime" | "xsGetTurn" => Value::Int(0),
            _ => self.file_call(call),
        };
        self.record_call(call, Some(answer.clone()));
        HostAnswer::Value(answer)
    }

    fn file_call(&mut self, call: &HostCall<'_>) -> Value {
        let file = &mut self.file;
        let write = |file: &mut MemoryFile, bytes: &[u8]| {
            if !file.open || file.position + bytes.len() > MAXIMUM_FILE_BYTES {
                return Value::Bool(false);
            }
            let end = file.position + bytes.len();
            if file.bytes.len() < end {
                file.bytes.resize(end, 0);
            }
            file.bytes[file.position..end].copy_from_slice(bytes);
            file.position = end;
            Value::Bool(true)
        };
        let read = |file: &mut MemoryFile, length: usize| -> Option<Vec<u8>> {
            if !file.open || file.position + length > file.bytes.len() {
                return None;
            }
            let bytes = file.bytes[file.position..file.position + length].to_vec();
            file.position += length;
            Some(bytes)
        };
        match call.name {
            "xsCreateFile" => {
                let append = bool_arg(call.args, 0);
                if !append {
                    file.bytes.clear();
                }
                file.created = true;
                file.open = true;
                file.position = file.bytes.len();
                Value::Bool(true)
            }
            "xsOpenFile" => {
                file.open = file.created;
                file.position = 0;
                Value::Bool(file.open)
            }
            "xsCloseFile" => {
                let was_open = file.open;
                file.open = false;
                Value::Bool(was_open)
            }
            "xsGetFilePosition" => Value::Int(if file.open { file.position as i32 } else { -1 }),
            "xsGetFileSize" => Value::Int(if file.open {
                file.bytes.len() as i32
            } else {
                -1
            }),
            "xsSetFilePosition" | "xsOffsetFilePosition" => {
                let amount = int_arg(call.args, 0);
                let base = if call.name == "xsSetFilePosition" {
                    0
                } else {
                    file.position as i64
                };
                let target = base + i64::from(amount);
                if !file.open || target < 0 || target > file.bytes.len() as i64 {
                    Value::Bool(false)
                } else {
                    file.position = target as usize;
                    Value::Bool(true)
                }
            }
            "xsGetDataTypeSize" => Value::Int(match int_arg(call.args, 0) {
                0 | 1 => 4,
                2 => 1,
                4 => 12,
                _ => -1,
            }),
            "xsWriteInt" => write(file, &int_arg(call.args, 0).to_le_bytes()),
            "xsWriteFloat" => write(file, &float_arg(call.args, 0).to_le_bytes()),
            "xsWriteVector" => {
                let [x, y, z] = vector_arg(call.args, 0);
                let mut bytes = Vec::with_capacity(12);
                for part in [x, y, z] {
                    bytes.extend_from_slice(&part.to_le_bytes());
                }
                write(file, &bytes)
            }
            "xsWriteString" => {
                let text = call
                    .args
                    .first()
                    .and_then(Value::as_bytes)
                    .unwrap_or_default();
                let mut bytes = Vec::with_capacity(text.len() + 4);
                bytes.extend_from_slice(&(text.len() as i32).to_le_bytes());
                bytes.extend_from_slice(text);
                write(file, &bytes)
            }
            "xsReadInt" => {
                Value::Int(read(file, 4).map_or(-1, |bytes| i32::from_le_bytes(four(&bytes))))
            }
            "xsReadFloat" => {
                Value::Float(read(file, 4).map_or(-1.0, |bytes| f32::from_le_bytes(four(&bytes))))
            }
            "xsReadVector" => Value::Vector(read(file, 12).map_or(INVALID_VECTOR, |bytes| {
                [
                    f32::from_le_bytes(four(&bytes[0..4])),
                    f32::from_le_bytes(four(&bytes[4..8])),
                    f32::from_le_bytes(four(&bytes[8..12])),
                ]
            })),
            "xsReadString" => {
                let start = file.position;
                let text = read(file, 4)
                    .map(|bytes| i32::from_le_bytes(four(&bytes)))
                    .and_then(|length| usize::try_from(length).ok())
                    .and_then(|length| read(file, length));
                match text {
                    Some(text) => Value::bytes(&text),
                    None => {
                        file.position = start;
                        Value::text("")
                    }
                }
            }
            _ => Value::Void,
        }
    }

    fn answer_preview_read(&mut self, call: &HostCall<'_>) -> HostAnswer {
        let args = call.args;
        let value = match call.name {
            "xsGetMapWidth" => Value::Int(self.state.map_width),
            "xsGetMapHeight" => Value::Int(self.state.map_height),
            "xsGetMapSeed" => Value::Int(self.state.map_seed),
            "xsGetMapName" => {
                let name = &self.state.map_file_name;
                if bool_arg(args, 0) {
                    Value::text(name)
                } else {
                    Value::text(
                        name.rsplit_once('.')
                            .map_or(name.as_str(), |(stem, _)| stem),
                    )
                }
            }
            "xsGetNumPlayers" => Value::Int(self.state.players.len() as i32),
            "xsGetPlayerInGame" => Value::Bool(self.is_player(int_arg(args, 0))),
            "xsGetPlayerCivilization" => Value::Int(match int_arg(args, 0) {
                0 => 0,
                number => self.player(number).map_or(-1, |player| player.civilization),
            }),
            "xsGetPlayerColor" => Value::Int(
                self.player(int_arg(args, 0))
                    .map_or(-1, |player| player.color),
            ),
            "xsGetPlayerType" => Value::Int(match int_arg(args, 0) {
                0 => 2,
                number => match self.player(number) {
                    Some(player) if player.computer => 3,
                    Some(_) => 1,
                    None => -1,
                },
            }),
            "xsGetWorldPlayerId" => {
                let number = int_arg(args, 0);
                Value::Int(if self.is_player(number) { number } else { -1 })
            }
            "xsGetDiplomacy" => {
                let (source, target) = (int_arg(args, 0), int_arg(args, 1));
                Value::Int(if !self.is_player(source) || !self.is_player(target) {
                    -1
                } else if source == target {
                    0
                } else if source == 0 || target == 0 {
                    3
                } else {
                    let team = |number| self.player(number).map_or(0, |player| player.team);
                    if team(source) != 0 && team(source) == team(target) {
                        0
                    } else {
                        3
                    }
                })
            }
            "xsGetMapTileAttribute" => {
                return self.tile_attribute(int_arg(args, 0), int_arg(args, 1), int_arg(args, 2));
            }
            "xsIsObjectValid" => Value::Bool(self.class_of(int_arg(args, 0)).is_some()),
            "xsGetPlayerUnitIds" => {
                self.note_game_mode_objects();
                let (player, object) = (int_arg(args, 0), int_arg(args, 1));
                let items = self
                    .live_units()
                    .filter(|unit| unit.owner == player && self.matches(unit, object))
                    .map(|unit| unit.id)
                    .collect();
                return HostAnswer::IntArray {
                    array: int_arg(args, 2),
                    items,
                };
            }
            "xsGetObjectClass" => Value::Int(
                self.class_of(int_arg(args, 1))
                    .map_or(-1, |class| class + CLASS_ID_OFFSET),
            ),
            _ => {
                self.note_game_mode_objects();
                self.unit_read(call)
            }
        };
        HostAnswer::Value(value)
    }

    fn unit_read(&mut self, call: &HostCall<'_>) -> Value {
        let args = call.args;
        match call.name {
            "xsGetObjectCount" | "xsGetObjectCountTotal" => {
                let (player, object) = (int_arg(args, 0), int_arg(args, 1));
                Value::Int(
                    self.live_units()
                        .filter(|unit| unit.owner == player && self.matches(unit, object))
                        .count() as i32,
                )
            }
            "xsGetPlayerNumberOfObjects" => {
                let player = int_arg(args, 0);
                Value::Int(
                    self.live_units()
                        .filter(|unit| unit.owner == player)
                        .count() as i32,
                )
            }
            "xsDoesUnitExist" => Value::Bool(self.unit(int_arg(args, 0)).is_some()),
            "xsGetUnitObjectId" => Value::Int(
                self.unit(int_arg(args, 0))
                    .map_or(-1, |unit| unit.object_id),
            ),
            "xsGetUnitOwner" => {
                Value::Int(self.unit(int_arg(args, 0)).map_or(-1, |unit| unit.owner))
            }
            "xsGetUnitPosition" => Value::Vector(
                self.unit(int_arg(args, 0))
                    .map_or(INVALID_VECTOR, |unit| unit.position),
            ),
            "xsGetUnitClass" => Value::Int(
                self.unit(int_arg(args, 0))
                    .and_then(|unit| self.class_of(unit.object_id))
                    .map_or(-1, |class| class + CLASS_ID_OFFSET),
            ),
            _ => Value::Void,
        }
    }

    fn answer_start_default(&mut self, call: &HostCall<'_>) -> HostAnswer {
        self.note_game_mode_objects();
        let answer = match call.name {
            "xsGetGarrisonedUnitIds" => {
                self.record_call(call, None);
                return HostAnswer::IntArray {
                    array: -1,
                    items: Vec::new(),
                };
            }
            "xsGetGroupMoveTarget" | "xsGetUnitGatherPoint" | "xsGetUnitMoveTarget" => {
                Value::Vector(INVALID_VECTOR)
            }
            _ => Value::Int(-1),
        };
        self.record_call(call, Some(answer.clone()));
        HostAnswer::Value(answer)
    }

    fn answer_change(&mut self, call: &HostCall<'_>) -> HostAnswer {
        let args = call.args;
        let result = match call.name {
            "xsEffectAmount" => {
                self.effect_amount(call);
                None
            }
            "xsResearchTechnology" => {
                let player = self.change_player(call, int_arg(args, 3));
                let valid = self.is_player(player) && int_arg(args, 0) >= 0;
                if valid {
                    self.change(
                        call,
                        ChangeInput::new(player, ChangeKind::Technology, int_arg(args, 0)),
                    );
                }
                Some(Value::Bool(valid))
            }
            "xsSetPlayerAttribute" => {
                let player = self.change_player(call, int_arg(args, 0));
                if self.is_player(player) {
                    self.change(
                        call,
                        ChangeInput {
                            operation: Operation::Set,
                            amount: float_arg(args, 2),
                            ..ChangeInput::new(player, ChangeKind::Resource, int_arg(args, 1))
                        },
                    );
                }
                None
            }
            "xsSetDiplomacy" => {
                let (source, target, stance) =
                    (int_arg(args, 0), int_arg(args, 1), int_arg(args, 2));
                let valid = self.is_player(source) && self.is_player(target);
                if valid {
                    self.change(
                        call,
                        ChangeInput {
                            value_id: stance,
                            ..ChangeInput::new(source, ChangeKind::Diplomacy, target)
                        },
                    );
                    if bool_arg(args, 3) {
                        self.change(
                            call,
                            ChangeInput {
                                value_id: stance,
                                ..ChangeInput::new(target, ChangeKind::Diplomacy, source)
                            },
                        );
                    }
                }
                Some(Value::Bool(valid))
            }
            "xsSetPlayerName" | "xsSetPlayerCivName" => {
                let player = int_arg(args, 0);
                let kind = if call.name == "xsSetPlayerName" {
                    ChangeKind::PlayerName
                } else {
                    ChangeKind::CivilizationName
                };
                let valid = self.is_player(player);
                if valid {
                    self.change(
                        call,
                        ChangeInput {
                            text: Some(bounded_text(&text_arg(args, 1), MAXIMUM_VALUE_TEXT_BYTES)),
                            ..ChangeInput::new(player, kind, 0)
                        },
                    );
                }
                Some(Value::Bool(valid))
            }
            "xsSetPlayerColor" => {
                let player = int_arg(args, 0);
                let valid = self.is_player(player);
                if valid {
                    self.change(
                        call,
                        ChangeInput {
                            value_id: int_arg(args, 1),
                            ..ChangeInput::new(player, ChangeKind::PlayerColor, 0)
                        },
                    );
                }
                Some(Value::Bool(valid))
            }
            "xsSetColorMood" => {
                self.change(
                    call,
                    ChangeInput {
                        value_id: int_arg(args, 0),
                        ..ChangeInput::new(0, ChangeKind::ColorMood, 0)
                    },
                );
                Some(Value::Bool(true))
            }
            "xsSetObjectDescription" => {
                let player = self.change_player(call, int_arg(args, 0));
                let object = int_arg(args, 1);
                let valid = self.is_player(player) && self.class_of(object).is_some();
                if valid {
                    self.change(
                        call,
                        ChangeInput {
                            text: Some(bounded_text(&text_arg(args, 2), MAXIMUM_VALUE_TEXT_BYTES)),
                            ..ChangeInput::new(player, ChangeKind::ObjectData, object)
                        },
                    );
                }
                Some(Value::Bool(valid))
            }
            "xsSetTechName" | "xsSetTechDescription" => {
                let player = self.change_player(call, int_arg(args, 1));
                let valid = self.is_player(player) && int_arg(args, 0) >= 0;
                if valid {
                    self.change(
                        call,
                        ChangeInput {
                            text: Some(bounded_text(&text_arg(args, 2), MAXIMUM_VALUE_TEXT_BYTES)),
                            ..ChangeInput::new(player, ChangeKind::TechnologyData, int_arg(args, 0))
                        },
                    );
                }
                Some(Value::Bool(valid))
            }
            "xsTask" | "xsRemoveTask" => {
                let player = self.change_player(call, int_arg(args, 3));
                if self.is_player(player) {
                    self.change(
                        call,
                        ChangeInput::new(player, ChangeKind::ObjectData, int_arg(args, 0)),
                    );
                }
                None
            }
            "xsModifyObjectTasks" | "xsObjectTaskAmount" => {
                let player = self.change_player(call, int_arg(args, 1));
                let object = int_arg(args, 0);
                let valid = self.is_player(player) && self.class_of(object).is_some();
                if valid {
                    self.change(
                        call,
                        ChangeInput::new(player, ChangeKind::ObjectData, object),
                    );
                }
                Some(Value::Bool(valid))
            }
            "xsTaskAmount" | "xsResetTaskAmount" => None,
            "xsCreateUnit" => Some(self.create_unit(call)),
            _ => Some(self.unit_change(call)),
        };
        self.record_call(call, result.clone());
        match result {
            Some(value) => HostAnswer::Value(value),
            None => HostAnswer::Void,
        }
    }

    fn effect_amount(&mut self, call: &HostCall<'_>) {
        let args = call.args;
        let effect = int_arg(args, 0);
        let item = int_arg(args, 1);
        let attribute = int_arg(args, 2);
        let value = float_arg(args, 3);
        let (effect, player) = if effect < 0 {
            (-effect - 1, 0)
        } else {
            (effect, self.change_player(call, int_arg(args, 4)))
        };
        if !self.is_player(player) {
            return;
        }
        let (kind, target, operation) = match effect {
            1 => (
                ChangeKind::Resource,
                item,
                if attribute == 0 {
                    Operation::Set
                } else {
                    Operation::Add
                },
            ),
            6 => (ChangeKind::Resource, item, Operation::Multiply),
            0 => (ChangeKind::ObjectData, item, Operation::Set),
            4 => (ChangeKind::ObjectData, item, Operation::Add),
            5 => (ChangeKind::ObjectData, item, Operation::Multiply),
            2 | 3 | 7 => (ChangeKind::ObjectData, item, Operation::None),
            10 => (ChangeKind::UnitValues, item, Operation::Set),
            11 => (ChangeKind::UnitValues, item, Operation::Add),
            12 => (ChangeKind::UnitValues, item, Operation::Multiply),
            8 | 100..=103 => (ChangeKind::TechnologyData, item, Operation::None),
            _ => (ChangeKind::Other, effect, Operation::None),
        };
        let amount = match operation {
            Operation::None => 0.0,
            _ => value,
        };
        self.change(
            call,
            ChangeInput {
                operation,
                amount,
                value_id: attribute,
                ..ChangeInput::new(player, kind, target)
            },
        );
    }

    fn create_unit(&mut self, call: &HostCall<'_>) -> Value {
        self.note_game_mode_objects();
        let args = call.args;
        let object = int_arg(args, 0);
        let player = int_arg(args, 1);
        if !self.is_player(player) || self.class_of(object).is_none() {
            return Value::Int(-1);
        }
        let position = vector_arg(args, 2);
        let id = self.next_unit_id;
        self.next_unit_id = self.next_unit_id.saturating_add(1);
        self.unit_index.insert(id, self.units.len());
        self.units.push(PreviewUnit {
            id,
            object_id: object,
            owner: player,
            position,
        });
        self.removed.push(false);
        self.change(
            call,
            ChangeInput {
                count: 1,
                unit: Some(id),
                position: Some(position),
                ..ChangeInput::new(player, ChangeKind::UnitsCreated, object)
            },
        );
        Value::Int(id)
    }

    fn unit_change(&mut self, call: &HostCall<'_>) -> Value {
        self.note_game_mode_objects();
        let args = call.args;
        let id = int_arg(args, 0);
        let Some(index) = self
            .unit_index
            .get(&id)
            .copied()
            .filter(|index| !self.removed[*index])
        else {
            return Value::Bool(false);
        };
        let unit = self.units[index];
        let base = |kind| ChangeInput {
            count: 1,
            unit: Some(id),
            ..ChangeInput::new(unit.owner, kind, unit.object_id)
        };
        match call.name {
            "xsRemoveUnit" => {
                self.removed[index] = true;
                self.change(call, base(ChangeKind::UnitsRemoved));
            }
            "xsSetUnitPosition" => {
                let position = vector_arg(args, 1);
                self.units[index].position = position;
                self.change(
                    call,
                    ChangeInput {
                        position: Some(position),
                        ..base(ChangeKind::UnitsMoved)
                    },
                );
            }
            "xsSetUnitOwner" => {
                let player = int_arg(args, 1);
                if !self.is_player(player) {
                    return Value::Bool(false);
                }
                self.units[index].owner = player;
                self.change(
                    call,
                    ChangeInput {
                        value_id: unit.owner,
                        ..ChangeInput {
                            count: 1,
                            unit: Some(id),
                            ..ChangeInput::new(
                                player,
                                ChangeKind::UnitsOwnerChanged,
                                unit.object_id,
                            )
                        }
                    },
                );
            }
            "xsSetUnitCaption" | "xsSetUnitName" | "xsSetUnitCivName" | "xsSetUnitPlayerName" => {
                self.change(
                    call,
                    ChangeInput {
                        text: Some(bounded_text(&text_arg(args, 1), MAXIMUM_VALUE_TEXT_BYTES)),
                        ..base(ChangeKind::UnitText)
                    },
                );
            }
            _ => self.change(call, base(ChangeKind::UnitValues)),
        }
        Value::Bool(true)
    }
}

fn resource_names(program: &Program) -> BTreeMap<i32, Vec<String>> {
    const MODES: [&str; 6] = [
        "cAttributeSet",
        "cAttributeAdd",
        "cAttributeDisable",
        "cAttributeEnable",
        "cAttributeForce",
        "cAttributeResearch",
    ];
    let mut names = program.environment_int_constants("cAttribute");
    for list in names.values_mut() {
        list.retain(|name| !MODES.contains(&name.as_str()));
    }
    names.retain(|_, list| !list.is_empty());
    names
}

struct ChangeInput {
    player: i32,
    kind: ChangeKind,
    target_id: i32,
    operation: Operation,
    amount: f32,
    count: u32,
    position: Option<[f32; 3]>,
    text: Option<String>,
    value_id: i32,
    unit: Option<i32>,
}

impl ChangeInput {
    fn new(player: i32, kind: ChangeKind, target_id: i32) -> Self {
        Self {
            player,
            kind,
            target_id,
            operation: Operation::None,
            amount: 0.0,
            count: if kind == ChangeKind::Technology { 1 } else { 0 },
            position: None,
            text: None,
            value_id: 0,
            unit: None,
        }
    }
}

impl crate::XsHost for PreviewHost<'_> {
    fn call(&mut self, call: &HostCall<'_>) -> HostAnswer {
        if call.name == "xsGetPlayerNumberOfTechs" {
            return match self.state.technology_count {
                Some(count) if self.is_player(int_arg(call.args, 0)) => {
                    HostAnswer::Value(Value::Int(count))
                }
                Some(_) => HostAnswer::Value(Value::Int(-1)),
                None => {
                    HostAnswer::Unanswered(Unanswered::Reason(UnansweredReason::TechnologyData))
                }
            };
        }
        match call.class {
            CallClass::Chat => self.answer_chat(call),
            CallClass::Mocked => self.answer_mocked(call),
            CallClass::PreviewRead => self.answer_preview_read(call),
            CallClass::StartDefault => self.answer_start_default(call),
            CallClass::RecordedChange => self.answer_change(call),
            CallClass::Pure | CallClass::Random | CallClass::Refused => {
                let reason = crate::call_table()
                    .ok()
                    .and_then(|table| table.get(call.name))
                    .and_then(|entry| entry.reason)
                    .unwrap_or(UnansweredReason::UnknownCall);
                HostAnswer::Unanswered(Unanswered::Reason(reason))
            }
        }
    }

    fn take_notes(&mut self) -> Vec<HostNote> {
        std::mem::take(&mut self.notes)
    }
}

fn int_arg(args: &[Value], index: usize) -> i32 {
    match args.get(index) {
        Some(Value::Int(value)) => *value,
        Some(Value::Float(value)) => *value as i32,
        Some(Value::Bool(value)) => i32::from(*value),
        _ => -1,
    }
}

fn float_arg(args: &[Value], index: usize) -> f32 {
    args.get(index).and_then(Value::as_f32).unwrap_or(0.0)
}

fn bool_arg(args: &[Value], index: usize) -> bool {
    match args.get(index) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Int(value)) => *value != 0,
        _ => false,
    }
}

fn text_arg(args: &[Value], index: usize) -> String {
    match args.get(index) {
        Some(Value::Str(bytes)) => String::from_utf8_lossy(bytes).into_owned(),
        Some(other) if other.is_number_like() || matches!(other, Value::Vector(_)) => {
            String::from_utf8_lossy(&number_text(other).unwrap_or_default()).into_owned()
        }
        _ => String::new(),
    }
}

fn vector_arg(args: &[Value], index: usize) -> [f32; 3] {
    match args.get(index) {
        Some(Value::Vector(vector)) => *vector,
        _ => INVALID_VECTOR,
    }
}

fn four(bytes: &[u8]) -> [u8; 4] {
    let mut out = [0; 4];
    out.copy_from_slice(&bytes[..4]);
    out
}

fn bounded_value(value: &Value) -> Value {
    match value {
        Value::Str(bytes) if bytes.len() > MAXIMUM_VALUE_TEXT_BYTES => {
            let text = String::from_utf8_lossy(bytes);
            Value::Str(Arc::from(
                bounded_text(&text, MAXIMUM_VALUE_TEXT_BYTES).as_bytes(),
            ))
        }
        other => other.clone(),
    }
}
