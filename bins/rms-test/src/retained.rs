use std::collections::{BTreeSet, VecDeque};
use std::mem::size_of;
use std::ops::Range;
use std::sync::Arc;

use rms_content::TerrainId;
use rms_engine::{
    ExecutionCostSummary, GeneratedMap, GenerationMetrics, GenerationWarning, MapDimensions,
    TileFlags,
};

#[derive(Clone, Debug, Eq, PartialEq)]
enum Column<T> {
    Raw(Vec<T>),
    Runs { values: Vec<T>, lengths: Vec<u32> },
}

impl<T: Copy + Eq> Column<T> {
    fn encode(mut values: Vec<T>) -> Self {
        let raw_bytes = values.len() * size_of::<T>();
        let run_bytes = size_of::<T>() + size_of::<u32>();
        let mut runs = Vec::new();
        let mut lengths = Vec::<u32>::new();
        let mut smaller = true;
        for value in &values {
            match (runs.last(), lengths.last_mut()) {
                (Some(previous), Some(length)) if previous == value && *length < u32::MAX => {
                    *length += 1;
                }
                _ => {
                    runs.push(*value);
                    lengths.push(1);
                    if runs.len() * run_bytes >= raw_bytes {
                        smaller = false;
                        break;
                    }
                }
            }
        }
        if !smaller {
            values.shrink_to_fit();
            return Self::Raw(values);
        }
        runs.shrink_to_fit();
        lengths.shrink_to_fit();
        Self::Runs {
            values: runs,
            lengths,
        }
    }

    fn decode(&self) -> Vec<T> {
        match self {
            Self::Raw(values) => values.clone(),
            Self::Runs { values, lengths } => {
                let total = lengths.iter().map(|length| *length as usize).sum();
                let mut decoded = Vec::with_capacity(total);
                for (value, length) in values.iter().zip(lengths) {
                    decoded.extend(std::iter::repeat_n(*value, *length as usize));
                }
                decoded
            }
        }
    }

