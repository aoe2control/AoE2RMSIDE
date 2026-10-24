use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Result, anyhow, bail};
use prost::Message;
use rms_content::CompatibleContentView;
use rms_protocol::v1;
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use starlark::environment::{FrozenModule, Globals, GlobalsBuilder, Module};
use starlark::eval::Evaluator;
use starlark::starlark_module;
use starlark::syntax::{AstModule, Dialect};
use starlark::values::dict::DictRef;
use starlark::values::structs::AllocStruct;
use starlark::values::tuple::AllocTuple;
use starlark::values::{Heap, Value};

use crate::measure::{self, CaseMeasure, MeasureInput, QualityContent, Row};
use crate::quality::{
    self, MAX_QUALITY_WORST, QUALITY_CASE_CATALOGUE_VERSION, QUALITY_CASES, QualityBlock,
    QualityCounts, QualityItem, QualityLevel, QualityLibraryIdentity, QualityMetric, QualityResult,
    QualitySkip, QualitySkipReason, QualityWorst,
};
use crate::variants::{self, LobbySettings};
use crate::{HostState, MAX_GENERATED_MAPS, analysis, host, sample, sample_map, unpack_u32};

pub(crate) const QUALITY_LIBRARY_VERSION: &str = "1.0.0";
const QUALITY_LIBRARY_SOURCE: &str = include_str!("quality.star");
pub(crate) const DEFAULT_SCRIPT_SEEDS: u32 = 20;
const LIBRARY_FILE_NAME: &str = "@rmside/quality.star";
const MAX_MEASURE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_THRESHOLD: i64 = 1_000_000;

fn library_text() -> String {
    QUALITY_LIBRARY_SOURCE.replace("\r\n", "\n")
}

pub(crate) fn library_identity() -> QualityLibraryIdentity {
    QualityLibraryIdentity {
        version: QUALITY_LIBRARY_VERSION.to_owned(),
        sha256: hex::encode(Sha256::digest(library_text().as_bytes())),
    }
}

pub(crate) fn compile_library(host: &HostState, globals: &Globals) -> Result<FrozenModule> {
    let ast = AstModule::parse(
        LIBRARY_FILE_NAME,
        library_text(),
        &Dialect {
            enable_load: false,
            ..Dialect::Standard
        },
    )
    .map_err(|error| anyhow!("the quality library does not parse: {error:#}"))?;
    host.quality.loaded.store(true, Ordering::Relaxed);
    Module::with_temp_heap(|module| {
        {
            let mut evaluator = Evaluator::new(&module);
            evaluator.extra = Some(host);
            evaluator
                .eval_module(ast, globals)
                .map_err(|error| anyhow!("the quality library did not load: {error:#}"))?;
        }
        module
            .freeze()
            .map_err(|error| anyhow!("the quality library did not load: {error:?}"))
    })
}

#[derive(Default)]
pub(crate) struct QualityState {
    content: OnceLock<std::result::Result<Arc<QualityContent>, String>>,
    measures: Mutex<BTreeMap<u32, BTreeMap<usize, Arc<CaseMeasure>>>>,
    results: Mutex<Vec<Arc<CaseResult>>>,
    measure_bytes: AtomicU64,
    loaded: AtomicBool,
    plan: Mutex<Option<Arc<Plan>>>,
    finished: Mutex<Option<Finished>>,
}

#[derive(Clone, Debug)]
pub(crate) struct Finished {
    pub block: QualityBlock,
    pub samples: Option<v1::QualitySamples>,
}

impl QualityState {
    pub(crate) fn loaded(&self) -> bool {
        self.loaded.load(Ordering::Relaxed)
    }

    pub(crate) fn take_finished(&self) -> Option<Finished> {
        self.finished
            .lock()
            .expect("map-test quality poisoned")
            .take()
    }

    pub(crate) fn abandon(&self, first: u32) {
        self.measures
            .lock()
            .expect("map-test quality poisoned")
            .retain(|handle, _| *handle < first);
    }

    fn store(&self, handle: u32, measured: Vec<(usize, CaseMeasure)>) -> Result<()> {
        let bytes = measured
            .iter()
            .map(|(_, measure)| measure.heap_bytes())
            .sum::<u64>();
        if self.measure_bytes.fetch_add(bytes, Ordering::Relaxed) + bytes > MAX_MEASURE_BYTES {
            bail!("the quality check's measurements exceed their 256 MiB bound; check fewer seeds");
        }
        let mut measures = self.measures.lock().expect("map-test quality poisoned");
        let entry = measures.entry(handle).or_default();
        for (case, measure) in measured {
            entry.entry(case).or_insert_with(|| Arc::new(measure));
        }
        Ok(())
    }

    fn cached(&self, handle: u32, case: usize) -> Option<Arc<CaseMeasure>> {
        self.measures
            .lock()
            .expect("map-test quality poisoned")
            .get(&handle)
            .and_then(|cases| cases.get(&case))
            .cloned()
    }
}

pub(crate) fn content(host: &HostState) -> Result<Arc<QualityContent>> {
    host.quality
        .content
        .get_or_init(|| {
            let config = &host.context.config;
            CompatibleContentView::new(&config.content, &config.profile.profile_id)
                .map(|content| Arc::new(QualityContent::new(content)))
                .map_err(|error| format!("{error:#}"))
        })
        .clone()
        .map_err(|message| anyhow!(message))
}

#[derive(Clone)]
pub(crate) struct MeasurePlan {
    pub cases: Vec<usize>,
    pub content: Arc<QualityContent>,
}

impl MeasurePlan {
    pub(crate) fn needs_walk(&self) -> bool {
        measure::needs_walk(&self.cases)
    }
}

pub(crate) fn measure_plan(
    host: &HostState,
    ids: Option<Vec<String>>,
) -> Result<Option<MeasurePlan>> {
    let Some(ids) = ids else {
        return Ok(None);
    };
    let cases = quality::select_cases(&ids)?
        .into_iter()
        .map(|case| quality::case_index(case.id).expect("selected cases are known"))
        .collect();
    Ok(Some(MeasurePlan {
        cases,
        content: content(host)?,
    }))
}

pub(crate) fn measure_on_worker(
    host: &HostState,
    plan: &MeasurePlan,
    handle: u32,
    map: &rms_engine::GeneratedMap,
    players: &[crate::records::PlayerRecord],
    walk: Option<(&crate::walk::WalkRules, &crate::walk::WalkGrid)>,
) -> Result<()> {
    let input = MeasureInput {
        map,
        players,
        content: &plan.content,
        walk,
    };
    let measured = measure::measure(&input, &plan.cases, host)?;
    host.quality.store(handle, measured)
}

