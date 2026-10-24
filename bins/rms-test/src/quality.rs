use std::collections::BTreeSet;

use anyhow::{Result, bail};
use rms_content::CivilizationId;
use rms_engine::{MapDimensions, PlayerConfiguration};
use rms_protocol::v1;
use serde::{Deserialize, Serialize};

use crate::MAX_GENERATED_MAPS;

pub const QUALITY_LIBRARY_MODULE: &str = "@rmside/quality";
pub const QUALITY_CASE_CATALOGUE_VERSION: &str = "1.0.0";
pub const WALK_RULES_ID: &str = "villager-1";
pub const QUALITY_CHECK_SCRIPT: &str =
    "load(\"@rmside/quality\", \"quality_check\")\nquality_check()\n";
pub const QUALITY_CHECK_SCRIPT_NAME: &str = "@rmside/quality";

pub const MAX_QUALITY_BLOCK_BYTES: usize = 16 * 1024;
pub const MAX_QUALITY_ITEMS_PER_CASE: usize = 6;
pub const MAX_QUALITY_WORST: usize = 3;
pub const MAX_QUALITY_MESSAGE_BYTES: usize = 120;
pub const MAX_QUALITY_LABEL_BYTES: usize = 80;
pub const MAX_QUALITY_UNIT_BYTES: usize = 16;
pub const MAX_QUALITY_VALUE: i64 = (1 << 53) - 1;
pub const MAX_QUALITY_TEXT_LINES: usize = 40;
pub const MAX_QUALITY_TEXT_LINES_PER_ITEM: usize = 2;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum HostData {
    Objects,
    Placements,
    Walk,
    Fields,
    Cut,
    Water,
    Elevation,
    CrossSeed,
}

