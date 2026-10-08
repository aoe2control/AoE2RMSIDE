use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TraceLevel {
    Off,
    #[default]
    Summary,
    Full,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GenerationStage {
    Setup,
    Land,
    Terrain,
    Objects,
    Finalize,
}

impl GenerationStage {
    pub const ORDERED: [Self; 5] = [
        Self::Setup,
        Self::Land,
        Self::Terrain,
        Self::Objects,
        Self::Finalize,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Land => "land",
            Self::Terrain => "terrain",
            Self::Objects => "objects",
            Self::Finalize => "finalize",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GenerationEventKind {
    StageStarted,
    MutationBatch,
    Progress,
    RngCheckpoint,
    StageCompleted,
    Warning,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MutationOperation {
    Replace,
    Remove,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileMutation {
    pub tile_index: u32,
    pub terrain_id: u32,
    pub elevation: i16,
    pub terrain_zone: u32,
    pub land_id: u32,
    pub layer_id: u16,
    pub flags: u32,
    pub operation: MutationOperation,
    pub provenance_operation_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMutation {
    pub object_index: u32,
    pub object_id: u32,
    pub x_256: u32,
    pub y_256: u32,
    pub owner: u8,
    pub facet: u16,
    pub footprint_width_256: u16,
    pub footprint_height_256: u16,
    pub presentation_kind: u8,
    pub operation: MutationOperation,
    pub provenance_operation_index: u32,
    pub resource_type: i16,
    pub resource_quantity_f32_bits: u32,
    #[serde(default)]
    pub resource_delta: i32,
    #[serde(default)]
    pub status: i32,
    #[serde(default)]
    pub death_state: i32,
    #[serde(default)]
    pub data_status: i32,
    #[serde(default)]
    pub selection_flags: u32,
    #[serde(default)]
    pub behavior_flags: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliffMutation {
    pub cliff_index: u32,
    pub from_x: u16,
    pub from_y: u16,
    pub to_x: u16,
    pub to_y: u16,
    pub cliff_type: u32,
    pub operation: MutationOperation,
    pub provenance_operation_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionMutation {
    pub connection_index: u32,
    pub start_x: u16,
    pub start_y: u16,
    pub end_x: u16,
    pub end_y: u16,
    pub kind: u8,
    pub operation: MutationOperation,
    pub provenance_operation_index: u32,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationBatch {
    pub tiles: Vec<TileMutation>,
    pub objects: Vec<ObjectMutation>,
    pub cliffs: Vec<CliffMutation>,
    pub connections: Vec<ConnectionMutation>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationEvent {
    pub sequence: u64,
    pub stage: GenerationStage,
    pub kind: GenerationEventKind,
    pub completed: u64,
    pub total: u64,
    pub state_hash: Option<[u8; 32]>,
    pub detail: Option<String>,
    pub mutations: Option<MutationBatch>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StageCheckpoint {
    pub sequence: u64,
    pub stage: String,
    pub state_hash: [u8; 32],
}

pub trait GenerationEventSink {
    fn emit(&mut self, event: GenerationEvent) -> Result<(), TraceSinkError>;
}

#[derive(Clone, Debug)]
pub struct BoundedEventBuffer {
    maximum_events: usize,
    events: Vec<GenerationEvent>,
    truncated: bool,
}

impl BoundedEventBuffer {
    pub fn new(maximum_events: usize) -> Self {
        Self {
            maximum_events,
            events: Vec::with_capacity(maximum_events.min(4096)),
            truncated: false,
        }
    }

    pub fn events(&self) -> &[GenerationEvent] {
        &self.events
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }
}

impl GenerationEventSink for BoundedEventBuffer {
    fn emit(&mut self, event: GenerationEvent) -> Result<(), TraceSinkError> {
        if let Some(previous) = self.events.last()
            && event.sequence <= previous.sequence
        {
            return Err(TraceSinkError::OutOfOrder {
                previous: previous.sequence,
                next: event.sequence,
            });
        }
        if self.events.len() == self.maximum_events {
            self.truncated = true;
            return Ok(());
        }
        if event
            .detail
            .as_ref()
            .is_some_and(|value| value.len() > 4096)
        {
            return Err(TraceSinkError::DetailTooLarge);
        }
        if event.mutations.as_ref().is_some_and(|batch| {
            batch.tiles.len() > 1024
                || batch.objects.len() > 256
                || batch.cliffs.len() > 256
                || batch.connections.len() > 256
        }) {
            return Err(TraceSinkError::MutationBatchTooLarge);
        }
        self.events.push(event);
        Ok(())
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum TraceSinkError {
    #[error("generation event sequence regressed from {previous} to {next}")]
    OutOfOrder { previous: u64, next: u64 },
    #[error("generation event detail exceeds its bounded size")]
    DetailTooLarge,
    #[error("generation mutation batch exceeds its bounded collection sizes")]
    MutationBatchTooLarge,
    #[error("generation event consumer disconnected")]
    ConsumerDisconnected,
}