fn measures_for(host: &HostState, handle: u32, case: usize) -> Result<Option<Arc<CaseMeasure>>> {
    if let Some(found) = host.quality.cached(handle, case) {
        return Ok(Some(found));
    }
    let record = sample(host, handle)?;
    if record.failure.is_some() {
        return Ok(None);
    }
    let content = content(host)?;
    let map = sample_map(host, handle)?;
    let walk = if measure::needs_walk(&[case]) {
        let (_, analysis) = analysis::sample_analysis(host, handle)?;
        Some((analysis::rules(host)?, analysis.grid.clone()))
    } else {
        None
    };
    let input = MeasureInput {
        map: &map,
        players: &record.players,
        content: &content,
        walk: walk
            .as_ref()
            .map(|(rules, grid)| (rules.as_ref(), grid.as_ref())),
    };
    let measured = measure::measure(&input, &[case], host)?;
    host.quality.store(handle, measured)?;
    Ok(host.quality.cached(handle, case))
}

#[derive(Debug)]
pub(crate) struct Plan {
    target: String,
    cases: Vec<usize>,
    seed_start: u32,
    seed_count: u32,
    settings: Vec<(Option<LobbySettings>, Vec<u32>)>,
    sample_rows: bool,
}

fn plan_value<'v>(heap: Heap<'v>, plan: &Plan) -> Value<'v> {
    let settings = plan
        .settings
        .iter()
        .map(|(settings, seeds)| {
            heap.alloc(AllocStruct(vec![
                (
                    "settings",
                    settings.as_ref().map_or_else(Value::new_none, |settings| {
                        variants::alloc_settings(heap, settings)
                    }),
                ),
                ("seeds", heap.alloc(AllocTuple(seeds.clone()))),
            ]))
        })
        .collect::<Vec<_>>();
    heap.alloc(AllocStruct(vec![
        ("target", heap.alloc(plan.target.as_str())),
        (
            "cases",
            heap.alloc(AllocTuple(
                plan.cases
                    .iter()
                    .map(|&case| heap.alloc(QUALITY_CASES[case].id))
                    .collect::<Vec<_>>(),
            )),
        ),
        ("settings", heap.alloc(AllocTuple(settings))),
    ]))
}

fn string_list<'v>(value: Value<'v>, heap: Heap<'v>, what: &str) -> Result<Vec<String>> {
    if let Some(text) = value.unpack_str() {
        return Ok(vec![text.to_owned()]);
    }
    let mut result = Vec::new();
    for item in value
        .iterate(heap)
        .map_err(|_| anyhow!("{what} is a list of case ids"))?
    {
        if result.len() >= rms_protocol::MAX_QUALITY_CASE_IDS {
            bail!(
                "a quality check names 1 to {} cases",
                rms_protocol::MAX_QUALITY_CASE_IDS
            );
        }
        result.push(
            item.unpack_str()
                .ok_or_else(|| anyhow!("{what} is a list of case ids"))?
                .to_owned(),
        );
    }
    Ok(result)
}