    fn heap_bytes(&self) -> u64 {
        match self {
            Self::Raw(values) => (values.capacity() * size_of::<T>()) as u64,
            Self::Runs { values, lengths } => {
                (values.capacity() * size_of::<T>() + lengths.capacity() * size_of::<u32>()) as u64
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CompactMap {
    dimensions: MapDimensions,
    terrain: Column<u32>,
    pre_connection_terrain: Column<u32>,
    layer: Column<u16>,
    elevation: Column<i16>,
    land_zone: Column<u32>,
    terrain_zone: Column<u32>,
    flags: Column<u32>,
    tile_operation_indices: Column<u32>,
    rest: GeneratedMap,
}

impl CompactMap {
    pub(crate) fn encode(mut map: GeneratedMap) -> Self {
        let terrain = std::mem::take(&mut map.terrain)
            .into_iter()
            .map(|terrain| terrain.0)
            .collect();
        let pre_connection_terrain = std::mem::take(&mut map.pre_connection_terrain)
            .into_iter()
            .map(|terrain| terrain.0)
            .collect();
        let flags = std::mem::take(&mut map.flags)
            .into_iter()
            .map(|flags| flags.0)
            .collect();
        let compact = Self {
            dimensions: map.dimensions,
            terrain: Column::encode(terrain),
            pre_connection_terrain: Column::encode(pre_connection_terrain),
            layer: Column::encode(std::mem::take(&mut map.layer)),
            elevation: Column::encode(std::mem::take(&mut map.elevation)),
            land_zone: Column::encode(std::mem::take(&mut map.land_zone)),
            terrain_zone: Column::encode(std::mem::take(&mut map.terrain_zone)),
            flags: Column::encode(flags),
            tile_operation_indices: Column::encode(std::mem::take(&mut map.tile_operation_indices)),
            rest: shrink(map),
        };
        debug_assert_eq!(compact.dimensions, compact.rest.dimensions);
        compact
    }

    pub(crate) fn decode(&self) -> GeneratedMap {
        let mut map = self.rest.clone();
        map.terrain = self.terrain.decode().into_iter().map(TerrainId).collect();
        map.pre_connection_terrain = self
            .pre_connection_terrain
            .decode()
            .into_iter()
            .map(TerrainId)
            .collect();
        map.layer = self.layer.decode();
        map.elevation = self.elevation.decode();
        map.land_zone = self.land_zone.decode();
        map.terrain_zone = self.terrain_zone.decode();
        map.flags = self.flags.decode().into_iter().map(TileFlags).collect();
        map.tile_operation_indices = self.tile_operation_indices.decode();
        map
    }

    pub(crate) fn heap_bytes(&self) -> u64 {
        [
            &self.terrain,
            &self.pre_connection_terrain,
            &self.land_zone,
            &self.terrain_zone,
            &self.flags,
            &self.tile_operation_indices,
        ]
        .into_iter()
        .map(Column::heap_bytes)
        .sum::<u64>()
            + self.layer.heap_bytes()
            + self.elevation.heap_bytes()
            + map_heap_bytes(&self.rest)
    }
}

fn shrink(mut map: GeneratedMap) -> GeneratedMap {
    map.cliffs.shrink_to_fit();
    map.cliff_pieces.shrink_to_fit();
    map.appearance_objects.shrink_to_fit();
    map.connections.shrink_to_fit();
    map.objects.shrink_to_fit();
    map.object_operation_indices.shrink_to_fit();
    map.cliff_operation_indices.shrink_to_fit();
    map.connection_operation_indices.shrink_to_fit();
    map.stage_hashes.shrink_to_fit();
    map.warnings.shrink_to_fit();
    map.provenance.shrink_to_fit();
    map
}

fn vector_bytes<T>(values: &Vec<T>) -> u64 {
    (values.capacity() * size_of::<T>()) as u64
}

pub(crate) fn map_heap_bytes(map: &GeneratedMap) -> u64 {
    vector_bytes(&map.terrain)
        + vector_bytes(&map.pre_connection_terrain)
        + vector_bytes(&map.layer)
        + vector_bytes(&map.elevation)
        + vector_bytes(&map.land_zone)
        + vector_bytes(&map.terrain_zone)
        + vector_bytes(&map.flags)
        + vector_bytes(&map.cliffs)
        + vector_bytes(&map.cliff_pieces)
        + vector_bytes(&map.appearance_objects)
        + vector_bytes(&map.connections)
        + vector_bytes(&map.objects)
        + vector_bytes(&map.tile_operation_indices)
        + vector_bytes(&map.object_operation_indices)
        + vector_bytes(&map.cliff_operation_indices)
        + vector_bytes(&map.connection_operation_indices)
        + map
            .connection_routes
            .as_ref()
            .map_or(0, |routes| routes.retained_heap_bytes() as u64)
        + vector_bytes(&map.stage_hashes)
        + warnings_bytes(&map.warnings)
        + metrics_bytes(&map.metrics)
        + vector_bytes(&map.provenance)
        + map
            .provenance
            .iter()
            .map(|reference| reference.source_id.capacity() as u64)
            .sum::<u64>()
}

fn warnings_bytes(warnings: &Vec<GenerationWarning>) -> u64 {
    vector_bytes(warnings)
        + warnings
            .iter()
            .map(|warning| (warning.code.capacity() + warning.message.capacity()) as u64)
            .sum::<u64>()
}

fn metrics_bytes(metrics: &GenerationMetrics) -> u64 {
    metrics
        .counters
        .keys()
        .map(|name| (name.capacity() + size_of::<String>() + size_of::<u64>() * 2) as u64)
        .sum()
}

#[derive(Clone, Debug)]
pub(crate) struct SampleRecord {
    pub seed: u32,
    pub source_path: Arc<str>,
    pub source_graph_hash: [u8; 32],
    pub request_document_revision: u64,
    pub request_hash: [u8; 32],
    pub map_hash: [u8; 32],
    pub dimensions: MapDimensions,
    pub warnings: Vec<GenerationWarning>,
    pub metrics: GenerationMetrics,
    pub preview_requested: bool,
    pub execution_cost: Option<ExecutionCostSummary>,
}

impl SampleRecord {
    fn heap_bytes(&self) -> u64 {
        (size_of::<Self>() + self.source_path.len()) as u64
            + warnings_bytes(&self.warnings)
            + metrics_bytes(&self.metrics)
    }
}

const DECODED_MAPS: usize = 2;

#[derive(Debug)]
pub(crate) struct RetainedStore {
    records: Vec<Option<SampleRecord>>,
    bodies: Vec<Option<Arc<CompactMap>>>,
    present: BTreeSet<u32>,
    batches: Vec<Range<u32>>,
    body_bytes: u64,
    record_bytes: u64,
    budget: u64,
    cursor: u32,
    decoded: VecDeque<(u32, Arc<GeneratedMap>)>,
    evictions: u64,
    peak_body_bytes: u64,
    stored_bytes: u64,
    stored_maps: u64,
}

impl RetainedStore {
    pub(crate) fn new(budget: u64) -> Self {
        Self {
            records: Vec::new(),
            bodies: Vec::new(),
            present: BTreeSet::new(),
            batches: Vec::new(),
            body_bytes: 0,
            record_bytes: 0,
            budget,
            cursor: 0,
            decoded: VecDeque::new(),
            evictions: 0,
            peak_body_bytes: 0,
            stored_bytes: 0,
            stored_maps: 0,
        }
    }

    pub(crate) fn len(&self) -> u32 {
        self.records.len() as u32
    }

    pub(crate) fn begin_batch(&mut self, count: u32) -> u32 {
        let first = self.len();
        self.records
            .extend(std::iter::repeat_with(|| None).take(count as usize));
        self.bodies
            .extend(std::iter::repeat_with(|| None).take(count as usize));
        self.batches.push(first..first + count);
        first
    }

    pub(crate) fn abandon_batch(&mut self, first: u32) {
        for handle in first..self.len() {
            self.drop_body(handle);
            if let Some(record) = self.records[handle as usize].take() {
                self.record_bytes = self.record_bytes.saturating_sub(record.heap_bytes());
            }
        }
        self.records.truncate(first as usize);
        self.bodies.truncate(first as usize);
        self.batches.retain(|batch| batch.start < first);
        self.decoded.retain(|(handle, _)| *handle < first);
    }

    pub(crate) fn insert(&mut self, handle: u32, record: SampleRecord, body: CompactMap) {
        self.record_bytes += record.heap_bytes();
        self.records[handle as usize] = Some(record);
        self.store_body(handle, body, None);
    }

    pub(crate) fn restore(&mut self, handle: u32, body: CompactMap, protected: Range<u32>) {
        if self.bodies[handle as usize].is_none() {
            self.store_body(handle, body, Some(protected));
        }
    }

    fn store_body(&mut self, handle: u32, body: CompactMap, protected: Option<Range<u32>>) {
        let bytes = body.heap_bytes();
        self.stored_bytes += bytes;
        self.stored_maps += 1;
        self.body_bytes += bytes;
        self.bodies[handle as usize] = Some(Arc::new(body));
        self.present.insert(handle);
        while self.body_bytes > self.budget {
            let Some(victim) = self
                .victim(handle, protected.as_ref())
                .or_else(|| self.victim(handle, None))
            else {
                break;
            };
            self.drop_body(victim);
            self.evictions += 1;
        }
        self.peak_body_bytes = self.peak_body_bytes.max(self.body_bytes);
    }

    fn drop_body(&mut self, handle: u32) {
        if let Some(body) = self.bodies[handle as usize].take() {
            self.body_bytes = self.body_bytes.saturating_sub(body.heap_bytes());
            self.present.remove(&handle);
        }
    }

    fn batch_of(&self, handle: u32) -> Range<u32> {
        self.batches
            .iter()
            .find(|batch| batch.contains(&handle))
            .cloned()
            .unwrap_or(handle..handle + 1)
    }

    fn victim(&self, handle: u32, protected: Option<&Range<u32>>) -> Option<u32> {
        let batch = self.batch_of(handle);
        let allowed = |candidate: &u32| protected.is_none_or(|range| !range.contains(candidate));
        if let Some(other) = self
            .present
            .range(..batch.start)
            .chain(self.present.range(batch.end..))
            .copied()
            .find(allowed)
        {
            return Some(other);
        }
        let read_until = self.cursor.clamp(batch.start, batch.end);
        if let Some(read) = self
            .present
            .range(batch.start..read_until)
            .copied()
            .find(allowed)
        {
            return Some(read);
        }
        self.present
            .range(read_until..batch.end)
            .rev()
            .copied()
            .find(allowed)
    }

    pub(crate) fn record(&self, handle: u32) -> Option<&SampleRecord> {
        self.records.get(handle as usize)?.as_ref()
    }

    pub(crate) fn records(&self) -> impl DoubleEndedIterator<Item = (u32, &SampleRecord)> {
        self.records
            .iter()
            .enumerate()
            .filter_map(|(handle, record)| record.as_ref().map(|record| (handle as u32, record)))
    }

    pub(crate) fn lookup(&mut self, handle: u32) -> Lookup {
        self.cursor = handle;
        self.peek(handle)
    }

    pub(crate) fn peek(&self, handle: u32) -> Lookup {
        if let Some((_, map)) = self.decoded.iter().find(|(cached, _)| *cached == handle) {
            return Lookup::Decoded(map.clone());
        }
        match self.bodies.get(handle as usize) {
            Some(Some(body)) => Lookup::Compact(body.clone()),
            Some(None) => Lookup::Missing,
            None => Lookup::Invalid,
        }
    }

    pub(crate) fn remember(&mut self, handle: u32, map: Arc<GeneratedMap>) {
        if self.decoded.iter().any(|(cached, _)| *cached == handle) {
            return;
        }
        if self.decoded.len() == DECODED_MAPS {
            self.decoded.pop_front();
        }
        self.decoded.push_back((handle, map));
    }

    pub(crate) fn read_ahead(&self, workers: usize) -> usize {
        let average = self
            .stored_bytes
            .checked_div(self.stored_maps)
            .unwrap_or(0)
            .max(1);
        let capacity = usize::try_from(self.budget / average).unwrap_or(usize::MAX);
        workers.min(capacity).max(1)
    }

    pub(crate) fn missing_from(&self, handle: u32, count: usize) -> Vec<u32> {
        let batch = self.batch_of(handle);
        (handle..batch.end)
            .filter(|candidate| {
                self.bodies[*candidate as usize].is_none()
                    && self.records[*candidate as usize].is_some()
            })
            .take(count.max(1))
            .collect()
    }

    pub(crate) fn evictions(&self) -> u64 {
        self.evictions
    }

    pub(crate) fn peak_body_bytes(&self) -> u64 {
        self.peak_body_bytes
    }
}

pub(crate) enum Lookup {
    Decoded(Arc<GeneratedMap>),
    Compact(Arc<CompactMap>),
    Missing,
    Invalid,
}