impl HostData {
    pub const ALL: [Self; 8] = [
        Self::Objects,
        Self::Placements,
        Self::Walk,
        Self::Fields,
        Self::Cut,
        Self::Water,
        Self::Elevation,
        Self::CrossSeed,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Objects => "objects",
            Self::Placements => "placements",
            Self::Walk => "walk",
            Self::Fields => "fields",
            Self::Cut => "cut",
            Self::Water => "water",
            Self::Elevation => "elevation",
            Self::CrossSeed => "cross-seed",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QualityLevel {
    Failure,
    Warning,
    Advice,
}

impl QualityLevel {
    pub const fn rank(self) -> u8 {
        match self {
            Self::Failure => 0,
            Self::Warning => 1,
            Self::Advice => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct QualityCase {
    pub id: &'static str,
    pub highest_level: QualityLevel,
    pub always_on: bool,
    pub needs: &'static [HostData],
}

use HostData::{CrossSeed, Cut, Elevation, Fields, Objects, Placements, Walk, Water};

pub const QUALITY_CASES: [QualityCase; 14] = [
    QualityCase {
        id: "generation",
        highest_level: QualityLevel::Failure,
        always_on: true,
        needs: &[Objects, Placements],
    },
    QualityCase {
        id: "start-resources",
        highest_level: QualityLevel::Failure,
        always_on: false,
        needs: &[Objects, Walk, Fields],
    },
    QualityCase {
        id: "resource-distances",
        highest_level: QualityLevel::Failure,
        always_on: false,
        needs: &[Objects, Walk, Fields],
    },
    QualityCase {
        id: "shared-resources",
        highest_level: QualityLevel::Failure,
        always_on: false,
        needs: &[Objects, Walk, Fields],
    },
    QualityCase {
        id: "wood",
        highest_level: QualityLevel::Failure,
        always_on: false,
        needs: &[Objects, Walk, Fields],
    },
    QualityCase {
        id: "trapped",
        highest_level: QualityLevel::Failure,
        always_on: false,
        needs: &[Objects, Walk, Fields],
    },
    QualityCase {
        id: "paths",
        highest_level: QualityLevel::Failure,
        always_on: false,
        needs: &[Objects, Walk, Fields],
    },
    QualityCase {
        id: "building-space",
        highest_level: QualityLevel::Failure,
        always_on: false,
        needs: &[Objects, Walk, Fields, Cut],
    },
    QualityCase {
        id: "hills",
        highest_level: QualityLevel::Warning,
        always_on: false,
        needs: &[Objects, Elevation],
    },
    QualityCase {
        id: "water",
        highest_level: QualityLevel::Failure,
        always_on: false,
        needs: &[Objects, Walk, Fields, Water],
    },
    QualityCase {
        id: "spacing",
        highest_level: QualityLevel::Warning,
        always_on: false,
        needs: &[Objects],
    },
    QualityCase {
        id: "chokepoints",
        highest_level: QualityLevel::Warning,
        always_on: false,
        needs: &[Objects, Walk, Cut],
    },
    QualityCase {
        id: "variation",
        highest_level: QualityLevel::Advice,
        always_on: false,
        needs: &[Objects, CrossSeed],
    },
    QualityCase {
        id: "looks",
        highest_level: QualityLevel::Advice,
        always_on: false,
        needs: &[Objects, Water],
    },
];

pub fn case_index(id: &str) -> Option<usize> {
    QUALITY_CASES.iter().position(|case| case.id == id)
}

fn known_case_ids() -> String {
    QUALITY_CASES
        .iter()
        .map(|case| case.id)
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn select_cases<S: AsRef<str>>(ids: &[S]) -> Result<Vec<&'static QualityCase>> {
    if ids.is_empty() || ids.len() > rms_protocol::MAX_QUALITY_CASE_IDS {
        bail!(
            "a quality check names 1 to {} cases",
            rms_protocol::MAX_QUALITY_CASE_IDS
        );
    }
    let mut selected = BTreeSet::new();
    for id in ids {
        let id = id.as_ref();
        let Some(index) = case_index(id) else {
            bail!(
                "unknown quality-check case \"{}\"; the cases are {}",
                id.escape_debug(),
                known_case_ids()
            );
        };
        if !selected.insert(index) {
            bail!("the quality-check case \"{id}\" is listed twice");
        }
    }
    selected.extend(
        QUALITY_CASES
            .iter()
            .enumerate()
            .filter(|(_, case)| case.always_on)
            .map(|(index, _)| index),
    );
    Ok(selected
        .into_iter()
        .map(|index| &QUALITY_CASES[index])
        .collect())
}

pub fn needed_host_data(cases: &[&QualityCase]) -> BTreeSet<HostData> {
    cases
        .iter()
        .flat_map(|case| case.needs.iter().copied())
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QualitySettingsPlan {
    pub map_size: String,
    pub dimensions: MapDimensions,
    pub players: Vec<PlayerConfiguration>,
    pub seed_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QualityRunPlan {
    pub cases: Vec<&'static QualityCase>,
    pub seed_start: u32,
    pub seed_count: u32,
    pub settings: Vec<QualitySettingsPlan>,
    pub sample_rows: bool,
}

impl QualityRunPlan {
    pub fn sample_count(&self) -> u32 {
        if self.settings.is_empty() {
            self.seed_count
        } else {
            self.settings
                .iter()
                .map(|settings| settings.seed_count)
                .sum()
        }
    }

    pub fn seeds(&self, count: u32) -> impl Iterator<Item = u32> + '_ {
        (0..count).map(|ordinal| self.seed_start.wrapping_add(ordinal))
    }
}

pub fn requests_quality(request: &v1::MapTestRunRequest) -> bool {
    request.builtin != v1::MapTestBuiltin::Unspecified as i32
        || request.quality.is_some()
        || request.report_quality
}

pub fn quality_run_plan(request: &v1::MapTestRunRequest) -> Result<Option<QualityRunPlan>> {
    let Ok(builtin) = v1::MapTestBuiltin::try_from(request.builtin) else {
        bail!("unknown map-test built-in run");
    };
    if request.report_quality && !request.report_game_crashes {
        bail!("map-test quality reports (report 1.4) need the game-crash counts of report 1.2");
    }
    let options = match builtin {
        v1::MapTestBuiltin::Unspecified => {
            if request.quality.is_some() {
                bail!("quality-check options need the built-in quality check");
            }
            return Ok(None);
        }
        v1::MapTestBuiltin::QualityCheckV1 => request
            .quality
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("the built-in quality check needs its options"))?,
    };
    if !request.report_quality {
        bail!("the built-in quality check needs map-test report 1.4");
    }
    if !request.script.is_empty() {
        bail!("the built-in quality check takes no script");
    }
    if request.default_source_path.is_empty() {
        bail!("the built-in quality check needs the map to check");
    }
    let cases = select_cases(&options.case_ids)?;
    if !(1..=rms_protocol::MAX_QUALITY_SEEDS).contains(&options.seed_count) {
        bail!(
            "a quality check runs 1 to {} seeds per setting",
            rms_protocol::MAX_QUALITY_SEEDS
        );
    }
    if options.settings.len() > rms_protocol::MAX_QUALITY_SETTINGS {
        bail!(
            "a quality check samples at most {} settings",
            rms_protocol::MAX_QUALITY_SETTINGS
        );
    }
    let Ok(detail) = v1::QualityDetail::try_from(options.detail) else {
        bail!("unknown quality-check detail");
    };
    let settings = options
        .settings
        .iter()
        .map(|settings| settings_plan(settings, options.seed_count))
        .collect::<Result<Vec<_>>>()?;
    let plan = QualityRunPlan {
        cases,
        seed_start: options.seed_start,
        seed_count: options.seed_count,
        settings,
        sample_rows: detail == v1::QualityDetail::SampleRows,
    };
    if plan.sample_count() as usize > MAX_GENERATED_MAPS {
        bail!("a quality check generates at most {MAX_GENERATED_MAPS} maps");
    }
    Ok(Some(plan))
}

fn settings_plan(value: &v1::QualitySettings, default_seeds: u32) -> Result<QualitySettingsPlan> {
    if value.map_size.is_empty() || value.map_size.len() > 64 {
        bail!("a quality-check setting names its map size in 1 to 64 bytes");
    }
    let side = |tiles: u32| {
        u16::try_from(tiles)
            .ok()
            .filter(|tiles| (1..=512).contains(tiles))
    };
    let (Some(width), Some(height)) = (side(value.width), side(value.height)) else {
        bail!("a quality-check setting's map is 1 to 512 tiles on each side");
    };
    if value.players.is_empty() || value.players.len() > 8 {
        bail!("a quality-check setting needs 1 to 8 players");
    }
    let mut slots = BTreeSet::new();
    let players = value
        .players
        .iter()
        .map(|player| {
            let (Ok(slot), Ok(team), Ok(color)) = (
                u8::try_from(player.slot),
                u8::try_from(player.team),
                u8::try_from(player.color),
            ) else {
                bail!("a quality-check setting's player is out of range");
            };
            if !(1..=8).contains(&slot) || !slots.insert(slot) {
                bail!("a quality-check setting's player slots are 1 to 8 and unique");
            }
            Ok(PlayerConfiguration {
                slot,
                team,
                civilization_id: CivilizationId(player.civilization_id),
                color,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let seed_count = match value.seed_count {
        0 => default_seeds,
        count if count <= rms_protocol::MAX_QUALITY_SEEDS => count,
        _ => bail!(
            "a quality check runs 1 to {} seeds per setting",
            rms_protocol::MAX_QUALITY_SEEDS
        ),
    };
    Ok(QualitySettingsPlan {
        map_size: value.map_size.clone(),
        dimensions: MapDimensions { width, height },
        players,
        seed_count,
    })
}

pub const LOBBY_MAP_SIZES: [(&str, u16); 7] = [
    ("tiny", 120),
    ("small", 144),
    ("medium", 168),
    ("normal", 200),
    ("large", 220),
    ("huge", 240),
    ("ludicrous", 480),
];

pub fn lobby_map_side(map_size: &str) -> Option<u16> {
    LOBBY_MAP_SIZES
        .iter()
        .find(|(name, _)| *name == map_size)
        .map(|(_, side)| *side)
}

pub fn lobby_map_size_names() -> String {
    LOBBY_MAP_SIZES
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(", ")
}

pub const MAX_LOBBY_TEAM: u8 = 4;

pub const MULTI_SETTING_SEEDS: u32 = 10;

pub const MULTI_SETTINGS: [(&str, &str); 3] = [("tiny", "1v1"), ("medium", "2v2"), ("huge", "4v4")];

pub fn team_layout(layout: &str, players: Option<usize>) -> Result<Vec<u8>> {
    if layout == "ffa" {
        let Some(count) = players else {
            bail!("the team layout \"ffa\" needs a player count");
        };
        return Ok(vec![0; count]);
    }
    let sizes = layout
        .split('v')
        .map(|size| {
            (size.len() == 1)
                .then(|| size.parse::<usize>().ok())
                .flatten()
                .filter(|size| *size >= 1)
        })
        .collect::<Option<Vec<_>>>();
    let Some(sizes) = sizes.filter(|sizes| sizes.len() >= 2) else {
        bail!(
            "\"{}\" is not a team layout such as \"2v2\", \"2v1v1\" or \"ffa\"",
            layout.escape_debug()
        );
    };
    let total = sizes.iter().sum::<usize>();
    if total > 8 {
        bail!("the team layout \"{layout}\" has more than 8 players");
    }
    if players.is_some_and(|players| players != total) {
        bail!(
            "the team layout \"{layout}\" has {total} players, but players is {}",
            players.unwrap_or_default()
        );
    }
    if sizes.len() > usize::from(MAX_LOBBY_TEAM) {
        if sizes.iter().all(|size| *size == 1) {
            return Ok(vec![0; total]);
        }
        bail!(
            "the team layout \"{layout}\" has more than {MAX_LOBBY_TEAM} teams; use \"ffa\" for players without a team"
        );
    }
    Ok(sizes
        .iter()
        .enumerate()
        .flat_map(|(team, size)| std::iter::repeat_n(team as u8 + 1, *size))
        .collect())
}

pub fn setting_players(
    base: &[PlayerConfiguration],
    count: usize,
    teams: Option<&[u8]>,
) -> Vec<PlayerConfiguration> {
    let mut slots = BTreeSet::new();
    let mut colors = BTreeSet::new();
    (0..count.min(8))
        .map(|index| {
            let own = base.get(index);
            let slot = own
                .map(|player| player.slot)
                .filter(|slot| (1..=8).contains(slot) && !slots.contains(slot))
                .or_else(|| (1..=8).find(|slot| !slots.contains(slot)))
                .unwrap_or(1);
            let color = own
                .map(|player| player.color)
                .filter(|color| *color <= 7 && !colors.contains(color))
                .or_else(|| (0..=7).find(|color| !colors.contains(color)))
                .unwrap_or(0);
            slots.insert(slot);
            colors.insert(color);
            PlayerConfiguration {
                slot,
                team: teams
                    .and_then(|teams| teams.get(index).copied())
                    .unwrap_or_else(|| own.map_or(0, |player| player.team)),
                civilization_id: own
                    .or(base.first())
                    .map_or(CivilizationId(0), |player| player.civilization_id),
                color,
            }
        })
        .collect()
}

pub fn multi_settings(base: &[PlayerConfiguration]) -> Vec<QualitySettingsPlan> {
    MULTI_SETTINGS
        .iter()
        .map(|(map_size, layout)| {
            let teams = team_layout(layout, None).expect("the option's team layouts are valid");
            let side = lobby_map_side(map_size).expect("the option's map sizes are lobby sizes");
            QualitySettingsPlan {
                map_size: (*map_size).to_owned(),
                dimensions: MapDimensions {
                    width: side,
                    height: side,
                },
                players: setting_players(base, teams.len(), Some(&teams)),
                seed_count: MULTI_SETTING_SEEDS,
            }
        })
        .collect()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportSettingsVariant {
    pub width: u16,
    pub height: u16,
    pub map_size: String,
    pub players: Vec<PlayerConfiguration>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualityLibraryIdentity {
    pub version: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualityBlock {
    pub catalog: String,
    pub seed_start: u32,
    pub seed_count: u32,
    pub samples: u32,
    pub failed_samples: u32,
    pub cases: Vec<String>,
    pub skipped: Vec<QualitySkip>,
    pub result: QualityResult,
    pub counts: QualityCounts,
    pub items: Vec<QualityItem>,
    pub passed: Vec<String>,
    pub omitted_items: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualitySkip {
    pub case: String,
    pub reason: QualitySkipReason,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum QualitySkipReason {
    NotSelected,
    NotApplicable,
    NoSamples,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QualityResult {
    Passed,
    Warnings,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualityCounts {
    pub failures: u32,
    pub warnings: u32,
    pub advice: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualityItem {
    pub case: String,
    pub code: String,
    pub level: QualityLevel,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<QualityMetric>,
    pub bad: u32,
    pub of: u32,
    pub worst: Vec<QualityWorst>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualityMetric {
    pub label: String,
    pub unit: String,
    pub p5: i64,
    pub p50: i64,
    pub p95: i64,
    pub max: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualityWorst {
    pub seed: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub players: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<[u16; 2]>,
}

impl QualityItem {
    fn sort_key(&self) -> (u8, usize, &str) {
        (
            self.level.rank(),
            case_index(&self.case).unwrap_or(usize::MAX),
            &self.code,
        )
    }
}

impl QualityBlock {
    pub fn encoded_len(&self) -> usize {
        serde_json::to_vec(self).map_or(usize::MAX, |bytes| bytes.len())
    }

    pub fn fit_budget(&mut self) {
        self.items
            .sort_by(|left, right| left.sort_key().cmp(&right.sort_key()));
        let mut per_case = std::collections::BTreeMap::<String, usize>::new();
        let before = self.items.len();
        self.items.retain(|item| {
            let kept = per_case.entry(item.case.clone()).or_default();
            *kept += 1;
            *kept <= MAX_QUALITY_ITEMS_PER_CASE
        });
        let mut omitted = before - self.items.len();
        while self.encoded_len() > MAX_QUALITY_BLOCK_BYTES && self.items.pop().is_some() {
            omitted += 1;
        }
        self.omitted_items = self.omitted_items.saturating_add(omitted as u32);
    }

    pub fn validate(&self, settings_variants: usize) -> Result<()> {
        if self.catalog != QUALITY_CASE_CATALOGUE_VERSION {
            bail!("unknown quality case catalogue");
        }
        if !(1..=rms_protocol::MAX_QUALITY_SEEDS).contains(&self.seed_count)
            || !(1..=MAX_GENERATED_MAPS as u32).contains(&self.samples)
            || self.failed_samples > self.samples
        {
            bail!("quality sample counts are out of range");
        }
        let positions = |ids: &[String]| {
            ids.iter()
                .map(|id| case_index(id))
                .collect::<Option<Vec<_>>>()
        };
        let Some(cases) = positions(&self.cases) else {
            bail!("a quality case is unknown");
        };
        let skipped_ids = self
            .skipped
            .iter()
            .map(|skip| skip.case.clone())
            .collect::<Vec<_>>();
        let Some(skipped) = positions(&skipped_ids) else {
            bail!("a skipped quality case is unknown");
        };
        let ascending = |indexes: &[usize]| indexes.windows(2).all(|pair| pair[0] < pair[1]);
        if !ascending(&cases) || !ascending(&skipped) || !cases.contains(&0) {
            bail!("quality cases are not in catalogue order or lack generation");
        }
        let mut all = cases.iter().chain(&skipped).copied().collect::<Vec<_>>();
        all.sort_unstable();
        if all != (0..QUALITY_CASES.len()).collect::<Vec<_>>() {
            bail!("quality cases and skipped cases do not cover the catalogue once");
        }
        let Some(passed) = positions(&self.passed) else {
            bail!("a passed quality case is unknown");
        };
        if !ascending(&passed) || passed.iter().any(|index| !cases.contains(index)) {
            bail!("passed quality cases are not cases that ran, in order");
        }
        let mut kept = QualityCounts::default();
        let mut per_case = std::collections::BTreeMap::<&str, usize>::new();
        for (index, item) in self.items.iter().enumerate() {
            item.validate(self.samples, settings_variants)?;
            if !self.cases.contains(&item.case) {
                bail!("a quality item belongs to a case that did not run");
            }
            if index > 0 && self.items[index - 1].sort_key() >= item.sort_key() {
                bail!("quality items are not sorted and unique");
            }
            let count = per_case.entry(item.case.as_str()).or_default();
            *count += 1;
            if *count > MAX_QUALITY_ITEMS_PER_CASE {
                bail!("a quality case has more than six items");
            }
            match item.level {
                QualityLevel::Failure => kept.failures += 1,
                QualityLevel::Warning => kept.warnings += 1,
                QualityLevel::Advice => kept.advice += 1,
            }
            if item.level != QualityLevel::Advice && self.passed.contains(&item.case) {
                bail!("a passed quality case has a failure or warning");
            }
        }
        let counts = self.counts;
        if kept.failures > counts.failures
            || kept.warnings > counts.warnings
            || kept.advice > counts.advice
            || u64::from(counts.failures) + u64::from(counts.warnings) + u64::from(counts.advice)
                - self.items.len() as u64
                != u64::from(self.omitted_items)
        {
            bail!("quality counts do not match the items and omitted items");
        }
        let result = if counts.failures > 0 {
            QualityResult::Failed
        } else if counts.warnings > 0 {
            QualityResult::Warnings
        } else {
            QualityResult::Passed
        };
        if self.result != result {
            bail!("the quality result does not match its counts");
        }
        if self.encoded_len() > MAX_QUALITY_BLOCK_BYTES {
            bail!("the quality block exceeds 16 KiB");
        }
        Ok(())
    }
}

fn bounded_text(text: &str, maximum: usize) -> bool {
    !text.is_empty() && text.len() <= maximum && !text.chars().any(char::is_control)
}

impl QualityItem {
    fn validate(&self, samples: u32, settings_variants: usize) -> Result<()> {
        if !rms_protocol::is_quality_id(&self.code) {
            bail!("a quality item code is malformed");
        }
        if !bounded_text(&self.message, MAX_QUALITY_MESSAGE_BYTES) {
            bail!("a quality item message is not one line of 1 to 120 bytes");
        }
        if let Some(metric) = &self.metric {
            if !bounded_text(&metric.label, MAX_QUALITY_LABEL_BYTES)
                || !bounded_text(&metric.unit, MAX_QUALITY_UNIT_BYTES)
            {
                bail!("a quality metric label or unit is out of bounds");
            }
            let values = [metric.p5, metric.p50, metric.p95, metric.max];
            if values.iter().any(|value| value.abs() > MAX_QUALITY_VALUE)
                || !values.windows(2).all(|pair| pair[0] <= pair[1])
            {
                bail!("quality percentiles are out of range or out of order");
            }
        }
        if self.of == 0 || self.of > samples || self.bad > self.of {
            bail!("a quality item's sample counts are out of range");
        }
        if self.worst.len() > MAX_QUALITY_WORST {
            bail!("a quality item names more than three worst samples");
        }
        for worst in &self.worst {
            if worst.value.is_some() != self.metric.is_some()
                || worst
                    .value
                    .is_some_and(|value| value.abs() > MAX_QUALITY_VALUE)
            {
                bail!("a worst sample's value does not match its item");
            }
            if worst
                .settings_index
                .is_some_and(|index| index as usize >= settings_variants)
            {
                bail!("a worst sample names an unknown settings variant");
            }
            if worst.players.as_ref().is_some_and(|players| {
                players.is_empty()
                    || players.len() > rms_protocol::MAX_QUALITY_PLAYER_VALUES
                    || players.iter().any(|value| value.abs() > MAX_QUALITY_VALUE)
            }) {
                bail!("a worst sample's player values are out of range");
            }
            if worst.tile.is_some_and(|[x, y]| x > 511 || y > 511) {
                bail!("a worst sample's tile is outside the largest map");
            }
        }
        Ok(())
    }
}
