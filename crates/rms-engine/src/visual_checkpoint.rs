use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use rms_content::TerrainId;

use crate::{
    CliffEdge, ExecutionCounter, ExecutionObserver, ExecutionStep, GeneratedMap, MapDimensions,
    PlacedObject,
};

pub const VISUAL_CHECKPOINT_CONTRACT_MAJOR: u32 = 1;
pub const VISUAL_CHECKPOINT_CONTRACT_MINOR: u32 = 0;
pub const VISUAL_CHUNK_TILES: u16 = 32;
pub const MAXIMUM_VISUAL_CHUNKS: usize = 256;
pub const MAXIMUM_VISUAL_CHECKPOINTS: u64 = 128;
pub const MAXIMUM_VISUAL_CHECKPOINT_BYTES: usize = 8 * 1024 * 1024;
pub const MAXIMUM_VISUAL_CHECKPOINT_OBJECTS: usize = 262_144;
pub const MAXIMUM_VISUAL_CHECKPOINT_CLIFFS: usize = 262_144;
pub const VISUAL_OBJECT_RECORD_BYTES: usize = 18;
pub const VISUAL_CLIFF_RECORD_BYTES: usize = 12;

pub const MINIMUM_SUBSTAGE_CHECKPOINT_INTERVAL: Duration = Duration::from_millis(500);