fn new_plan<'v>(
    host: &HostState,
    target: Value<'v>,
    seeds: Value<'v>,
    settings: Value<'v>,
    cases: Value<'v>,
    heap: Heap<'v>,
) -> Result<Plan> {
    let config = &host.context.config;
    let builtin = config.quality.as_ref();
    let target = if target.is_none() {
        config.default_source_path.clone().ok_or_else(|| {
            anyhow!("quality_check needs a map: pass target, or run it on an open map")
        })?
    } else {
        target
            .unpack_str()
            .ok_or_else(|| anyhow!("quality_check target is a map path"))?
            .to_owned()
    };
    let cases = if cases.is_none() {
        match builtin {
            Some(plan) => plan.cases.clone(),
            None => QUALITY_CASES.iter().collect(),
        }
    } else {
        quality::select_cases(&string_list(cases, heap, "quality_check cases")?)?
    };
    let cases = cases
        .into_iter()
        .map(|case| quality::case_index(case.id).expect("selected cases are known"))
        .collect::<Vec<_>>();
    let seeds = if seeds.is_none() {
        None
    } else {
        let seeds = crate::value_u32_list(seeds, heap)?;
        if seeds.is_empty() {
            bail!("quality_check seeds lists 1 to 4,096 seeds");
        }
        Some(seeds)
    };
    let (seed_start, seed_count, default_seeds) = match (&seeds, builtin) {
        (Some(seeds), _) => (seeds[0], seeds.len() as u32, seeds.clone()),
        (None, Some(plan)) => (
            plan.seed_start,
            plan.seed_count,
            plan.seeds(plan.seed_count).collect(),
        ),
        (None, None) => (
            1,
            DEFAULT_SCRIPT_SEEDS,
            (1..=DEFAULT_SCRIPT_SEEDS).collect(),
        ),
    };
    let settings = if settings.is_none() {
        match builtin.filter(|plan| !plan.settings.is_empty()) {
            Some(plan) => plan
                .settings
                .iter()
                .map(|setting| {
                    let seeds = match &seeds {
                        Some(seeds) => seeds.clone(),
                        None => plan.seeds(setting.seed_count).collect(),
                    };
                    (
                        Some(LobbySettings {
                            map_size: setting.map_size.clone(),
                            dimensions: setting.dimensions,
                            players: setting.players.clone(),
                        }),
                        seeds,
                    )
                })
                .collect(),
            None => vec![(None, default_seeds)],
        }
    } else {
        variants::settings_argument(settings, heap)?
            .unwrap_or_default()
            .into_iter()
            .map(|setting| (Some(setting), default_seeds.clone()))
            .collect()
    };
    let total = settings.iter().map(|(_, seeds)| seeds.len()).sum::<usize>();
    if total == 0 || total > MAX_GENERATED_MAPS {
        bail!("a quality check generates 1 to {MAX_GENERATED_MAPS} maps");
    }
    Ok(Plan {
        target,
        cases,
        seed_start,
        seed_count,
        settings,
        sample_rows: builtin.is_some_and(|plan| plan.sample_rows),
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Rule {
    Above,
    AtLeast,
    AtMost,
    Below,
    ScaledAbove,
    AboveOrNear,
    Narrow,
    SameForests,
    SameStarts,
    Favoured,
}

impl Rule {
    fn reached(self, row: &Row, limit: i64, limits: &BTreeMap<String, i64>) -> bool {
        match self {
            Self::Above | Self::SameForests | Self::Favoured => row.value > limit,
            Self::AtLeast | Self::SameStarts => row.value >= limit,
            Self::AtMost => row.value <= limit,
            Self::Below => row.value < limit,
            Self::ScaledAbove => {
                let percent = limits.get("percent").copied().unwrap_or(0);
                row.value > limit.max(row.aux * percent / 100)
            }
            Self::AboveOrNear => {
                row.value > limit
                    || limits
                        .get("near-start")
                        .is_some_and(|near| row.aux <= *near)
            }
            Self::Narrow => {
                let single = limits.get("single-route").copied().unwrap_or(limit);
                row.value <= limit || (row.aux == 1 && row.value <= single)
            }
        }
    }

    fn lower_is_worse(self) -> bool {
        matches!(self, Self::AtMost | Self::Below | Self::Narrow)
    }

    fn extras(self, code: &str) -> &'static [&'static str] {
        match (self, code) {
            (Self::ScaledAbove, _) => &["percent"],
            (Self::AboveOrNear, _) => &["near-start"],
            (Self::Narrow, _) => &["single-route"],
            (Self::Favoured, _) => &["minimum-seeds"],
            (_, "players-cut-off") => &["water-map"],
            _ => &[],
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct CodeSpec {
    pub case: &'static str,
    pub code: &'static str,
    pub message: &'static str,
    pub metric: Option<(&'static str, &'static str)>,
    rule: Rule,
}

const fn spec(
    case: &'static str,
    code: &'static str,
    message: &'static str,
    metric: Option<(&'static str, &'static str)>,
    rule: Rule,
) -> CodeSpec {
    CodeSpec {
        case,
        code,
        message,
        metric,
        rule,
    }
}

use Rule::{
    Above, AboveOrNear, AtLeast, AtMost, Below, Favoured, Narrow, SameForests, SameStarts,
    ScaledAbove,
};

pub(crate) const CODES: &[CodeSpec] = &[
    spec(
        "generation",
        "failed-generation",
        "The map did not generate on some seeds",
        None,
        Above,
    ),
    spec(
        "generation",
        "game-crash",
        "The game would crash on some seeds",
        None,
        Above,
    ),
    spec(
        "generation",
        "player-without-start",
        "Some players get no start (no land and no Town Center)",
        Some(("players without a start", "players")),
        Above,
    ),
    spec(
        "generation",
        "uneven-placement",
        "A create_object command placed different numbers of groups for different players",
        Some(("create_object commands with uneven groups", "commands")),
        Above,
    ),
    spec(
        "generation",
        "objects-not-placed",
        "Some create_object commands placed fewer groups than they asked for",
        Some(("create_object commands short of groups", "commands")),
        Above,
    ),
    spec(
        "generation",
        "generation-warnings",
        "Generation reported warnings",
        Some(("generation warnings", "warnings")),
        Above,
    ),
    spec(
        "generation",
        "gaia-buildings",
        "The map has Gaia buildings, walls, or towers; check that they are meant to be there",
        Some(("Gaia buildings, walls, gates, and towers", "objects")),
        Above,
    ),
    spec(
        "generation",
        "placement-records-omitted",
        "Only the first 4,096 create_object results were checked for missing objects",
        Some(("create_object results not checked", "results")),
        Above,
    ),
    spec(
        "start-resources",
        "start-gold",
        "Players get different amounts of their own gold",
        Some(("own gold objects, max - min", "objects")),
        Above,
    ),
    spec(
        "start-resources",
        "start-stone",
        "Players get different amounts of their own stone",
        Some(("own stone objects, max - min", "objects")),
        Above,
    ),
    spec(
        "start-resources",
        "start-berries",
        "Players get different numbers of their own berry bushes",
        Some(("own berry bushes, max - min", "bushes")),
        Above,
    ),
    spec(
        "start-resources",
        "start-hunt",
        "Players get different amounts of their own hunt",
        Some(("own hunt animals, max - min", "animals")),
        Above,
    ),
    spec(
        "start-resources",
        "start-herdables",
        "Players get different numbers of their own herdable animals",
        Some(("own herdable animals, max - min", "animals")),
        Above,
    ),
    spec(
        "start-resources",
        "start-predators",
        "Wolves or other predators are near some starts more than others, or very close to a start",
        Some(("predators near the start, max - min", "animals")),
        AboveOrNear,
    ),
    spec(
        "start-resources",
        "owned-objects",
        "Players start with different numbers of their own objects",
        Some(("own objects, max - min", "objects")),
        Above,
    ),
    spec(
        "start-resources",
        "missing-start-objects",
        "Some players start without a Town Center, villagers, or a scout that others have",
        Some((
            "of Town Center, villagers, and scout: kinds some players lack",
            "kinds",
        )),
        Above,
    ),
    spec(
        "start-resources",
        "resource-totals",
        "Players get different amounts of their own food, gold, and stone",
        Some(("own food, gold, and stone, (max - min) / max", "%")),
        Above,
    ),
    spec(
        "resource-distances",
        "nearest-gold",
        "The nearest gold is much farther for some players",
        Some((
            "walking distance to own 1st or 2nd gold, up to 30 tiles, max - min",
            "tiles",
        )),
        Above,
    ),
    spec(
        "resource-distances",
        "nearest-stone",
        "The nearest stone is much farther for some players",
        Some((
            "walking distance to own 1st or 2nd stone, up to 30 tiles, max - min",
            "tiles",
        )),
        Above,
    ),
    spec(
        "resource-distances",
        "nearest-berries",
        "The nearest berries are much farther for some players",
        Some((
            "walking distance to own 1st or 2nd berries, up to 30 tiles, max - min",
            "tiles",
        )),
        Above,
    ),
    spec(
        "resource-distances",
        "nearest-hunt",
        "The nearest hunt is much farther for some players",
        Some((
            "walking distance to own 1st or 2nd hunt, up to 30 tiles, max - min",
            "tiles",
        )),
        Above,
    ),
    spec(
        "resource-distances",
        "front-back",
        "Some resources are in front of one player and behind another",
        Some((
            "resource kinds in front of one player and behind another",
            "kinds",
        )),
        Above,
    ),
    spec(
        "shared-resources",
        "neutral-gold",
        "Neutral gold is split unevenly between players",
        Some((
            "neutral gold nearer one side, gap per player in an even share",
            "%",
        )),
        Above,
    ),
    spec(
        "shared-resources",
        "neutral-stone",
        "Neutral stone is split unevenly between players",
        Some((
            "neutral stone nearer one side, gap per player in an even share",
            "%",
        )),
        Above,
    ),
    spec(
        "shared-resources",
        "neutral-relics",
        "Relics are split unevenly between players",
        Some((
            "relics nearer one side, gap per player in an even share",
            "%",
        )),
        Above,
    ),
    spec(
        "shared-resources",
        "neutral-hunt",
        "Neutral hunt is split unevenly between players",
        Some((
            "neutral hunt nearer one side, gap per player in an even share",
            "%",
        )),
        Above,
    ),
    spec(
        "shared-resources",
        "favoured-player",
        "The same player gets the most neutral resources on most seeds",
        None,
        Favoured,
    ),
    spec(
        "shared-resources",
        "contested-distance",
        "Relics or the map centre are much nearer to some players",
        Some((
            "walking distance to the nearest relic or the centre, max - min",
            "tiles",
        )),
        ScaledAbove,
    ),
    spec(
        "wood",
        "wood-near-start",
        "Players have different amounts of wood near their start",
        Some(("tree tiles within 20 tiles, (max - min) / max", "%")),
        Above,
    ),
    spec(
        "wood",
        "missing-woodline",
        "Some players have no large woodline and little wood near their start while others do",
        None,
        Above,
    ),
    spec(
        "trapped",
        "own-object-trapped",
        "A player's own resources or buildings that train units cannot be reached by that player's villagers",
        Some((
            "own resources and training buildings out of reach",
            "objects",
        )),
        Above,
    ),
    spec(
        "trapped",
        "uneven-trapped",
        "Resources near some starts are closed in by trees, but not near others",
        Some((
            "resources closed in by trees near the start, max - min",
            "objects",
        )),
        Above,
    ),
    spec(
        "trapped",
        "trapped-resources",
        "Resources near every start are closed in by trees",
        Some((
            "resources closed in by trees near each start, fewest",
            "objects",
        )),
        Above,
    ),
    spec(
        "trapped",
        "uneven-enclosed",
        "Some players have own objects closed in that others do not",
        Some(("own objects out of reach, max - min", "objects")),
        Above,
    ),
    spec(
        "trapped",
        "enclosed-own-objects",
        "Every player has own objects out of reach; check that this is meant",
        Some((
            "own objects out of reach for each player, fewest",
            "objects",
        )),
        Above,
    ),
    spec(
        "trapped",
        "fenced-animals",
        "A player's own starting buildings close in sheep or hunt near their start",
        Some((
            "herdables and hunt closed in by own buildings, most",
            "animals",
        )),
        Above,
    ),
    spec(
        "paths",
        "players-cut-off",
        "Some players cannot walk to each other",
        Some(("player pairs without a walking route", "pairs")),
        Above,
    ),
    spec(
        "paths",
        "rush-distance",
        "Walking distances to the nearest opponent differ between players",
        Some((
            "walking distance to the nearest opponent, (max - min) / max",
            "%",
        )),
        Above,
    ),
    spec(
        "paths",
        "ally-distance",
        "Walking distances to the nearest teammate differ between players",
        Some((
            "walking distance to the nearest teammate, (max - min) / max",
            "%",
        )),
        Above,
    ),
    spec(
        "building-space",
        "building-space",
        "Players have different amounts of building space near their start",
        Some(("buildable tiles within 16 tiles, (max - min) / max", "%")),
        Above,
    ),
    spec(
        "building-space",
        "wall-length",
        "Walling a base takes different numbers of tiles for different players",
        Some(("tiles to wall off at 20 tiles, (max - min) / max", "%")),
        Above,
    ),
    spec(
        "hills",
        "front-hills",
        "Some players have much more high ground towards their enemy",
        Some((
            "higher tiles towards the nearest opponent, max - min",
            "points",
        )),
        Above,
    ),
    spec(
        "water",
        "no-shore",
        "Some players have no shore near their start while others do",
        None,
        Above,
    ),
    spec(
        "water",
        "shore-fish",
        "Players have different numbers of shore fish near their start",
        Some(("shore fish groups within 20 tiles, max - min", "groups")),
        Above,
    ),
    spec(
        "water",
        "island-size",
        "Player islands differ in size",
        Some(("land a player can walk to, (max - min) / max", "%")),
        Above,
    ),
    spec(
        "water",
        "island-resources",
        "Some player islands lack food, wood, or gold that others have",
        Some(("resource kinds missing on some islands", "kinds")),
        Above,
    ),
    spec(
        "water",
        "exposed-resources",
        "Most resources are close to water and open to attack from ships",
        Some(("gold, stone, and berries within 8 tiles of water", "%")),
        Above,
    ),
    spec(
        "spacing",
        "resource-clash",
        "Different resources are placed right next to each other",
        Some(("pairs of different resources side by side", "pairs")),
        Above,
    ),
    spec(
        "spacing",
        "resource-at-start",
        "Resources are placed right next to a Town Center",
        Some(("resources within 2 tiles of a start", "objects")),
        Above,
    ),
    spec(
        "chokepoints",
        "narrow-route",
        "Opponents are joined only through a narrow passage; the mark shows the narrow point",
        Some((
            "tiles that close the route to the nearest opponent",
            "tiles",
        )),
        Narrow,
    ),
    spec(
        "chokepoints",
        "minerals-cut-off",
        "One building could cut a player off their gold or stone; the mark shows the narrow point",
        Some((
            "tiles that close the way to the nearest gold or stone",
            "tiles",
        )),
        AtMost,
    ),
    spec(
        "variation",
        "same-forests",
        "Forests look almost the same on every seed",
        Some(("forest tiles shared with the next seed", "%")),
        SameForests,
    ),
    spec(
        "variation",
        "same-starts",
        "Players start in the same places on every seed",
        None,
        SameStarts,
    ),
    spec(
        "variation",
        "object-count-outliers",
        "Some seeds have far more or fewer objects than the others",
        Some(("object count off the median", "%")),
        Above,
    ),
    spec(
        "looks",
        "no-beaches",
        "Most shores have no beach",
        Some(("shore without beach", "%")),
        Above,
    ),
    spec(
        "looks",
        "bare-area",
        "A large area has one terrain and no objects",
        Some(("side of the largest empty square of one terrain", "tiles")),
        AtLeast,
    ),
    spec(
        "looks",
        "one-terrain",
        "One terrain covers almost all of the land",
        Some(("land of the most common terrain", "%")),
        Above,
    ),
    spec(
        "looks",
        "round-shapes",
        "Forests or lakes look like perfect circles",
        Some(("round forests and lakes", "clusters")),
        AtLeast,
    ),
    spec(
        "looks",
        "uniform-clusters",
        "Forest clusters all have nearly the same size",
        Some(("forest size spread, (max - min) / max", "%")),
        Below,
    ),
    spec(
        "looks",
        "edge-differs",
        "The map edge near some players has much more forest than near others",
        Some((
            "forest along the map edge near the start, max - min",
            "points",
        )),
        Above,
    ),
];

fn codes_of(case: &str) -> impl Iterator<Item = &'static CodeSpec> + '_ {
    CODES.iter().filter(move |spec| spec.case == case)
}

type Limits = BTreeMap<String, BTreeMap<String, i64>>;

fn read_limits<'v>(value: Value<'v>, case: usize) -> Result<Limits> {
    let case_id = QUALITY_CASES[case].id;
    let dictionary = DictRef::from_value(value)
        .ok_or_else(|| anyhow!("quality thresholds are a dictionary by \"case/code\""))?;
    let mut limits = Limits::new();
    for (key, entry) in dictionary.iter() {
        let key = key
            .unpack_str()
            .ok_or_else(|| anyhow!("quality thresholds are named \"case/code\""))?;
        let Some((case_part, code)) = key.split_once('/') else {
            bail!(
                "quality threshold \"{}\" is not named \"case/code\"",
                key.escape_debug()
            );
        };
        if case_part != case_id {
            continue;
        }
        let Some(spec) = codes_of(case_id).find(|spec| spec.code == code) else {
            bail!("unknown quality threshold \"{}\"", key.escape_debug());
        };
        let values = DictRef::from_value(entry)
            .ok_or_else(|| anyhow!("quality threshold \"{key}\" is a dictionary of numbers"))?;
        let highest = QUALITY_CASES[case].highest_level.rank();
        let mut numbers = BTreeMap::new();
        for (name, number) in values.iter() {
            let name = name
                .unpack_str()
                .ok_or_else(|| anyhow!("quality threshold \"{key}\" names its numbers"))?;
            let allowed = match name {
                "failure" => highest <= QualityLevel::Failure.rank(),
                "warning" => highest <= QualityLevel::Warning.rank(),
                "advice" => true,
                other => spec.rule.extras(spec.code).contains(&other),
            };
            if !allowed {
                bail!(
                    "quality threshold \"{key}\" has no \"{}\"",
                    name.escape_debug()
                );
            }
            let number = number
                .unpack_i32()
                .map(i64::from)
                .filter(|number| (-MAX_THRESHOLD..=MAX_THRESHOLD).contains(number))
                .ok_or_else(|| anyhow!("quality threshold \"{key}\" {name} is a whole number"))?;
            numbers.insert(name.to_owned(), number);
        }
        limits.insert(code.to_owned(), numbers);
    }
    Ok(limits)
}

fn level_of(
    spec: &CodeSpec,
    limits: Option<&BTreeMap<String, i64>>,
    row: &Row,
) -> Option<QualityLevel> {
    let limits = limits?;
    [
        ("failure", QualityLevel::Failure),
        ("warning", QualityLevel::Warning),
        ("advice", QualityLevel::Advice),
    ]
    .into_iter()
    .find(|(name, _)| {
        limits
            .get(*name)
            .is_some_and(|&limit| spec.rule.reached(row, limit, limits))
    })
    .map(|(_, level)| level)
}

#[derive(Clone, Debug)]
struct SampleRow {
    handle: u32,
    seed: u32,
    code: &'static str,
    level: Option<QualityLevel>,
    value: Option<i64>,
    players: Vec<i64>,
    tiles: Vec<(u16, u16, u8)>,
}

#[derive(Clone, Debug)]
struct Summarised {
    item: QualityItem,
    handles: Vec<Option<u32>>,
}

#[derive(Debug)]
pub(crate) struct CaseResult {
    case: usize,
    skip: Option<QualitySkipReason>,
    items: Vec<Summarised>,
    rows: Vec<SampleRow>,
}

struct Measured {
    handle: u32,
    seed: u32,
    settings_index: Option<u8>,
    generated: bool,
    measure: Option<Arc<CaseMeasure>>,
    failed_rows: Vec<Row>,
}

fn percentile(sorted: &[i64], percent: usize) -> i64 {
    let rank = (percent * sorted.len()).div_ceil(100).max(1);
    sorted[rank - 1]
}

fn metric_of(spec: &CodeSpec, values: &[i64]) -> Option<QualityMetric> {
    let (label, unit) = spec.metric?;
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    Some(QualityMetric {
        label: label.to_owned(),
        unit: unit.to_owned(),
        p5: percentile(&sorted, 5),
        p50: percentile(&sorted, 50),
        p95: percentile(&sorted, 95),
        max: *sorted.last().expect("a metric has values"),
    })
}

fn level_value(level: Option<QualityLevel>) -> i32 {
    match level {
        None => v1::QualityLevel::Passed as i32,
        Some(QualityLevel::Advice) => v1::QualityLevel::Advice as i32,
        Some(QualityLevel::Warning) => v1::QualityLevel::Warning as i32,
        Some(QualityLevel::Failure) => v1::QualityLevel::Failure as i32,
    }
}

fn most_serious(levels: impl Iterator<Item = Option<QualityLevel>>) -> Option<QualityLevel> {
    levels.flatten().min_by_key(|level| level.rank())
}

fn item_of(
    spec: &CodeSpec,
    rows: &[(usize, &Measured, &Row, Option<QualityLevel>)],
    level: Option<QualityLevel>,
) -> Option<Summarised> {
    let level = level?;
    let values = rows
        .iter()
        .map(|(_, _, row, _)| row.value)
        .collect::<Vec<_>>();
    let mut worst = rows
        .iter()
        .filter(|(_, _, _, row_level)| *row_level == Some(level))
        .collect::<Vec<_>>();
    let bad = worst.len() as u32;
    worst.sort_by_key(|(position, _, row, _)| {
        (
            if spec.rule.lower_is_worse() {
                row.value
            } else {
                -row.value
            },
            *position,
        )
    });
    worst.truncate(MAX_QUALITY_WORST);
    let metric = metric_of(spec, &values);
    Some(Summarised {
        item: QualityItem {
            case: spec.case.to_owned(),
            code: spec.code.to_owned(),
            level,
            message: spec.message.to_owned(),
            bad,
            of: rows.len() as u32,
            worst: worst
                .iter()
                .map(|(_, measured, row, _)| QualityWorst {
                    seed: measured.seed,
                    settings_index: measured.settings_index.map(u32::from),
                    value: metric.as_ref().map(|_| row.value),
                    players: (!row.players.is_empty()).then(|| row.players.clone()),
                    tile: row.mark.map(|(x, y)| [x, y]),
                })
                .collect(),
            metric,
        },
        handles: worst
            .iter()
            .map(|(_, measured, _, _)| measured.generated.then_some(measured.handle))
            .collect(),
    })
}

fn variation_rows(samples: &[Measured]) -> Vec<(usize, Row)> {
    let mut groups = BTreeMap::<Option<u8>, Vec<(usize, &measure::Signature)>>::new();
    for (position, sample) in samples.iter().enumerate() {
        if let Some(signature) = sample
            .measure
            .as_ref()
            .and_then(|measure| measure.signature.as_deref())
        {
            groups
                .entry(sample.settings_index)
                .or_default()
                .push((position, signature));
        }
    }
    let mut rows = Vec::new();
    for members in groups.values().filter(|members| members.len() >= 2) {
        let mut counts = members
            .iter()
            .map(|(_, signature)| signature.objects)
            .collect::<Vec<_>>();
        counts.sort_unstable();
        let median = counts[(counts.len() - 1) / 2];
        for (index, (position, signature)) in members.iter().enumerate() {
            let other = if index + 1 < members.len() {
                members[index + 1].1
            } else {
                members[index - 1].1
            };
            let (mut shared, mut either) = (0_u64, 0_u64);
            for (left, right) in signature.forest.iter().zip(&other.forest) {
                shared += u64::from((left & right).count_ones());
                either += u64::from((left | right).count_ones());
            }
            if either > 0 && signature.forest.len() == other.forest.len() {
                rows.push((
                    *position,
                    Row {
                        code: "same-forests",
                        value: (shared * 100 / either) as i64,
                        aux: 0,
                        players: Vec::new(),
                        tiles: Vec::new(),
                        mark: None,
                    },
                ));
            }
            rows.push((
                *position,
                Row {
                    code: "same-starts",
                    value: if signature.starts == other.starts {
                        100
                    } else {
                        0
                    },
                    aux: 0,
                    players: Vec::new(),
                    tiles: Vec::new(),
                    mark: None,
                },
            ));
            if let Some(off) = (signature.objects.abs_diff(median) * 100).checked_div(median) {
                rows.push((
                    *position,
                    Row {
                        code: "object-count-outliers",
                        value: off as i64,
                        aux: 0,
                        players: Vec::new(),
                        tiles: Vec::new(),
                        mark: None,
                    },
                ));
            }
        }
    }
    rows
}

fn summarise(
    host: &HostState,
    case: usize,
    handles: &[u32],
    limits: &Limits,
) -> Result<CaseResult> {
    let case_id = QUALITY_CASES[case].id;
    let mut samples = Vec::with_capacity(handles.len());
    for (position, &handle) in handles.iter().enumerate() {
        if position.is_multiple_of(64) {
            host.check_running()?;
        }
        let record = sample(host, handle)?;
        let generated = record.failure.is_none();
        let failed_rows = match (&record.failure, case_id) {
            (Some(failure), "generation") => {
                let crashed = i64::from(failure.crash_id.is_some());
                vec![
                    Row {
                        code: "failed-generation",
                        value: 1 - crashed,
                        aux: 0,
                        players: Vec::new(),
                        tiles: Vec::new(),
                        mark: None,
                    },
                    Row {
                        code: "game-crash",
                        value: crashed,
                        aux: 0,
                        players: Vec::new(),
                        tiles: Vec::new(),
                        mark: None,
                    },
                ]
            }
            _ => Vec::new(),
        };
        samples.push(Measured {
            handle,
            seed: record.seed,
            settings_index: record.settings_index,
            generated,
            measure: if generated {
                measures_for(host, handle, case)?
            } else {
                None
            },
            failed_rows,
        });
    }
    let variation = if case_id == "variation" {
        variation_rows(&samples)
    } else {
        Vec::new()
    };
    let mut items = Vec::new();
    let mut kept_rows = Vec::new();
    for spec in codes_of(case_id) {
        let code_limits = limits.get(spec.code);
        if spec.rule == Favoured {
            items.extend(favoured_item(spec, code_limits, &samples));
            continue;
        }
        let mut rows = Vec::new();
        for (position, sample) in samples.iter().enumerate() {
            let measured = sample
                .measure
                .as_ref()
                .map_or(&[][..], |measure| measure.rows.as_slice());
            for row in measured.iter().chain(&sample.failed_rows) {
                if row.code == spec.code {
                    rows.push((position, sample, row, level_of(spec, code_limits, row)));
                }
            }
        }
        for (position, row) in &variation {
            if row.code == spec.code {
                let sample = &samples[*position];
                rows.push((*position, sample, row, level_of(spec, code_limits, row)));
            }
        }
        if rows.is_empty() {
            continue;
        }
        rows.sort_by_key(|(position, _, _, _)| *position);
        let mut level = most_serious(rows.iter().map(|(_, _, _, level)| *level));
        let advice = code_limits.and_then(|limits| limits.get("advice")).copied();
        let suppressed = match spec.rule {
            SameForests => {
                let mut values = rows
                    .iter()
                    .map(|(_, _, row, _)| row.value)
                    .collect::<Vec<_>>();
                values.sort_unstable();
                !advice.is_some_and(|limit| percentile(&values, 50) > limit)
            }
            SameStarts => rows.iter().any(|(_, _, _, level)| level.is_none()),
            _ if spec.code == "players-cut-off" => {
                let water_map = code_limits
                    .and_then(|limits| limits.get("water-map"))
                    .copied()
                    .unwrap_or(i64::MAX);
                let cut = rows.iter().filter(|(_, _, row, _)| row.value > 0).count() as i64;
                cut * 100 >= water_map * rows.len() as i64
            }
            _ => false,
        };
        if suppressed {
            level = None;
            for row in &mut rows {
                row.3 = None;
            }
        }
        items.extend(item_of(spec, &rows, level));
        for (_, sample, row, row_level) in &rows {
            kept_rows.push(SampleRow {
                handle: sample.handle,
                seed: sample.seed,
                code: spec.code,
                level: *row_level,
                value: spec.metric.map(|_| row.value),
                players: row.players.clone(),
                tiles: row.tiles.clone(),
            });
        }
    }
    let generated = samples.iter().filter(|sample| sample.generated).count();
    let measured_any = samples.iter().any(|sample| {
        !sample.failed_rows.is_empty()
            || sample
                .measure
                .as_ref()
                .is_some_and(|measure| !measure.rows.is_empty())
    }) || !variation.is_empty();
    let skip = if case_id != "generation" && generated == 0 {
        Some(QualitySkipReason::NoSamples)
    } else if !measured_any {
        Some(QualitySkipReason::NotApplicable)
    } else {
        None
    };
    if skip.is_some() {
        items.clear();
        kept_rows.clear();
    }
    Ok(CaseResult {
        case,
        skip,
        items,
        rows: kept_rows,
    })
}

fn favoured_item(
    spec: &CodeSpec,
    limits: Option<&BTreeMap<String, i64>>,
    samples: &[Measured],
) -> Option<Summarised> {
    let limits = limits?;
    let limit = limits.get("warning").copied()?;
    let minimum = limits.get("minimum-seeds").copied().unwrap_or(0);
    let measured = samples
        .iter()
        .enumerate()
        .filter(|(_, sample)| {
            sample
                .measure
                .as_ref()
                .is_some_and(|measure| !measure.rows.is_empty())
        })
        .collect::<Vec<_>>();
    let of = measured.len() as i64;
    if of == 0 || of < minimum {
        return None;
    }
    let mut counts = BTreeMap::<u8, i64>::new();
    for (_, sample) in &measured {
        if let Some(slot) = sample.measure.as_ref().and_then(|measure| measure.favoured) {
            *counts.entry(slot).or_default() += 1;
        }
    }
    let (&slot, &count) = counts
        .iter()
        .max_by_key(|(slot, count)| (**count, std::cmp::Reverse(**slot)))?;
    const WHOLE: i64 = 1_000_000;
    let chance = measured
        .iter()
        .map(|(_, sample)| {
            let contenders = sample
                .measure
                .as_ref()
                .map_or(0, |measure| i64::from(measure.contenders));
            WHOLE / contenders.max(1)
        })
        .sum::<i64>()
        / of;
    let required = chance + (WHOLE - chance) * limit.clamp(0, 100) / 100;
    if count * WHOLE < required * of {
        return None;
    }
    let favoured = measured
        .iter()
        .filter(|(_, sample)| {
            sample.measure.as_ref().and_then(|measure| measure.favoured) == Some(slot)
        })
        .take(MAX_QUALITY_WORST)
        .collect::<Vec<_>>();
    Some(Summarised {
        item: QualityItem {
            case: spec.case.to_owned(),
            code: spec.code.to_owned(),
            level: QualityLevel::Warning,
            message: spec.message.to_owned(),
            metric: None,
            bad: count as u32,
            of: of as u32,
            worst: favoured
                .iter()
                .map(|(_, sample)| QualityWorst {
                    seed: sample.seed,
                    settings_index: sample.settings_index.map(u32::from),
                    value: None,
                    players: None,
                    tile: None,
                })
                .collect(),
        },
        handles: favoured
            .iter()
            .map(|(_, sample)| Some(sample.handle))
            .collect(),
    })
}

fn alloc_optional<'v>(heap: Heap<'v>, value: Option<i64>) -> Value<'v> {
    value.map_or_else(Value::new_none, |value| heap.alloc(value))
}

fn level_name(level: QualityLevel) -> &'static str {
    match level {
        QualityLevel::Failure => "failure",
        QualityLevel::Warning => "warning",
        QualityLevel::Advice => "advice",
    }
}

fn skip_name(reason: QualitySkipReason) -> &'static str {
    match reason {
        QualitySkipReason::NotSelected => "not-selected",
        QualitySkipReason::NotApplicable => "not-applicable",
        QualitySkipReason::NoSamples => "no-samples",
    }
}

