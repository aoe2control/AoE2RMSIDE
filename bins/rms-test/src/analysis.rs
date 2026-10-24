use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Result, anyhow, bail};
use rms_content::CompatibleContentView;
use rms_engine::GeneratedMap;
use starlark::environment::GlobalsBuilder;
use starlark::eval::Evaluator;
use starlark::starlark_module;
use starlark::values::structs::AllocStruct;
use starlark::values::tuple::AllocTuple;
use starlark::values::{Heap, Value};

use crate::records::PlayerRecord;
use crate::walk::{
    self, Field, MAX_PLAYER_SLOT, PassageResult, WalkGrid, WalkRules, cost_within, whole_tiles,
};
use crate::{
    HostState, StopCheck, alloc_object, bounded_set, check_heap, constant_id, host,
    optional_id_list, optional_u32, sample, sample_map, tile_filter, unpack_u32, walk_filter,
};

const ANALYSED_SAMPLES: usize = 2;
pub(crate) const MAX_FIELDS_PER_SAMPLE: usize = 32;
pub(crate) const MAX_FIELD_KEYS: usize = 65_536;
pub(crate) const MAX_PLACES: usize = 64;
pub(crate) const DEFAULT_PASSAGE_LIMIT: u32 = 16;
pub(crate) const MAX_PASSAGE_LIMIT: u32 = 64;
pub(crate) const MAX_LISTED_PASSAGES: usize = 8;
pub(crate) const MAX_NEAREST: u32 = 64;

const PLACE_MESSAGE: &str =
    "a place is a tile (x, y), an object, or a player of sample.players, or a list of them";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct AnalysisHints {
    pub walk: bool,
    pub start_fields: bool,
}

impl AnalysisHints {
    pub(crate) fn parse(values: Option<Vec<String>>) -> Result<Self> {
        let mut hints = Self::default();
        for value in values.unwrap_or_default() {
            match value.as_str() {
                "walk" => hints.walk = true,
                "fields:starts" => {
                    hints.walk = true;
                    hints.start_fields = true;
                }
                other => bail!(
                    "rms.generate analyse takes \"walk\" and \"fields:starts\", not \"{}\"",
                    other.escape_debug()
                ),
            }
        }
        Ok(hints)
    }

