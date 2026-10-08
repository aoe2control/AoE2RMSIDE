use std::collections::BTreeMap;
use std::thread;
use std::time::Duration;

use rms_content::{ObjectId, TerrainId, TerrainLayerClass};
use rms_engine::{
    CancellationOutcome, CancellationToken, CliffEdge, ConnectionKind, GeneratedMap,
    GenerationBackend, GenerationError, GenerationMetrics, GenerationWarning, MapConnection,
    MapCoordinate, PlacedObject, ProvenanceReference, ResolvedGenerationInput, TileFlags,
    presentation_stage_hash,
};
use rms_trace::{
    CliffMutation, ConnectionMutation, GenerationEvent, GenerationEventKind, GenerationEventSink,
    GenerationStage, MutationBatch, MutationOperation, ObjectMutation, TileMutation, TraceLevel,
};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub struct SyntheticGenerationOptions {
    pub delay_per_stage: Duration,
    pub deliberate_failure: Option<GenerationStage>,
    pub fixture: SyntheticFixtureScenario,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SyntheticFixtureScenario {
    #[default]
    Representative,
    Colocated,
    Legend,
    Large,
    Delayed,
    Failure,
    Cancellable,
}

impl Default for SyntheticGenerationOptions {
    fn default() -> Self {
        Self {
            delay_per_stage: Duration::ZERO,
            deliberate_failure: None,
            fixture: SyntheticFixtureScenario::Representative,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct SyntheticGenerationBackend {
    options: SyntheticGenerationOptions,
}

impl SyntheticGenerationBackend {
    pub fn new(options: SyntheticGenerationOptions) -> Self {
        Self { options }
    }
}

pub type SyntheticBackend = SyntheticGenerationBackend;

impl GenerationBackend for SyntheticGenerationBackend {
    fn backend_id(&self) -> &'static str {
        "synthetic-generation-v1"
    }

    fn generate(
        &self,
        input: ResolvedGenerationInput<'_>,
        events: &mut dyn GenerationEventSink,
        cancellation: &dyn CancellationToken,
    ) -> Result<GeneratedMap, GenerationError> {
        input.validate_for_backend(self.backend_id())?;
        let tile_count = input.request.dimensions.tile_count()?;
        let mut sequence = 0_u64;
        let mut emitted_events = 0_u64;
        let legacy_mode_context = legacy_synthetic_mode_context(input.request);
        let legacy_semantic_hash = input
            .semantic_program
            .legacy_synthetic_fixture_hash(input.request.players.len() as u8, &legacy_mode_context);
        let mut rng = SyntheticRng::new(input.request.seed, &legacy_semantic_hash);
        let mut terrain = vec![TerrainId(0); tile_count];
        let mut layer = vec![0_u16; tile_count];
        let mut elevation = vec![0_i16; tile_count];
        let mut land_zone = vec![0_u32; tile_count];
        let mut terrain_zone = vec![0_u32; tile_count];
        let mut flags = vec![TileFlags::default(); tile_count];
        let mut cliffs = Vec::new();
        let mut connections = Vec::new();
        let mut objects = Vec::new();
        let mut stage_hashes = Vec::with_capacity(GenerationStage::ORDERED.len());
        let terrain_operation = provenance_operation_index(input, &["terrain", "land"]);
        let object_operation = provenance_operation_index(input, &["object"]);
        let cliff_operation = provenance_operation_index(input, &["cliff"]);
        let connection_operation = provenance_operation_index(input, &["connect"]);
        let tile_operation_indices = vec![terrain_operation; tile_count];
        let mut object_operation_indices = Vec::new();
        let mut cliff_operation_indices = Vec::new();
        let mut connection_operation_indices = Vec::new();

        for stage in GenerationStage::ORDERED {
            cancellation_checkpoint(cancellation, stage, 0)?;
            emit(
                input.request.trace_level,
                events,
                &mut sequence,
                &mut emitted_events,
                GenerationEvent {
                    sequence: 0,
                    stage,
                    kind: GenerationEventKind::StageStarted,
                    completed: 0,
                    total: tile_count as u64,
                    state_hash: None,
                    detail: Some(format!("synthetic {} stage", stage.as_str())),
                    mutations: None,
                },
                false,
            )?;
            if self.options.delay_per_stage > Duration::ZERO {
                delay_with_cancellation(self.options.delay_per_stage, cancellation, stage)?;
            }
            if self.options.deliberate_failure == Some(stage) {
                return Err(GenerationError::BackendFailure {
                    stage,
                    message: "development fixture failed after strict analysis".to_owned(),
                });
            }
            match stage {
                GenerationStage::Setup => {
                    emit_rng_checkpoint(
                        input.request.trace_level,
                        events,
                        &mut sequence,
                        &mut emitted_events,
                        stage,
                        &rng,
                    )?;
                    for (operation_index, operation) in
                        input.semantic_program.operations.iter().enumerate()
                    {
                        emit(
                            input.request.trace_level,
                            events,
                            &mut sequence,
                            &mut emitted_events,
                            GenerationEvent {
                                sequence: 0,
                                stage,
                                kind: GenerationEventKind::Progress,
                                completed: (operation_index + 1) as u64,
                                total: input.semantic_program.operations.len() as u64,
                                state_hash: None,
                                detail: Some(format!("parser-decision: {}", operation.name)),
                                mutations: None,
                            },
                            true,
                        )?;
                    }
                }
                GenerationStage::Land => {
                    emit(
                        input.request.trace_level,
                        events,
                        &mut sequence,
                        &mut emitted_events,
                        GenerationEvent {
                            sequence: 0,
                            stage,
                            kind: GenerationEventKind::Progress,
                            completed: 0,
                            total: 1,
                            state_hash: None,
                            detail: Some(
                                "attempt: deterministic synthetic land placement".to_owned(),
                            ),
                            mutations: None,
                        },
                        true,
                    )?;
                    emit(
                        input.request.trace_level,
                        events,
                        &mut sequence,
                        &mut emitted_events,
                        GenerationEvent {
                            sequence: 0,
                            stage,
                            kind: GenerationEventKind::Warning,
                            completed: 0,
                            total: 1,
                            state_hash: None,
                            detail: Some(
                                "rejection: deterministic synthetic collision sample".to_owned(),
                            ),
                            mutations: None,
                        },
                        true,
                    )?;
                    for (index, zone) in land_zone.iter_mut().enumerate() {
                        if index % 4096 == 0 {
                            cancellation_checkpoint(cancellation, stage, index as u64)?;
                        }
                        let x = index % usize::from(input.request.dimensions.width);
                        *zone = if x < usize::from(input.request.dimensions.width) / 2 {
                            1
                        } else {
                            2
                        };
                    }
                    if input.request.dimensions.width > 1 && input.request.dimensions.height > 1 {
                        cliffs.push(CliffEdge {
                            from: MapCoordinate { x: 0, y: 0 },
                            to: MapCoordinate { x: 1, y: 0 },
                            cliff_type: 1,
                        });
                        cliff_operation_indices.push(cliff_operation);
                        connections.push(MapConnection {
                            start: MapCoordinate { x: 0, y: 0 },
                            end: MapCoordinate {
                                x: input.request.dimensions.width - 1,
                                y: input.request.dimensions.height - 1,
                            },
                            kind: ConnectionKind::Land,
                        });
                        connection_operation_indices.push(connection_operation);
                    }
                    emit_tile_batches(
                        input.request.trace_level,
                        events,
                        &mut sequence,
                        &mut emitted_events,
                        stage,
                        &terrain,
                        &layer,
                        &elevation,
                        &land_zone,
                        &terrain_zone,
                        &flags,
                        &tile_operation_indices,
                        &cliffs,
                        &cliff_operation_indices,
                        &connections,
                        &connection_operation_indices,
                        cancellation,
                    )?;
                }
                GenerationStage::Terrain => {
                    let available = input.content.terrains();
                    if available.is_empty() {
                        return Err(GenerationError::InvalidContent(
                            "synthetic backend needs at least one terrain".to_owned(),
                        ));
                    }
                    for index in 0..tile_count {
                        if index % 4096 == 0 {
                            cancellation_checkpoint(cancellation, stage, index as u64)?;
                        }
                        let random = rng.next_u64();
                        let definition = &available[(random as usize) % available.len()];
                        terrain[index] = definition.id;
                        layer[index] = match definition.layer_class {
                            TerrainLayerClass::Land => 1,
                            TerrainLayerClass::Water => 2,
                            TerrainLayerClass::Beach => 3,
                            TerrainLayerClass::Ice => 4,
                            TerrainLayerClass::Overlay => 5,
                        };
                        elevation[index] = ((random >> 32) % 8) as i16;
                        terrain_zone[index] = definition.id.0;
                        flags[index] = TileFlags(
                            u32::from(definition.passable) | (u32::from(definition.buildable) << 1),
                        );
                    }
                    emit_tile_batches(
                        input.request.trace_level,
                        events,
                        &mut sequence,
                        &mut emitted_events,
                        stage,
                        &terrain,
                        &layer,
                        &elevation,
                        &land_zone,
                        &terrain_zone,
                        &flags,
                        &tile_operation_indices,
                        &[],
                        &[],
                        &[],
                        &[],
                        cancellation,
                    )?;
                    emit_rng_checkpoint(
                        input.request.trace_level,
                        events,
                        &mut sequence,
                        &mut emitted_events,
                        stage,
                        &rng,
                    )?;
                }
                GenerationStage::Objects => {
                    if let Some(definition) = input.content.object(ObjectId(1)) {
                        for player in &input.request.players {
                            cancellation_checkpoint(cancellation, stage, objects.len() as u64)?;
                            let x = rng.next_u64() % u64::from(input.request.dimensions.width);
                            let y = rng.next_u64() % u64::from(input.request.dimensions.height);
                            let resources = definition.initial_resources().ok_or_else(|| {
                                GenerationError::InvalidContent(
                                    "fixture resource slots unavailable".to_owned(),
                                )
                            })?;
                            objects.push(PlacedObject {
                                instance_id: u32::try_from(objects.len()).unwrap_or(u32::MAX),
                                object_id: ObjectId(1),
                                x_256: x as u32 * 256 + 128,
                                y_256: y as u32 * 256 + 128,
                                z_256: 0,
                                owner: player.slot,
                                facet: (rng.next_u64() % 8) as u16,
                                footprint_width_256: definition.footprint_width_256,
                                footprint_height_256: definition.footprint_height_256,
                                presentation_kind: u8::from(
                                    definition.name.to_ascii_lowercase().contains("wall"),
                                ),
                                resource_type: resources.resource_type,
                                resource_quantity_f32_bits: resources.quantity_f32_bits,
                                resource_delta: 0,
                                status: 0,
                                death_state: 0,
                                data_status: 0,
                                selection_flags: 0,
                                behavior_flags: 0,
                            });
                            object_operation_indices.push(object_operation);
                        }
                    }
                    apply_fixture_objects(
                        self.options.fixture,
                        &mut objects,
                        &mut object_operation_indices,
                        input.semantic_program.operations.len(),
                    );
                    emit_object_batches(
                        input.request.trace_level,
                        events,
                        &mut sequence,
                        &mut emitted_events,
                        ObjectBatchInput {
                            stage,
                            objects: &objects,
                            operation_indices: &object_operation_indices,
                            cancellation,
                        },
                    )?;
                }
                GenerationStage::Finalize => {}
            }
            let state_hash = stage_hash(
                stage,
                input.request.dimensions,
                &terrain,
                &layer,
                &elevation,
                &land_zone,
                &terrain_zone,
                &flags,
                &cliffs,
                &connections,
                &objects,
            );
            stage_hashes.push((stage, state_hash));
            emit(
                input.request.trace_level,
                events,
                &mut sequence,
                &mut emitted_events,
                GenerationEvent {
                    sequence: 0,
                    stage,
                    kind: GenerationEventKind::StageCompleted,
                    completed: tile_count as u64,
                    total: tile_count as u64,
                    state_hash: Some(state_hash),
                    detail: None,
                    mutations: None,
                },
                false,
            )?;
        }

        let provenance = input
            .semantic_program
            .operations
            .iter()
            .map(|operation| ProvenanceReference {
                source_id: operation.source_id.as_str().to_owned(),
                byte_start: operation.source_range.start.0,
                byte_end: operation.source_range.end.0,
                operation_identity: operation.identity,
            })
            .collect();
        let allocated_bytes = allocation_bytes(
            &terrain,
            &layer,
            &elevation,
            &land_zone,
            &terrain_zone,
            &flags,
            &cliffs,
            &connections,
            &objects,
        );
        let object_count = objects.len() as u64;
        let pre_connection_terrain = terrain.clone();
        let mut map = GeneratedMap {
            dimensions: input.request.dimensions,
            terrain,
            pre_connection_terrain,
            layer,
            elevation,
            land_zone,
            terrain_zone,
            flags,
            cliffs,
            cliff_pieces: Vec::new(),
            appearance_objects: Vec::new(),
            connections,
            connection_routes: None,
            objects,
            tile_operation_indices,
            object_operation_indices,
            cliff_operation_indices,
            connection_operation_indices,
            stage_hashes,
            final_semantic_hash: [0; 32],
            warnings: vec![GenerationWarning {
                code: "RMSGEN-SYNTHETIC".to_owned(),
                message: "Synthetic output is deterministic but not game-compatible.".to_owned(),
            }],
            metrics: GenerationMetrics {
                tile_count: tile_count as u64,
                object_count,
                allocated_bytes,
                emitted_events,
                counters: BTreeMap::from([("rng-checkpoints".to_owned(), 2)]),
            },
            provenance,
        };
        map.finalize_semantic_hash()?;
        map.validate()?;
        Ok(map)
    }
}

fn emit(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    emitted: &mut u64,
    mut event: GenerationEvent,
    full_only: bool,
) -> Result<(), GenerationError> {
    if full_only && level != TraceLevel::Full {
        return Ok(());
    }
    *sequence += 1;
    event.sequence = *sequence;
    sink.emit(event)?;
    *emitted += 1;
    Ok(())
}

fn emit_rng_checkpoint(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    emitted: &mut u64,
    stage: GenerationStage,
    rng: &SyntheticRng,
) -> Result<(), GenerationError> {
    let state_hash: [u8; 32] = Sha256::digest(rng.state.to_le_bytes()).into();
    emit(
        level,
        sink,
        sequence,
        emitted,
        GenerationEvent {
            sequence: 0,
            stage,
            kind: GenerationEventKind::RngCheckpoint,
            completed: 0,
            total: 0,
            state_hash: Some(state_hash),
            detail: Some("synthetic RNG checkpoint".to_owned()),
            mutations: None,
        },
        true,
    )
}

fn cancellation_checkpoint(
    cancellation: &dyn CancellationToken,
    stage: GenerationStage,
    completed_units: u64,
) -> Result<(), GenerationError> {
    if cancellation.is_cancelled() {
        return Err(GenerationError::Cancelled(CancellationOutcome {
            stage,
            completed_units,
            transactional: true,
        }));
    }
    Ok(())
}

fn delay_with_cancellation(
    duration: Duration,
    cancellation: &dyn CancellationToken,
    stage: GenerationStage,
) -> Result<(), GenerationError> {
    let mut elapsed = Duration::ZERO;
    while elapsed < duration {
        cancellation_checkpoint(cancellation, stage, elapsed.as_millis() as u64)?;
        let slice = (duration - elapsed).min(Duration::from_millis(10));
        thread::sleep(slice);
        elapsed += slice;
    }
    cancellation_checkpoint(cancellation, stage, elapsed.as_millis() as u64)
}

fn provenance_operation_index(input: ResolvedGenerationInput<'_>, needles: &[&str]) -> u32 {
    input
        .semantic_program
        .operations
        .iter()
        .position(|operation| {
            let section = operation.section.to_ascii_lowercase();
            let name = operation.name.to_ascii_lowercase();
            needles
                .iter()
                .any(|needle| section.contains(needle) || name.contains(needle))
        })
        .or_else(|| (!input.semantic_program.operations.is_empty()).then_some(0))
        .and_then(|index| u32::try_from(index).ok())
        .unwrap_or(u32::MAX)
}

#[allow(clippy::too_many_arguments)]
fn emit_tile_batches(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    emitted: &mut u64,
    stage: GenerationStage,
    terrain: &[TerrainId],
    layer: &[u16],
    elevation: &[i16],
    land_zone: &[u32],
    terrain_zone: &[u32],
    flags: &[TileFlags],
    operation_indices: &[u32],
    cliffs: &[CliffEdge],
    cliff_operation_indices: &[u32],
    connections: &[MapConnection],
    connection_operation_indices: &[u32],
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    let total = terrain.len();
    for first in (0..total).step_by(1024) {
        cancellation_checkpoint(cancellation, stage, first as u64)?;
        let end = (first + 1024).min(total);
        let tiles = (first..end)
            .map(|index| TileMutation {
                tile_index: index as u32,
                terrain_id: terrain[index].0,
                elevation: elevation[index],
                terrain_zone: terrain_zone[index],
                land_id: land_zone[index],
                layer_id: layer[index],
                flags: flags[index].0,
                operation: MutationOperation::Replace,
                provenance_operation_index: operation_indices[index],
            })
            .collect();
        let include_foreground = first == 0;
        let cliff_mutations = if include_foreground {
            cliffs
                .iter()
                .zip(cliff_operation_indices)
                .enumerate()
                .map(|(index, (edge, operation_index))| CliffMutation {
                    cliff_index: index as u32,
                    from_x: edge.from.x,
                    from_y: edge.from.y,
                    to_x: edge.to.x,
                    to_y: edge.to.y,
                    cliff_type: edge.cliff_type,
                    operation: MutationOperation::Replace,
                    provenance_operation_index: *operation_index,
                })
                .collect()
        } else {
            Vec::new()
        };
        let connection_mutations = if include_foreground {
            connections
                .iter()
                .zip(connection_operation_indices)
                .enumerate()
                .map(
                    |(index, (connection, operation_index))| ConnectionMutation {
                        connection_index: index as u32,
                        start_x: connection.start.x,
                        start_y: connection.start.y,
                        end_x: connection.end.x,
                        end_y: connection.end.y,
                        kind: match connection.kind {
                            ConnectionKind::Land => 0,
                            ConnectionKind::Water => 1,
                            ConnectionKind::Road => 2,
                        },
                        operation: MutationOperation::Replace,
                        provenance_operation_index: *operation_index,
                    },
                )
                .collect()
        } else {
            Vec::new()
        };
        emit(
            level,
            sink,
            sequence,
            emitted,
            GenerationEvent {
                sequence: 0,
                stage,
                kind: GenerationEventKind::MutationBatch,
                completed: end as u64,
                total: total as u64,
                state_hash: None,
                detail: (level == TraceLevel::Full)
                    .then(|| format!("replace tiles {first} through {}", end - 1)),
                mutations: Some(MutationBatch {
                    tiles,
                    objects: Vec::new(),
                    cliffs: cliff_mutations,
                    connections: connection_mutations,
                }),
            },
            false,
        )?;
    }
    Ok(())
}

struct ObjectBatchInput<'a> {
    stage: GenerationStage,
    objects: &'a [PlacedObject],
    operation_indices: &'a [u32],
    cancellation: &'a dyn CancellationToken,
}

fn emit_object_batches(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    emitted: &mut u64,
    input: ObjectBatchInput<'_>,
) -> Result<(), GenerationError> {
    for first in (0..input.objects.len()).step_by(256) {
        cancellation_checkpoint(input.cancellation, input.stage, first as u64)?;
        let end = (first + 256).min(input.objects.len());
        let mutations = input.objects[first..end]
            .iter()
            .zip(&input.operation_indices[first..end])
            .enumerate()
            .map(|(offset, (object, operation_index))| ObjectMutation {
                object_index: (first + offset) as u32,
                object_id: object.object_id.0,
                x_256: object.x_256,
                y_256: object.y_256,
                owner: object.owner,
                facet: object.facet,
                footprint_width_256: object.footprint_width_256,
                footprint_height_256: object.footprint_height_256,
                presentation_kind: object.presentation_kind,
                operation: MutationOperation::Replace,
                provenance_operation_index: *operation_index,
                resource_type: object.resource_type,
                resource_quantity_f32_bits: object.resource_quantity_f32_bits,
                resource_delta: object.resource_delta,
                status: object.status,
                death_state: i32::from(object.death_state),
                data_status: i32::from(object.data_status),
                selection_flags: u32::from(object.selection_flags),
                behavior_flags: u32::from(object.behavior_flags),
            })
            .collect();
        emit(
            level,
            sink,
            sequence,
            emitted,
            GenerationEvent {
                sequence: 0,
                stage: input.stage,
                kind: GenerationEventKind::MutationBatch,
                completed: end as u64,
                total: input.objects.len() as u64,
                state_hash: None,
                detail: (level == TraceLevel::Full)
                    .then(|| format!("replace objects {first} through {}", end - 1)),
                mutations: Some(MutationBatch {
                    tiles: Vec::new(),
                    objects: mutations,
                    cliffs: Vec::new(),
                    connections: Vec::new(),
                }),
            },
            false,
        )?;
    }
    Ok(())
}

fn apply_fixture_objects(
    scenario: SyntheticFixtureScenario,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    operation_count: usize,
) {
    if !matches!(
        scenario,
        SyntheticFixtureScenario::Colocated | SyntheticFixtureScenario::Legend
    ) || objects.is_empty()
    {
        return;
    }
    objects[0].x_256 = 128;
    objects[0].y_256 = 128;
    let mut wall = objects[0].clone();
    wall.presentation_kind = 1;
    objects.push(wall);
    operation_indices.push(operation_indices[0]);
    if scenario != SyntheticFixtureScenario::Legend {
        return;
    }
    let first_operation = operation_indices[0];
    let alternate_operation = if operation_count > 1 && first_operation == 0 {
        1
    } else {
        0
    };
    for index in 0..52_u32 {
        let mut object = objects[0].clone();
        object.object_id = ObjectId(if index < 2 { 777 } else { 100 + index });
        object.owner = 0;
        object.presentation_kind = u8::from(index % 5 == 4);
        objects.push(object);
        operation_indices.push(if index == 1 {
            alternate_operation
        } else {
            first_operation
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn stage_hash(
    stage: GenerationStage,
    dimensions: rms_engine::MapDimensions,
    terrain: &[TerrainId],
    layer: &[u16],
    elevation: &[i16],
    land_zone: &[u32],
    terrain_zone: &[u32],
    flags: &[TileFlags],
    cliffs: &[CliffEdge],
    connections: &[MapConnection],
    objects: &[PlacedObject],
) -> [u8; 32] {
    presentation_stage_hash(
        stage,
        dimensions,
        terrain,
        layer,
        elevation,
        land_zone,
        terrain_zone,
        flags,
        cliffs,
        connections,
        objects,
    )
}

#[allow(clippy::too_many_arguments)]
fn allocation_bytes(
    terrain: &[TerrainId],
    layer: &[u16],
    elevation: &[i16],
    land_zone: &[u32],
    terrain_zone: &[u32],
    flags: &[TileFlags],
    cliffs: &[CliffEdge],
    connections: &[MapConnection],
    objects: &[PlacedObject],
) -> u64 {
    let lengths = [
        size_of_val(terrain),
        size_of_val(layer),
        size_of_val(elevation),
        size_of_val(land_zone),
        size_of_val(terrain_zone),
        size_of_val(flags),
        size_of_val(cliffs),
        size_of_val(connections),
        size_of_val(objects),
    ];
    lengths.into_iter().map(|value| value as u64).sum()
}

#[derive(Clone, Copy, Debug)]
struct SyntheticRng {
    state: u64,
}

fn legacy_synthetic_mode_context(request: &rms_engine::GenerationRequest) -> String {
    if request.setup_context == rms_engine::SetupContext::default() {
        return "random-map".to_owned();
    }
    let colors = request
        .players
        .iter()
        .map(|player| player.color.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "aoe2:gm={};r={};a={};p={};c={colors}",
        request.setup_context.game_mode.native_value(),
        request.setup_context.starting_resources.native_value(),
        request.setup_context.starting_age.native_value(),
        request.setup_context.position_policy.native_value(),
    )
}

impl SyntheticRng {
    fn new(seed: u32, semantic_hash: &[u8; 32]) -> Self {
        let mut hash_seed = [0_u8; 8];
        hash_seed.copy_from_slice(&semantic_hash[..8]);
        Self {
            state: u64::from(seed) ^ u64::from_le_bytes(hash_seed) ^ 0x9e37_79b9_7f4a_7c15,
        }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut value = self.state;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        value ^ (value >> 31)
    }
}