fn alloc_item<'v>(heap: Heap<'v>, item: &QualityItem) -> Value<'v> {
    let metric = item.metric.as_ref().map_or_else(Value::new_none, |metric| {
        heap.alloc(AllocStruct(vec![
            ("label", heap.alloc(metric.label.as_str())),
            ("unit", heap.alloc(metric.unit.as_str())),
            ("p5", heap.alloc(metric.p5)),
            ("p50", heap.alloc(metric.p50)),
            ("p95", heap.alloc(metric.p95)),
            ("max", heap.alloc(metric.max)),
        ]))
    });
    let worst = item
        .worst
        .iter()
        .map(|worst| {
            heap.alloc(AllocStruct(vec![
                ("seed", heap.alloc(worst.seed)),
                (
                    "settings_index",
                    alloc_optional(heap, worst.settings_index.map(i64::from)),
                ),
                ("value", alloc_optional(heap, worst.value)),
                (
                    "players",
                    worst
                        .players
                        .as_ref()
                        .map_or_else(Value::new_none, |players| {
                            heap.alloc(AllocTuple(players.clone()))
                        }),
                ),
                (
                    "tile",
                    worst.tile.map_or_else(Value::new_none, |[x, y]| {
                        heap.alloc(AllocTuple([u32::from(x), u32::from(y)]))
                    }),
                ),
            ]))
        })
        .collect::<Vec<_>>();
    heap.alloc(AllocStruct(vec![
        ("case", heap.alloc(item.case.as_str())),
        ("code", heap.alloc(item.code.as_str())),
        ("level", heap.alloc(level_name(item.level))),
        ("message", heap.alloc(item.message.as_str())),
        ("bad", heap.alloc(item.bad)),
        ("of", heap.alloc(item.of)),
        ("metric", metric),
        ("worst", heap.alloc(AllocTuple(worst))),
    ]))
}