    pub(crate) fn any(self) -> bool {
        self.walk || self.start_fields
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct FieldKey {
    open_for: Option<u8>,
    max_cost: Option<u32>,
    sources: Arc<[u32]>,
}

impl FieldKey {
    fn heap_bytes(&self) -> u64 {
        (self.sources.len() * std::mem::size_of::<u32>()) as u64
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct Prewarmed {
    grid: Arc<WalkGrid>,
    fields: Vec<(FieldKey, Arc<Field>)>,
}

impl Prewarmed {
    pub(crate) fn grid(&self) -> &Arc<WalkGrid> {
        &self.grid
    }

    pub(crate) fn walk_hash(&self) -> [u8; 32] {
        self.grid.hash()
    }

    pub(crate) fn heap_bytes(&self) -> u64 {
        self.grid.heap_bytes()
            + self
                .fields
                .iter()
                .map(|(key, field)| key.heap_bytes() + field.heap_bytes())
                .sum::<u64>()
    }
}

pub(crate) fn prewarm(
    rules: &WalkRules,
    map: &GeneratedMap,
    players: &[PlayerRecord],
    hints: AnalysisHints,
    stop: &dyn StopCheck,
) -> Result<Prewarmed> {
    let grid = Arc::new(WalkGrid::build(rules, map, stop)?);
    let mut fields = Vec::new();
    if hints.start_fields {
        for player in players {
            let Some(place) = player_place(player) else {
                continue;
            };
            let open_for = Some(player.slot).filter(|slot| (1..=MAX_PLAYER_SLOT).contains(slot));
            let walker = grid.walker(open_for);
            let sources = place_tiles(rules, &grid, &walker, &[place])?;
            let key = FieldKey {
                open_for,
                max_cost: None,
                sources: sources.iter().map(|&tile| tile as u32).collect(),
            };
            let field = walk::distance_field(&walker, &sources, None, stop)?;
            fields.push((key, Arc::new(field)));
        }
    }
    Ok(Prewarmed { grid, fields })
}

pub(crate) struct SampleAnalysis {
    pub grid: Arc<WalkGrid>,
    fields: Mutex<VecDeque<(FieldKey, Arc<Field>)>>,
}

impl SampleAnalysis {
    fn field(&self, key: &FieldKey, stop: &dyn StopCheck) -> Result<Arc<Field>> {
        {
            let mut fields = self.fields.lock().expect("map-test fields poisoned");
            if let Some(position) = fields.iter().position(|(cached, _)| cached == key) {
                let entry = fields.remove(position).expect("position is in range");
                let field = entry.1.clone();
                fields.push_back(entry);
                return Ok(field);
            }
        }
        let walker = self.grid.walker(key.open_for);
        let sources = key
            .sources
            .iter()
            .map(|&tile| tile as usize)
            .collect::<Vec<_>>();
        let field = Arc::new(walk::distance_field(&walker, &sources, key.max_cost, stop)?);
        let mut fields = self.fields.lock().expect("map-test fields poisoned");
        if fields.len() == MAX_FIELDS_PER_SAMPLE {
            fields.pop_front();
        }
        fields.push_back((key.clone(), field.clone()));
        Ok(field)
    }
}

#[derive(Default)]
pub(crate) struct AnalysisState {
    rules: OnceLock<std::result::Result<Arc<WalkRules>, String>>,
    samples: Mutex<VecDeque<(u32, Arc<SampleAnalysis>)>>,
    fields: Mutex<FieldRegistry>,
    used: AtomicBool,
}

impl AnalysisState {
    pub(crate) fn used(&self) -> bool {
        self.used.load(Ordering::Relaxed)
    }

    pub(crate) fn mark_used(&self) {
        self.used.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct FieldRegistry {
    keys: Vec<(u32, FieldKey)>,
    index: BTreeMap<(u32, FieldKey), u32>,
}

pub(crate) fn rules(host: &HostState) -> Result<Arc<WalkRules>> {
    host.analysis
        .rules
        .get_or_init(|| {
            let config = &host.context.config;
            CompatibleContentView::new(&config.content, &config.profile.profile_id)
                .map_err(anyhow::Error::from)
                .and_then(|content| {
                    let house = constant_id(&host.context.constants, "HOUSE").ok();
                    WalkRules::new(content, house)
                })
                .map(Arc::new)
                .map_err(|error| format!("{error:#}"))
        })
        .clone()
        .map_err(|message| anyhow!(message))
}

pub(crate) fn checked_grid(
    host: &HostState,
    handle: u32,
    map: &GeneratedMap,
) -> Result<Arc<WalkGrid>> {
    let record = sample(host, handle)?;
    let prewarmed = host
        .retained
        .lock()
        .expect("map-test retained samples poisoned")
        .prewarmed(handle);
    let grid = match prewarmed {
        Some(prewarmed) => prewarmed.grid.clone(),
        None => Arc::new(WalkGrid::build(rules(host)?.as_ref(), map, host)?),
    };
    match record.walk_hash {
        Some(expected) if expected != grid.hash() => bail!(
            "the walking data of seed {} differs from its first generation",
            record.seed
        ),
        Some(_) => {}
        None => host
            .retained
            .lock()
            .expect("map-test retained samples poisoned")
            .set_walk_hash(handle, grid.hash()),
    }
    Ok(grid)
}

pub(crate) fn sample_analysis(
    host: &HostState,
    handle: u32,
) -> Result<(Arc<GeneratedMap>, Arc<SampleAnalysis>)> {
    let map = sample_map(host, handle)?;
    host.analysis.mark_used();
    {
        let mut samples = host
            .analysis
            .samples
            .lock()
            .expect("map-test analyses poisoned");
        if let Some(position) = samples.iter().position(|(cached, _)| *cached == handle) {
            let entry = samples.remove(position).expect("position is in range");
            let analysis = entry.1.clone();
            samples.push_back(entry);
            return Ok((map, analysis));
        }
    }
    let prewarmed = host
        .retained
        .lock()
        .expect("map-test retained samples poisoned")
        .prewarmed(handle);
    let grid = checked_grid(host, handle, &map)?;
    let fields = prewarmed
        .map(|prewarmed| prewarmed.fields.iter().cloned().collect())
        .unwrap_or_default();
    let analysis = Arc::new(SampleAnalysis {
        grid,
        fields: Mutex::new(fields),
    });
    let mut samples = host
        .analysis
        .samples
        .lock()
        .expect("map-test analyses poisoned");
    if samples.len() == ANALYSED_SAMPLES {
        samples.pop_front();
    }
    samples.push_back((handle, analysis.clone()));
    Ok((map, analysis))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Place {
    Tile {
        x: u32,
        y: u32,
    },
    Object {
        object_id: u32,
        x_256: u32,
        y_256: u32,
    },
}

impl Place {
    fn footprint(self, rules: &WalkRules, grid: &WalkGrid) -> Result<(u16, u16, u16, u16)> {
        match self {
            Self::Tile { x, y } => {
                if x >= u32::from(grid.width) || y >= u32::from(grid.height) {
                    bail!("tile ({x}, {y}) is outside the map");
                }
                Ok((x as u16, y as u16, x as u16, y as u16))
            }
            Self::Object {
                object_id,
                x_256,
                y_256,
            } => {
                if x_256 >= u32::from(grid.width) * 256 || y_256 >= u32::from(grid.height) * 256 {
                    bail!("object {object_id} is outside the map");
                }
                Ok(rules
                    .object(object_id)?
                    .covered(x_256, y_256, grid.width, grid.height))
            }
        }
    }

    fn centre_256(self) -> (u64, u64) {
        match self {
            Self::Tile { x, y } => (u64::from(x) * 256 + 128, u64::from(y) * 256 + 128),
            Self::Object { x_256, y_256, .. } => (u64::from(x_256), u64::from(y_256)),
        }
    }
}

pub(crate) fn player_place(player: &PlayerRecord) -> Option<Place> {
    match (&player.town_center, player.start_tile) {
        (Some(object), _) => Some(Place::Object {
            object_id: object.object_id.0,
            x_256: object.x_256,
            y_256: object.y_256,
        }),
        (None, Some((x, y))) => Some(Place::Tile {
            x: u32::from(x),
            y: u32::from(y),
        }),
        (None, None) => None,
    }
}

pub(crate) const MAX_TILE_REACH: u16 = 8;

pub(crate) fn place_tiles(
    rules: &WalkRules,
    grid: &WalkGrid,
    walker: &walk::Walker<'_>,
    places: &[Place],
) -> Result<Vec<usize>> {
    let mut tiles = Vec::new();
    for place in places {
        let (x0, y0, x1, y1) = place.footprint(rules, grid)?;
        let reach = match place {
            Place::Tile { .. } => MAX_TILE_REACH - 1,
            Place::Object { .. } => 0,
        };
        for step in 0..=reach {
            let found = walker.place_tiles((
                x0.saturating_sub(step),
                y0.saturating_sub(step),
                x1.saturating_add(step).min(grid.width - 1),
                y1.saturating_add(step).min(grid.height - 1),
            ));
            if !found.is_empty() {
                tiles.extend(found);
                break;
            }
        }
    }
    tiles.sort_unstable();
    tiles.dedup();
    Ok(tiles)
}

fn attribute<'v>(value: Value<'v>, name: &str, heap: Heap<'v>) -> Result<Value<'v>> {
    value
        .get_attr(name, heap)
        .map_err(|error| anyhow!("{error:#}"))?
        .ok_or_else(|| anyhow!(PLACE_MESSAGE))
}

fn single_place<'v>(value: Value<'v>, heap: Heap<'v>) -> Result<Option<Place>> {
    if value.has_attr("x256", heap) {
        return Ok(Some(Place::Object {
            object_id: unpack_u32(attribute(value, "object_id", heap)?)?,
            x_256: unpack_u32(attribute(value, "x256", heap)?)?,
            y_256: unpack_u32(attribute(value, "y256", heap)?)?,
        }));
    }
    if value.has_attr("slot", heap) && value.has_attr("start_x", heap) {
        let town_center = attribute(value, "town_center", heap)?;
        if !town_center.is_none() {
            return single_place(town_center, heap);
        }
        let x = optional_u32(attribute(value, "start_x", heap)?)?;
        let y = optional_u32(attribute(value, "start_y", heap)?)?;
        return match x.zip(y) {
            Some((x, y)) => Ok(Some(Place::Tile { x, y })),
            None => bail!(
                "player {} has no start on this map",
                unpack_u32(attribute(value, "slot", heap)?)?
            ),
        };
    }
    if value.length().ok() == Some(2)
        && let Ok(items) = value.iterate(heap)
    {
        let items = items.collect::<Vec<_>>();
        if let [x, y] = items.as_slice()
            && x.unpack_i32().is_some()
            && y.unpack_i32().is_some()
        {
            return Ok(Some(Place::Tile {
                x: unpack_u32(*x)?,
                y: unpack_u32(*y)?,
            }));
        }
    }
    Ok(None)
}

pub(crate) fn places<'v>(value: Value<'v>, heap: Heap<'v>) -> Result<Vec<Place>> {
    if let Some(place) = single_place(value, heap)? {
        return Ok(vec![place]);
    }
    let mut result = Vec::new();
    for item in value.iterate(heap).map_err(|_| anyhow!(PLACE_MESSAGE))? {
        if result.len() >= MAX_PLACES {
            bail!("a walking query takes at most {MAX_PLACES} places");
        }
        result.push(single_place(item, heap)?.ok_or_else(|| anyhow!(PLACE_MESSAGE))?);
    }
    if result.is_empty() {
        bail!("a walking query needs at least one place");
    }
    Ok(result)
}

fn parse_open_for(value: Value<'_>) -> Result<Option<u8>> {
    optional_u32(value)?
        .map(|slot| {
            u8::try_from(slot)
                .ok()
                .filter(|slot| (1..=MAX_PLAYER_SLOT).contains(slot))
                .ok_or_else(|| {
                    anyhow!("open_for must be a player slot from 1 to {MAX_PLAYER_SLOT}")
                })
        })
        .transpose()
}

fn optional_whole_tiles(value: Value<'_>, name: &str) -> Result<Option<u32>> {
    optional_u32(value).map_err(|_| anyhow!("{name} must be a whole number of tiles or None"))
}

fn alloc_distance<'v>(heap: Heap<'v>, cost: Option<u32>) -> Value<'v> {
    match cost {
        Some(cost) => heap.alloc(whole_tiles(cost)),
        None => Value::new_none(),
    }
}

fn register_field(host: &HostState, handle: u32, key: FieldKey) -> Result<u32> {
    let mut registry = host
        .analysis
        .fields
        .lock()
        .expect("map-test fields poisoned");
    if let Some(&id) = registry.index.get(&(handle, key.clone())) {
        return Ok(id);
    }
    if registry.keys.len() >= MAX_FIELD_KEYS {
        bail!("a map test can make at most {MAX_FIELD_KEYS} distance fields");
    }
    let id = registry.keys.len() as u32;
    registry.keys.push((handle, key.clone()));
    registry.index.insert((handle, key), id);
    Ok(id)
}

struct NamedField {
    map: Arc<GeneratedMap>,
    analysis: Arc<SampleAnalysis>,
    key: FieldKey,
    costs: Arc<Field>,
}

fn named_field(host: &HostState, id: u32) -> Result<NamedField> {
    let (handle, key) = host
        .analysis
        .fields
        .lock()
        .expect("map-test fields poisoned")
        .keys
        .get(id as usize)
        .cloned()
        .ok_or_else(|| anyhow!("distance field is invalid"))?;
    let (map, analysis) = sample_analysis(host, handle)?;
    let field = analysis.field(&key, host)?;
    Ok(NamedField {
        map,
        analysis,
        key,
        costs: field,
    })
}

#[allow(clippy::too_many_arguments)]
#[starlark_module]
pub(crate) fn analysis_globals(builder: &mut GlobalsBuilder) {
    fn __rms_map_walk_hash(handle: u32, eval: &mut Evaluator) -> anyhow::Result<String> {
        let (_, analysis) = sample_analysis(host(eval)?, handle)?;
        Ok(hex::encode(analysis.grid.hash()))
    }

    fn __rms_walk_distance<'v>(
        handle: u32,
        x1: u32,
        y1: u32,
        x2: u32,
        y2: u32,
        open_for: Value<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let host = host(eval)?;
        let open_for = parse_open_for(open_for)?;
        let (_, analysis) = sample_analysis(host, handle)?;
        let rules = rules(host)?;
        let walker = analysis.grid.walker(open_for);
        let sources = place_tiles(
            &rules,
            &analysis.grid,
            &walker,
            &[Place::Tile { x: x1, y: y1 }],
        )?;
        let targets = place_tiles(
            &rules,
            &analysis.grid,
            &walker,
            &[Place::Tile { x: x2, y: y2 }],
        )?;
        let cost = walk::walk_cost(&walker, &sources, &targets, host)?;
        Ok(alloc_distance(eval.heap(), cost))
    }

    fn __rms_distance_field<'v>(
        handle: u32,
        sources: Value<'v>,
        open_for: Value<'v>,
        max_distance: Value<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<u32> {
        let host = host(eval)?;
        let places = places(sources, eval.heap())?;
        let open_for = parse_open_for(open_for)?;
        let max_cost = optional_whole_tiles(max_distance, "max_distance")?.map(cost_within);
        let (_, analysis) = sample_analysis(host, handle)?;
        let rules = rules(host)?;
        let walker = analysis.grid.walker(open_for);
        let tiles = place_tiles(&rules, &analysis.grid, &walker, &places)?;
        let key = FieldKey {
            open_for,
            max_cost,
            sources: tiles.iter().map(|&tile| tile as u32).collect(),
        };
        let id = register_field(host, handle, key.clone())?;
        analysis.field(&key, host)?;
        Ok(id)
    }

    fn __rms_field_at<'v>(
        field: u32,
        x: u32,
        y: u32,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let NamedField { map, costs, .. } = named_field(host(eval)?, field)?;
        let index = crate::tile_index(&map, x, y)?;
        Ok(alloc_distance(eval.heap(), costs.cost(index)))
    }

    fn __rms_field_to<'v>(
        field: u32,
        place: Value<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let host = host(eval)?;
        let places = places(place, eval.heap())?;
        let NamedField {
            analysis,
            key,
            costs,
            ..
        } = named_field(host, field)?;
        let walker = analysis.grid.walker(key.open_for);
        let targets = place_tiles(rules(host)?.as_ref(), &analysis.grid, &walker, &places)?;
        Ok(alloc_distance(eval.heap(), costs.least(&targets)))
    }

