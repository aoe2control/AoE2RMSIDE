use std::sync::Arc;

use rms_content::ObjectId;
use rms_engine::{GeneratedMap, GenerationError, PlacedObject};

use crate::GameCrashError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StartKind {
    Land,
    TownCenter,
    None,
}

impl StartKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Land => "land",
            Self::TownCenter => "town_center",
            Self::None => "none",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PlayerRecord {
    pub slot: u8,
    pub team: u8,
    pub start: StartKind,
    pub start_tile: Option<(u16, u16)>,
    pub land_zone: Option<u8>,
    pub land_zone_shared: bool,
    pub town_center: Option<PlacedObject>,
}

pub(crate) fn player_records(
    map: &GeneratedMap,
    town_center: Option<ObjectId>,
) -> Arc<[PlayerRecord]> {
    let width = map.dimensions.width.max(1);
    let height = map.dimensions.height.max(1);
    map.player_starts
        .iter()
        .map(|start| {
            let town_center = town_center.and_then(|id| {
                map.objects
                    .iter()
                    .find(|object| object.object_id == id && object.owner == start.slot)
                    .cloned()
            });
            let (kind, tile) = match (start.land, &town_center) {
                (Some(land), _) => (StartKind::Land, Some((land.x, land.y))),
                (None, Some(object)) => (
                    StartKind::TownCenter,
                    Some((
                        ((object.x_256 / 256) as u16).min(width - 1),
                        ((object.y_256 / 256) as u16).min(height - 1),
                    )),
                ),
                (None, None) => (StartKind::None, None),
            };
            PlayerRecord {
                slot: start.slot,
                team: start.team,
                start: kind,
                start_tile: tile,
                land_zone: start.land_zone,
                land_zone_shared: start.land_zone_shared,
                town_center,
            }
        })
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SampleFailure {
    pub code: String,
    pub message: String,
    pub crash_id: Option<&'static str>,
}

impl SampleFailure {
    pub(crate) fn heap_bytes(&self) -> u64 {
        (std::mem::size_of::<Self>() + self.code.capacity() + self.message.capacity()) as u64
    }
}

#[derive(Debug)]
pub(crate) struct StrictRefusal {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for StrictRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for StrictRefusal {}

pub(crate) fn sample_failure(error: &anyhow::Error) -> Option<SampleFailure> {
    if let Some(crash) = error.downcast_ref::<GameCrashError>() {
        return Some(SampleFailure {
            code: crash.code.to_owned(),
            message: crash.message.clone(),
            crash_id: Some(crash.crash.id),
        });
    }
    if let Some(refusal) = error.downcast_ref::<StrictRefusal>() {
        return Some(SampleFailure {
            code: refusal.code.to_owned(),
            message: refusal.message.clone(),
            crash_id: None,
        });
    }
    let generation = error.downcast_ref::<GenerationError>()?;
    let code = match generation {
        GenerationError::InvalidRequest { code, .. } => *code,
        GenerationError::MissingContentDefinition { .. } => "missing-game-data",
        GenerationError::ResourceLimit { .. } => "resource-limit",
        _ => return None,
    };
    Some(SampleFailure {
        code: code.to_owned(),
        message: generation.to_string(),
        crash_id: generation.known_crash().map(|crash| crash.id),
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PlacementRow {
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub object_id: Option<u32>,
    pub player: Option<u8>,
    pub groups_requested: u32,
    pub groups_placed: u32,
    pub objects_created: u32,
}

pub(crate) fn placement_rows(
    map: &GeneratedMap,
    entry: Option<(&str, &[u8])>,
    short_only: bool,
) -> Vec<PlacementRow> {
    let lines = entry.map(|(_, bytes)| LineIndex::new(bytes));
    map.placement_records
        .iter()
        .filter(|record| !short_only || record.groups_placed < record.groups_requested)
        .map(|record| {
            let position = map
                .provenance
                .get(record.operation_index as usize)
                .zip(entry.zip(lines.as_ref()))
                .filter(|(reference, ((id, _), _))| reference.source_id == *id)
                .and_then(|(reference, ((_, bytes), lines))| {
                    lines.position(bytes, reference.byte_start as usize)
                });
            PlacementRow {
                line: position.map(|(line, _)| line),
                column: position.map(|(_, column)| column),
                object_id: record.object_id.map(|id| id.0),
                player: record.player_slot,
                groups_requested: record.groups_requested,
                groups_placed: record.groups_placed,
                objects_created: record.objects_created,
            }
        })
        .collect()
}

struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    fn new(bytes: &[u8]) -> Self {
        let mut starts = vec![0];
        starts.extend(
            bytes
                .iter()
                .enumerate()
                .filter(|(_, byte)| **byte == b'\n')
                .map(|(index, _)| index + 1),
        );
        Self { starts }
    }

    fn position(&self, bytes: &[u8], offset: usize) -> Option<(u32, u32)> {
        if offset > bytes.len() {
            return None;
        }
        let line = self.starts.partition_point(|start| *start <= offset);
        let mut start = self.starts[line - 1];
        if line == 1 && bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            start = start.max(3).min(offset);
        }
        let column = bytes[start..offset]
            .iter()
            .filter(|byte| (**byte & 0xc0) != 0x80)
            .count();
        Some((u32::try_from(line).ok()?, u32::try_from(column + 1).ok()?))
    }
}