fn case_value<'v>(heap: Heap<'v>, result: &CaseResult, id: u32) -> Value<'v> {
    heap.alloc(AllocStruct(vec![
        ("case", heap.alloc(QUALITY_CASES[result.case].id)),
        (
            "skipped",
            result
                .skip
                .map_or_else(Value::new_none, |reason| heap.alloc(skip_name(reason))),
        ),
        (
            "items",
            heap.alloc(AllocTuple(
                result
                    .items
                    .iter()
                    .map(|summarised| alloc_item(heap, &summarised.item))
                    .collect::<Vec<_>>(),
            )),
        ),
        ("_id", heap.alloc(id)),
    ]))
}

type WorstHandles = BTreeMap<(String, String), Vec<Option<u32>>>;

fn block_of(
    plan: &Plan,
    samples: u32,
    failed_samples: u32,
    results: &[Arc<CaseResult>],
) -> (QualityBlock, WorstHandles) {
    let ran = results
        .iter()
        .map(|result| (result.case, result))
        .collect::<BTreeMap<_, _>>();
    let mut cases = Vec::new();
    let mut skipped = Vec::new();
    let mut items = Vec::new();
    let mut handles = BTreeMap::new();
    for (index, case) in QUALITY_CASES.iter().enumerate() {
        match ran.get(&index) {
            Some(result) => match result.skip {
                Some(reason) => skipped.push(QualitySkip {
                    case: case.id.to_owned(),
                    reason,
                }),
                None => {
                    cases.push(case.id.to_owned());
                    for summarised in &result.items {
                        handles.insert(
                            (summarised.item.case.clone(), summarised.item.code.clone()),
                            summarised.handles.clone(),
                        );
                        items.push(summarised.item.clone());
                    }
                }
            },
            None => skipped.push(QualitySkip {
                case: case.id.to_owned(),
                reason: QualitySkipReason::NotSelected,
            }),
        }
    }
    let mut counts = QualityCounts::default();
    for item in &items {
        match item.level {
            QualityLevel::Failure => counts.failures += 1,
            QualityLevel::Warning => counts.warnings += 1,
            QualityLevel::Advice => counts.advice += 1,
        }
    }
    let passed = cases
        .iter()
        .filter(|case| {
            !items
                .iter()
                .any(|item| &item.case == *case && item.level != QualityLevel::Advice)
        })
        .cloned()
        .collect();
    let result = if counts.failures > 0 {
        QualityResult::Failed
    } else if counts.warnings > 0 {
        QualityResult::Warnings
    } else {
        QualityResult::Passed
    };
    let mut block = QualityBlock {
        catalog: QUALITY_CASE_CATALOGUE_VERSION.to_owned(),
        seed_start: plan.seed_start,
        seed_count: plan.seed_count,
        samples,
        failed_samples,
        cases,
        skipped,
        result,
        counts,
        items,
        passed,
        omitted_items: 0,
    };
    block.fit_budget();
    (block, handles)
}