    fn __rms_field_nearest<'v>(
        field: u32,
        object_ids: Value<'v>,
        owner: Value<'v>,
        count: Value<'v>,
        max_distance: Value<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let host = host(eval)?;
        let heap = eval.heap();
        let ids = bounded_set(
            optional_id_list(Some(object_ids), heap, &host.context.constants)?,
            "object ID filter",
        )?
        .ok_or_else(|| anyhow!("nearest needs object_ids"))?;
        let owner = optional_u32(owner)?
            .map(|value| u8::try_from(value).map_err(|_| anyhow!("owner is out of range")))
            .transpose()?;
        let count = optional_u32(count)?.unwrap_or(2);
        if !(1..=MAX_NEAREST).contains(&count) {
            bail!("nearest count must be from 1 to {MAX_NEAREST}");
        }
        let max_cost = optional_whole_tiles(max_distance, "max_distance")?.map(cost_within);
        let NamedField {
            map,
            analysis,
            key,
            costs,
        } = named_field(host, field)?;
        let rules = rules(host)?;
        let walker = analysis.grid.walker(key.open_for);
        let mut found = Vec::new();
        for (index, object) in map.objects.iter().enumerate() {
            if !ids.contains(&object.object_id.0)
                || owner.is_some_and(|owner| object.owner != owner)
            {
                continue;
            }
            if index.is_multiple_of(crate::HOST_CHECK_INTERVAL) {
                host.check()?;
            }
            let place = Place::Object {
                object_id: object.object_id.0,
                x_256: object.x_256,
                y_256: object.y_256,
            };
            let targets = walker.place_tiles(place.footprint(&rules, &analysis.grid)?);
            if let Some(cost) = costs.least(&targets)
                && max_cost.is_none_or(|max_cost| cost <= max_cost)
            {
                found.push((cost, index));
            }
        }
        found.sort_unstable();
        found.truncate(count as usize);
        host.charge_results(found.len())?;
        let values = found
            .into_iter()
            .map(|(cost, index)| {
                heap.alloc(AllocStruct(vec![
                    ("object", alloc_object(heap, &map.objects[index])),
                    ("distance", heap.alloc(whole_tiles(cost))),
                ]))
            })
            .collect::<Vec<_>>();
        let nearest = heap.alloc(AllocTuple(values));
        check_heap(eval)?;
        Ok(nearest)
    }

    fn __rms_field_count_tiles<'v>(
        field: u32,
        max_distance: u32,
        terrain_ids: Option<Value<'v>>,
        land_zone_ids: Option<Value<'v>>,
        terrain_zone_ids: Option<Value<'v>>,
        layer_ids: Option<Value<'v>>,
        walkable: Option<Value<'v>>,
        buildable: Option<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<u32> {
        let host = host(eval)?;
        let filter = tile_filter(
            terrain_ids,
            land_zone_ids,
            terrain_zone_ids,
            layer_ids,
            eval.heap(),
            &host.context.constants,
        )?;
        let NamedField {
            map,
            analysis,
            costs,
            ..
        } = named_field(host, field)?;
        let filter = walk_filter(filter, Some(analysis.grid.clone()), walkable, buildable)?;
        let max_cost = cost_within(max_distance);
        let mut count = 0_u32;
        for index in 0..map.terrain.len() {
            if index.is_multiple_of(crate::HOST_CHECK_INTERVAL) {
                host.check()?;
            }
            if costs.cost(index).is_some_and(|cost| cost <= max_cost) && filter.matches(&map, index)
            {
                count += 1;
            }
        }
        Ok(count)
    }

    fn __rms_narrowest_passage<'v>(
        handle: u32,
        a: Value<'v>,
        b: Value<'v>,
        ring: Value<'v>,
        open_for: Value<'v>,
        limit: Value<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let host = host(eval)?;
        let heap = eval.heap();
        let from = places(a, heap)?;
        let to = if b.is_none() {
            None
        } else {
            Some(places(b, heap)?)
        };
        let ring = optional_u32(ring)
            .map_err(|_| anyhow!("ring must be a whole number of tiles or None"))?;
        let open_for = parse_open_for(open_for)?;
        let limit = optional_u32(limit)?.unwrap_or(DEFAULT_PASSAGE_LIMIT);
        if !(1..=MAX_PASSAGE_LIMIT).contains(&limit) {
            bail!("narrowest_passage limit must be from 1 to {MAX_PASSAGE_LIMIT}");
        }
        let (map, analysis) = sample_analysis(host, handle)?;
        let rules = rules(host)?;
        let grid = &analysis.grid;
        let walker = grid.walker(open_for);
        let sources = place_tiles(&rules, grid, &walker, &from)?;
        let sinks = match (to, ring) {
            (Some(_), Some(_)) => bail!("narrowest_passage takes b or ring, not both"),
            (None, None) => bail!("narrowest_passage needs b or ring"),
            (Some(to), None) => place_tiles(&rules, grid, &walker, &to)?,
            (None, Some(ring)) => {
                let side = u32::from(grid.width.max(grid.height));
                if !(1..=side).contains(&ring) {
                    bail!("ring must be from 1 to {side} tiles");
                }
                let reach = u64::from(ring) * 256;
                let centres = from
                    .iter()
                    .map(|place| place.centre_256())
                    .collect::<Vec<_>>();
                let width = usize::from(grid.width);
                (0..grid.tile_count())
                    .filter(|&tile| {
                        let x = (tile % width) as u64 * 256 + 128;
                        let y = (tile / width) as u64 * 256 + 128;
                        walker.open(tile)
                            && centres.iter().all(|&(cx, cy)| {
                                let (dx, dy) = (x.abs_diff(cx), y.abs_diff(cy));
                                dx * dx + dy * dy >= reach * reach
                            })
                    })
                    .collect()
            }
        };
        let result = walk::narrowest_passage(&walker, &sources, &sinks, limit, host)?;
        let width = usize::from(map.dimensions.width);
        let value = match result {
            PassageResult::Capped => heap.alloc(AllocStruct(vec![
                ("width", heap.alloc(limit)),
                ("capped", heap.alloc(true)),
                ("routes", Value::new_none()),
                ("passages", heap.alloc(AllocTuple(Vec::<Value>::new()))),
            ])),
            PassageResult::Cut {
                width: cut,
                passages,
            } => {
                host.charge_results(passages.len().min(MAX_LISTED_PASSAGES) + 1)?;
                let listed = passages
                    .iter()
                    .take(MAX_LISTED_PASSAGES)
                    .map(|passage| {
                        heap.alloc(AllocStruct(vec![
                            ("width", heap.alloc(passage.width)),
                            ("x", heap.alloc((passage.tile % width) as u32)),
                            ("y", heap.alloc((passage.tile / width) as u32)),
                        ]))
                    })
                    .collect::<Vec<_>>();
                heap.alloc(AllocStruct(vec![
                    ("width", heap.alloc(cut)),
                    ("capped", heap.alloc(false)),
                    ("routes", heap.alloc(passages.len() as u32)),
                    ("passages", heap.alloc(AllocTuple(listed))),
                ]))
            }
        };
        check_heap(eval)?;
        Ok(value)
    }
}