pub fn substage_checkpoint_interval(elapsed: Duration) -> Duration {
    MINIMUM_SUBSTAGE_CHECKPOINT_INTERVAL.max(elapsed / 24)
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum VisualStage {
    Land,
    Elevation,
    Cliffs,
    Terrain,
    Connections,
    Objects,
    SampleComplete,
}

impl VisualStage {
    pub const ALL: [Self; 7] = [
        Self::Land,
        Self::Elevation,
        Self::Cliffs,
        Self::Terrain,
        Self::Connections,
        Self::Objects,
        Self::SampleComplete,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Land => "land",
            Self::Elevation => "elevation",
            Self::Cliffs => "cliffs",
            Self::Terrain => "terrain",
            Self::Connections => "connections",
            Self::Objects => "objects",
            Self::SampleComplete => "sample-complete",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct VisualState<'a> {
    pub dimensions: MapDimensions,
    pub terrain: &'a [TerrainId],
    pub elevation: &'a [i16],
    pub cliffs: &'a [CliffEdge],
    pub objects: &'a [PlacedObject],
}

impl<'a> VisualState<'a> {
    pub fn of_map(map: &'a GeneratedMap) -> Self {
        Self {
            dimensions: map.dimensions,
            terrain: &map.terrain,
            elevation: &map.elevation,
            cliffs: &map.cliffs,
            objects: &map.objects,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisualChunk {
    pub chunk_x: u16,
    pub chunk_y: u16,
    pub terrain_ids_le: Vec<u8>,
    pub elevations: Vec<u8>,
    pub cliff_edges: Vec<u8>,
    pub objects: Vec<u8>,
}

impl VisualChunk {
    pub fn encoded_bytes(&self) -> usize {
        self.terrain_ids_le.len()
            + self.elevations.len()
            + self.cliff_edges.len()
            + self.objects.len()
    }

    pub fn object_count(&self) -> usize {
        self.objects.len() / VISUAL_OBJECT_RECORD_BYTES
    }

    pub fn cliff_count(&self) -> usize {
        self.cliff_edges.len() / VISUAL_CLIFF_RECORD_BYTES
    }

    fn key(&self) -> (u16, u16) {
        (self.chunk_y, self.chunk_x)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisualCheckpoint {
    pub revision: u64,
    pub base_revision: u64,
    pub stage: VisualStage,
    pub dimensions: MapDimensions,
    pub chunks: Vec<VisualChunk>,
    pub elapsed_us: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum VisualCheckpointError {
    #[error("visual checkpoint does not apply to the pending candidate revision")]
    StaleBase,
    #[error("visual checkpoint is invalid: {0}")]
    Invalid(&'static str),
}

impl VisualCheckpoint {
    pub fn is_keyframe(&self) -> bool {
        self.base_revision == 0
    }

    pub fn encoded_bytes(&self) -> usize {
        self.chunks.iter().map(VisualChunk::encoded_bytes).sum()
    }

    pub fn object_count(&self) -> usize {
        self.chunks.iter().map(VisualChunk::object_count).sum()
    }

    pub fn compose(self, next: Self) -> Result<Self, VisualCheckpointError> {
        if next.revision <= self.revision {
            return Err(VisualCheckpointError::Invalid("revisions must increase"));
        }
        if next.is_keyframe() {
            return Ok(next);
        }
        if next.base_revision != self.revision || next.dimensions != self.dimensions {
            return Err(VisualCheckpointError::StaleBase);
        }
        let mut chunks = self
            .chunks
            .into_iter()
            .map(|chunk| (chunk.key(), chunk))
            .collect::<BTreeMap<_, _>>();
        for chunk in next.chunks {
            chunks.insert(chunk.key(), chunk);
        }
        Ok(Self {
            revision: next.revision,
            base_revision: self.base_revision,
            stage: next.stage,
            dimensions: next.dimensions,
            chunks: chunks.into_values().collect(),
            elapsed_us: next.elapsed_us,
        })
    }

    pub fn validate(&self) -> Result<(), VisualCheckpointError> {
        let invalid = |reason| Err(VisualCheckpointError::Invalid(reason));
        let tile_count = self
            .dimensions
            .tile_count()
            .map_err(|_| VisualCheckpointError::Invalid("dimensions are out of bounds"))?;
        if self.revision == 0 || self.base_revision >= self.revision {
            return invalid("revision chain is not increasing");
        }
        let (columns, rows) = chunk_grid(self.dimensions);
        if self.chunks.len() > MAXIMUM_VISUAL_CHUNKS
            || self.chunks.len() > usize::from(columns) * usize::from(rows)
        {
            return invalid("chunk count is out of bounds");
        }
        if self.is_keyframe() && self.chunks.len() != usize::from(columns) * usize::from(rows) {
            return invalid("a keyframe must hold every chunk");
        }
        if self
            .chunks
            .windows(2)
            .any(|pair| pair[0].key() >= pair[1].key())
        {
            return invalid("chunks are not unique and ordered");
        }
        let mut objects = 0_usize;
        let mut cliffs = 0_usize;
        for chunk in &self.chunks {
            if chunk.chunk_x >= columns || chunk.chunk_y >= rows {
                return invalid("chunk lies outside the map");
            }
            let tiles = chunk_tile_count(self.dimensions, chunk.chunk_x, chunk.chunk_y);
            if chunk.terrain_ids_le.len() != tiles * 2
                || chunk.elevations.len() != tiles
                || chunk.objects.len() % VISUAL_OBJECT_RECORD_BYTES != 0
                || chunk.cliff_edges.len() % VISUAL_CLIFF_RECORD_BYTES != 0
            {
                return invalid("chunk columns have invalid lengths");
            }
            objects += chunk.object_count();
            cliffs += chunk.cliff_count();
        }
        if objects > MAXIMUM_VISUAL_CHECKPOINT_OBJECTS
            || cliffs > MAXIMUM_VISUAL_CHECKPOINT_CLIFFS.min(tile_count.saturating_mul(8))
            || self.encoded_bytes() > MAXIMUM_VISUAL_CHECKPOINT_BYTES
        {
            return invalid("checkpoint exceeds its bounds");
        }
        Ok(())
    }
}

pub fn chunk_grid(dimensions: MapDimensions) -> (u16, u16) {
    (
        dimensions.width.div_ceil(VISUAL_CHUNK_TILES),
        dimensions.height.div_ceil(VISUAL_CHUNK_TILES),
    )
}

pub fn chunk_tile_count(dimensions: MapDimensions, chunk_x: u16, chunk_y: u16) -> usize {
    let span = |extent: u16, chunk: u16| {
        let start = chunk.saturating_mul(VISUAL_CHUNK_TILES);
        usize::from(extent.saturating_sub(start).min(VISUAL_CHUNK_TILES))
    };
    span(dimensions.width, chunk_x) * span(dimensions.height, chunk_y)
}

#[derive(Debug, Default)]
pub struct VisualProjector {
    dimensions: Option<MapDimensions>,
    previous: Vec<VisualChunk>,
    revision: u64,
    stopped: bool,
}

impl VisualProjector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn stopped(&self) -> bool {
        self.stopped
    }

    pub fn project(
        &mut self,
        stage: VisualStage,
        state: &VisualState<'_>,
        elapsed_us: u64,
    ) -> Option<VisualCheckpoint> {
        if self.stopped {
            return None;
        }
        let Some(current) = project_chunks(state) else {
            self.stopped = true;
            return None;
        };
        let keyframe = self.dimensions != Some(state.dimensions);
        let chunks = if keyframe {
            current.clone()
        } else {
            current
                .iter()
                .zip(&self.previous)
                .filter(|(now, before)| now != before)
                .map(|(now, _)| now.clone())
                .collect()
        };
        if chunks.is_empty() {
            return None;
        }
        if self.revision >= MAXIMUM_VISUAL_CHECKPOINTS {
            self.stopped = true;
            return None;
        }
        let checkpoint = VisualCheckpoint {
            revision: self.revision + 1,
            base_revision: if keyframe { 0 } else { self.revision },
            stage,
            dimensions: state.dimensions,
            chunks,
            elapsed_us,
        };
        if checkpoint.validate().is_err() {
            self.stopped = true;
            return None;
        }
        self.revision = checkpoint.revision;
        self.dimensions = Some(state.dimensions);
        self.previous = current;
        Some(checkpoint)
    }
}

fn project_chunks(state: &VisualState<'_>) -> Option<Vec<VisualChunk>> {
    let tile_count = state.dimensions.tile_count().ok()?;
    if state.terrain.len() != tile_count
        || state.elevation.len() != tile_count
        || state.objects.len() > MAXIMUM_VISUAL_CHECKPOINT_OBJECTS
        || state.cliffs.len() > MAXIMUM_VISUAL_CHECKPOINT_CLIFFS
    {
        return None;
    }
    let width = state.dimensions.width;
    let height = state.dimensions.height;
    let (columns, rows) = chunk_grid(state.dimensions);
    let chunk_index = |x: u16, y: u16| {
        usize::from(y.min(height - 1) / VISUAL_CHUNK_TILES) * usize::from(columns)
            + usize::from(x.min(width - 1) / VISUAL_CHUNK_TILES)
    };
    let mut chunks = Vec::with_capacity(usize::from(columns) * usize::from(rows));
    for chunk_y in 0..rows {
        for chunk_x in 0..columns {
            let tiles = chunk_tile_count(state.dimensions, chunk_x, chunk_y);
            chunks.push(VisualChunk {
                chunk_x,
                chunk_y,
                terrain_ids_le: Vec::with_capacity(tiles * 2),
                elevations: Vec::with_capacity(tiles),
                cliff_edges: Vec::new(),
                objects: Vec::new(),
            });
        }
    }
    for chunk in &mut chunks {
        let x0 = chunk.chunk_x * VISUAL_CHUNK_TILES;
        let y0 = chunk.chunk_y * VISUAL_CHUNK_TILES;
        let x1 = (x0 + VISUAL_CHUNK_TILES).min(width);
        let y1 = (y0 + VISUAL_CHUNK_TILES).min(height);
        for y in y0..y1 {
            let row = usize::from(y) * usize::from(width);
            for x in x0..x1 {
                let index = row + usize::from(x);
                let terrain = u16::try_from(state.terrain[index].0).unwrap_or(u16::MAX);
                chunk
                    .terrain_ids_le
                    .extend_from_slice(&terrain.to_le_bytes());
                let elevation =
                    state.elevation[index].clamp(i16::from(i8::MIN), i16::from(i8::MAX));
                chunk.elevations.push(elevation as i8 as u8);
            }
        }
    }
    for cliff in state.cliffs {
        let chunk = &mut chunks[chunk_index(cliff.from.x, cliff.from.y)];
        chunk
            .cliff_edges
            .extend_from_slice(&cliff.from.x.to_le_bytes());
        chunk
            .cliff_edges
            .extend_from_slice(&cliff.from.y.to_le_bytes());
        chunk
            .cliff_edges
            .extend_from_slice(&cliff.to.x.to_le_bytes());
        chunk
            .cliff_edges
            .extend_from_slice(&cliff.to.y.to_le_bytes());
        chunk
            .cliff_edges
            .extend_from_slice(&cliff.cliff_type.to_le_bytes());
    }
    for object in state.objects {
        let tile_x = u16::try_from(object.x_256 / 256).unwrap_or(u16::MAX);
        let tile_y = u16::try_from(object.y_256 / 256).unwrap_or(u16::MAX);
        let chunk = &mut chunks[chunk_index(tile_x, tile_y)];
        chunk
            .objects
            .extend_from_slice(&object.object_id.0.to_le_bytes());
        chunk.objects.extend_from_slice(&object.x_256.to_le_bytes());
        chunk.objects.extend_from_slice(&object.y_256.to_le_bytes());
        chunk
            .objects
            .extend_from_slice(&object.footprint_width_256.to_le_bytes());
        chunk
            .objects
            .extend_from_slice(&object.footprint_height_256.to_le_bytes());
        chunk.objects.push(object.owner);
        chunk.objects.push(object.presentation_kind);
    }
    let bytes = chunks.iter().map(VisualChunk::encoded_bytes).sum::<usize>();
    (bytes <= MAXIMUM_VISUAL_CHECKPOINT_BYTES).then_some(chunks)
}

#[derive(Debug, Default)]
pub struct CoalescingCheckpointLane {
    pending: Option<VisualCheckpoint>,
    last_revision: u64,
    broken: bool,
}

impl CoalescingCheckpointLane {
    pub fn offer(&mut self, checkpoint: VisualCheckpoint) -> bool {
        if checkpoint.revision <= self.last_revision || checkpoint.validate().is_err() {
            return false;
        }
        let previous = std::mem::replace(&mut self.last_revision, checkpoint.revision);
        if checkpoint.is_keyframe() {
            self.broken = false;
            self.pending = Some(checkpoint);
            return true;
        }
        if self.broken {
            return false;
        }
        let composed = match self.pending.take() {
            Some(pending) => pending.compose(checkpoint),
            None if checkpoint.base_revision == previous => Ok(checkpoint),
            None => Err(VisualCheckpointError::StaleBase),
        };
        match composed {
            Ok(composed) if composed.validate().is_ok() => {
                self.pending = Some(composed);
                true
            }
            _ => {
                self.broken = true;
                false
            }
        }
    }

    pub fn take(&mut self) -> Option<VisualCheckpoint> {
        self.pending.take()
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }
}

type AdmissionGate<'a> = Box<dyn FnMut() -> bool + 'a>;
type CheckpointSink<'a> = Box<dyn FnMut(VisualCheckpoint) -> bool + 'a>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Admission {
    Waiting,
    Admitted,
    Closed,
}

pub struct VisualCheckpointObserver<'a> {
    inner: &'a mut dyn ExecutionObserver,
    gate: Option<AdmissionGate<'a>>,
    sink: CheckpointSink<'a>,
    started_at: Option<Instant>,
    admission: Admission,
    projector: VisualProjector,
    last_published: Option<Duration>,
}

impl<'a> VisualCheckpointObserver<'a> {
    pub fn new(
        inner: &'a mut dyn ExecutionObserver,
        sink: impl FnMut(VisualCheckpoint) -> bool + 'a,
    ) -> Self {
        Self {
            inner,
            gate: None,
            sink: Box::new(sink),
            started_at: None,
            admission: Admission::Waiting,
            projector: VisualProjector::new(),
            last_published: None,
        }
    }

    pub fn forwarding(inner: &'a mut dyn ExecutionObserver) -> Self {
        let mut observer = Self::new(inner, |_| false);
        observer.admission = Admission::Closed;
        observer
    }

    pub fn with_admission_gate(mut self, gate: impl FnMut() -> bool + 'a) -> Self {
        self.gate = Some(Box::new(gate));
        self
    }

    pub fn admitted(&self) -> bool {
        self.admission == Admission::Admitted
    }

    pub fn published(&self) -> u64 {
        self.projector.revision()
    }

    pub fn publish_completed(&mut self, map: &GeneratedMap) {
        if self.admission == Admission::Admitted {
            self.project(VisualStage::SampleComplete, &VisualState::of_map(map));
        }
    }

    fn elapsed(&self) -> Duration {
        self.started_at
            .map_or(Duration::ZERO, |started| started.elapsed())
    }

    fn project(&mut self, stage: VisualStage, state: &VisualState<'_>) {
        let elapsed = self.elapsed();
        let elapsed_us = u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX);
        if let Some(checkpoint) = self.projector.project(stage, state, elapsed_us) {
            self.last_published = Some(elapsed);
            if !(self.sink)(checkpoint) {
                self.admission = Admission::Closed;
            }
        }
        if self.projector.stopped() {
            self.admission = Admission::Closed;
        }
    }
}

impl ExecutionObserver for VisualCheckpointObserver<'_> {
    fn execution_started(&mut self, plan: &'static [ExecutionStep]) {
        self.started_at = Some(Instant::now());
        self.inner.execution_started(plan);
    }

    fn step_started(&mut self, step: ExecutionStep) {
        self.inner.step_started(step);
    }

    fn step_finished(&mut self, step: ExecutionStep, counters: &[(ExecutionCounter, u64)]) {
        self.inner.step_finished(step, counters);
    }

    fn visual_boundary(&mut self, stage: VisualStage, state: &VisualState<'_>) {
        self.inner.visual_boundary(stage, state);
        if self.admit() {
            self.project(stage, state);
        }
    }

    fn visual_substage(&mut self, stage: VisualStage, state: &VisualState<'_>) {
        self.inner.visual_substage(stage, state);
        let started = Instant::now();
        let spaced = self.last_published.is_none_or(|last| {
            let elapsed = self.elapsed();
            elapsed.saturating_sub(last) >= substage_checkpoint_interval(elapsed)
        });
        if spaced && self.admit() {
            self.project(stage, state);
        }
        self.inner.exclude_observation(started.elapsed());
    }

    fn exclude_observation(&mut self, duration: Duration) {
        self.inner.exclude_observation(duration);
    }
}

impl VisualCheckpointObserver<'_> {
    fn admit(&mut self) -> bool {
        if self.admission == Admission::Waiting {
            if self.started_at.is_none() {
                return false;
            }
            if let Some(gate) = self.gate.as_mut()
                && !gate()
            {
                return false;
            }
            self.admission = Admission::Admitted;
        }
        self.admission == Admission::Admitted
    }
}