fn sample_rows(
    positions: &BTreeMap<u32, (u32, usize)>,
    results: &[Arc<CaseResult>],
) -> Result<v1::QualitySamples> {
    let mut rows = Vec::new();
    for result in results {
        for row in &result.rows {
            let Some(&(setting, position)) = positions.get(&row.handle) else {
                continue;
            };
            rows.push((
                (setting, position, result.case, row.code),
                v1::QualitySampleRow {
                    settings_index: setting,
                    seed: row.seed,
                    case_id: QUALITY_CASES[result.case].id.to_owned(),
                    code: row.code.to_owned(),
                    level: level_value(row.level),
                    value: row.value,
                    player_values: row.players.clone(),
                    tiles: row
                        .tiles
                        .iter()
                        .map(|&(x, y, player)| v1::QualityTile {
                            x: u32::from(x),
                            y: u32::from(y),
                            player: u32::from(player),
                        })
                        .collect(),
                },
            ));
        }
    }
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    let mut samples = v1::QualitySamples {
        rows: Vec::with_capacity(rows.len()),
        omitted_rows: 0,
    };
    let mut bytes = 0_usize;
    let budget = rms_protocol::MAX_QUALITY_SAMPLE_BYTES - 16;
    for (_, row) in rows {
        let length = row.encoded_len();
        let framed = 1 + prost::length_delimiter_len(length) + length;
        if bytes + framed > budget {
            samples.omitted_rows = samples.omitted_rows.saturating_add(1);
            continue;
        }
        if samples.omitted_rows > 0 {
            samples.omitted_rows = samples.omitted_rows.saturating_add(1);
            continue;
        }
        bytes += framed;
        samples.rows.push(row);
    }
    rms_protocol::validate_quality_samples(&samples)
        .map_err(|error| anyhow!("quality sample rows are malformed: {error}"))?;
    Ok(samples)
}

fn finish<'v>(
    host: &HostState,
    eval: &Evaluator<'v, '_, '_>,
    groups: Vec<Vec<u32>>,
    ids: Vec<u32>,
) -> Result<Value<'v>> {
    let plan = host
        .quality
        .plan
        .lock()
        .expect("map-test quality poisoned")
        .clone()
        .ok_or_else(|| anyhow!("quality_check has no plan"))?;
    if host
        .quality
        .finished
        .lock()
        .expect("map-test quality poisoned")
        .is_some()
    {
        bail!("quality_check runs once per map test");
    }
    let results = {
        let stored = host
            .quality
            .results
            .lock()
            .expect("map-test quality poisoned");
        ids.iter()
            .map(|id| {
                stored
                    .get(*id as usize)
                    .cloned()
                    .ok_or_else(|| anyhow!("a quality case result is invalid"))
            })
            .collect::<Result<Vec<_>>>()?
    };
    let mut seen = BTreeSet::new();
    if results.iter().any(|result| !seen.insert(result.case)) {
        bail!("quality_check lists a case twice");
    }
    if !results.iter().any(|result| result.case == 0) {
        bail!("quality_check needs the generation case");
    }
    let mut positions = BTreeMap::new();
    let mut failed = 0_u32;
    let mut count = 0_u32;
    for (setting, group) in groups.iter().enumerate() {
        for (position, &handle) in group.iter().enumerate() {
            positions.insert(handle, (setting as u32, position));
            count += 1;
            if sample(host, handle)?.failure.is_some() {
                failed += 1;
            }
        }
    }
    if count == 0 {
        bail!("quality_check generated no samples");
    }
    let (block, handles) = block_of(&plan, count, failed, &results);
    let variants = host
        .variants
        .lock()
        .expect("map-test settings poisoned")
        .report()
        .map_or(0, |variants| variants.len());
    block.validate(variants)?;
    for item in &block.items {
        let worst_handles = handles
            .get(&(item.case.clone(), item.code.clone()))
            .cloned()
            .unwrap_or_default();
        let assertion = crate::quality_assertion(host, eval);
        for (worst, handle) in item.worst.iter().zip(worst_handles) {
            let Some(handle) = handle else {
                continue;
            };
            let mut measurements = BTreeMap::new();
            if let Some(value) = worst.value {
                measurements.insert("value".to_owned(), JsonValue::from(value));
            }
            if let Some([x, y]) = worst.tile {
                measurements.insert("tile_x".to_owned(), JsonValue::from(x));
                measurements.insert("tile_y".to_owned(), JsonValue::from(y));
            }
            crate::record_measured_finding(
                host,
                handle,
                item.message.clone(),
                measurements,
                Some(format!("{}/{}", item.case, item.code)),
                assertion.clone(),
                item.level == QualityLevel::Failure,
            )?;
        }
    }
    if block.result == QualityResult::Failed {
        host.mutable
            .lock()
            .expect("map-test state poisoned")
            .quality_failed = true;
    }
    let samples = if plan.sample_rows {
        Some(sample_rows(&positions, &results)?)
    } else {
        None
    };
    let text = crate::quality_text::render_quality_text(&block).join("\n");
    let heap = eval.heap();
    let value = heap.alloc(AllocStruct(vec![
        (
            "result",
            heap.alloc(match block.result {
                QualityResult::Passed => "passed",
                QualityResult::Warnings => "warnings",
                QualityResult::Failed => "failed",
            }),
        ),
        (
            "counts",
            heap.alloc(AllocStruct(vec![
                ("failures", heap.alloc(block.counts.failures)),
                ("warnings", heap.alloc(block.counts.warnings)),
                ("advice", heap.alloc(block.counts.advice)),
            ])),
        ),
        (
            "items",
            heap.alloc(AllocTuple(
                block
                    .items
                    .iter()
                    .map(|item| alloc_item(heap, item))
                    .collect::<Vec<_>>(),
            )),
        ),
        (
            "passed",
            heap.alloc(AllocTuple(
                block
                    .passed
                    .iter()
                    .map(|case| heap.alloc(case.as_str()))
                    .collect::<Vec<_>>(),
            )),
        ),
        (
            "skipped",
            heap.alloc(AllocTuple(
                block
                    .skipped
                    .iter()
                    .map(|skip| {
                        heap.alloc(AllocStruct(vec![
                            ("case", heap.alloc(skip.case.as_str())),
                            ("reason", heap.alloc(skip_name(skip.reason))),
                        ]))
                    })
                    .collect::<Vec<_>>(),
            )),
        ),
        ("omitted_items", heap.alloc(block.omitted_items)),
        ("samples", heap.alloc(block.samples)),
        ("failed_samples", heap.alloc(block.failed_samples)),
        ("text", heap.alloc(text.as_str())),
    ]));
    *host
        .quality
        .finished
        .lock()
        .expect("map-test quality poisoned") = Some(Finished { block, samples });
    Ok(value)
}

fn handle_groups<'v>(value: Value<'v>, heap: Heap<'v>) -> Result<Vec<Vec<u32>>> {
    let mut groups = Vec::new();
    for group in value
        .iterate(heap)
        .map_err(|_| anyhow!("quality_check samples are lists of sample handles"))?
    {
        groups.push(crate::value_u32_list(group, heap)?);
    }
    Ok(groups)
}

#[starlark_module]
pub(crate) fn library_globals(builder: &mut GlobalsBuilder) {
    fn __rms_quality_plan<'v>(
        target: Value<'v>,
        seeds: Value<'v>,
        settings: Value<'v>,
        cases: Value<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let host = host(eval)?;
        let heap = eval.heap();
        let mut stored = host.quality.plan.lock().expect("map-test quality poisoned");
        if stored.is_some() {
            bail!("quality_check runs once per map test");
        }
        let plan = Arc::new(new_plan(host, target, seeds, settings, cases, heap)?);
        *stored = Some(plan.clone());
        Ok(plan_value(heap, &plan))
    }

    fn __rms_quality_case<'v>(
        case_id: &str,
        handles: Value<'v>,
        thresholds: Value<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let host = host(eval)?;
        let heap = eval.heap();
        let Some(case) = quality::case_index(case_id) else {
            bail!("unknown quality-check case \"{}\"", case_id.escape_debug());
        };
        let handles = crate::value_u32_list(handles, heap)?;
        let limits = read_limits(thresholds, case)?;
        let result = summarise(host, case, &handles, &limits)?;
        let mut results = host
            .quality
            .results
            .lock()
            .expect("map-test quality poisoned");
        if results.len() >= MAX_GENERATED_MAPS {
            bail!("a map test can run at most {MAX_GENERATED_MAPS} quality cases");
        }
        let id = results.len() as u32;
        let value = case_value(heap, &result, id);
        results.push(Arc::new(result));
        Ok(value)
    }

    fn __rms_quality_finish<'v>(
        groups: Value<'v>,
        results: Value<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let host = host(eval)?;
        let heap = eval.heap();
        let groups = handle_groups(groups, heap)?;
        let ids = results
            .iterate(heap)
            .map_err(|_| anyhow!("quality_check results are case results"))?
            .map(unpack_u32)
            .collect::<Result<Vec<_>>>()?;
        finish(host, eval, groups, ids)
    }
}
