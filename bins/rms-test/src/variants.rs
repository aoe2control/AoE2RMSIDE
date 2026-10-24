use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use rms_content::CivilizationId;
use rms_engine::{MapDimensions, PlayerConfiguration};
use starlark::environment::GlobalsBuilder;
use starlark::eval::Evaluator;
use starlark::starlark_module;
use starlark::values::structs::AllocStruct;
use starlark::values::tuple::AllocTuple;
use starlark::values::{Heap, Value};

use crate::quality::{self, ReportSettingsVariant};
use crate::{HostState, RunConfiguration, host, optional_u32, sample, unpack_u32};

pub(crate) const MAX_SETTINGS_VARIANTS: usize = rms_protocol::MAX_QUALITY_SETTINGS;
const MAX_VARIANT_SIDE: u16 = 512;

const NOT_SETTINGS: &str = "a lobby setting is a value of rms.settings(), or a list of them";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LobbySettings {
    pub map_size: String,
    pub dimensions: MapDimensions,
    pub players: Vec<PlayerConfiguration>,
}

impl LobbySettings {
    pub fn of_run(config: &RunConfiguration) -> Self {
        Self {
            map_size: config.map_size.clone(),
            dimensions: config.dimensions,
            players: config.players.clone(),
        }
    }

    pub fn report(&self) -> ReportSettingsVariant {
        ReportSettingsVariant {
            width: self.dimensions.width,
            height: self.dimensions.height,
            map_size: self.map_size.clone(),
            players: self.players.clone(),
        }
    }

    pub fn tiles(&self) -> u64 {
        u64::from(self.dimensions.width) * u64::from(self.dimensions.height)
    }

    fn check(&self) -> Result<()> {
        if self.map_size.is_empty()
            || self.map_size.len() > 64
            || self.map_size.chars().any(char::is_control)
        {
            bail!("a lobby setting names its map size in 1 to 64 bytes");
        }
        let MapDimensions { width, height } = self.dimensions;
        if !(1..=MAX_VARIANT_SIDE).contains(&width) || !(1..=MAX_VARIANT_SIDE).contains(&height) {
            bail!("a lobby setting's map is 1 to {MAX_VARIANT_SIDE} tiles on each side");
        }
        if let Some(side) = quality::lobby_map_side(&self.map_size)
            && (width != side || height != side)
        {
            bail!(
                "a {} map is {side} tiles on each side, not {width} by {height}",
                self.map_size
            );
        }
        if self.players.is_empty() || self.players.len() > 8 {
            bail!("a lobby setting needs 1 to 8 players");
        }
        let mut slots = [false; 9];
        for player in &self.players {
            let slot = usize::from(player.slot);
            if !(1..=8).contains(&slot) || std::mem::replace(&mut slots[slot], true) {
                bail!("a lobby setting's player slots are 1 to 8 and unique");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
pub(crate) struct SettingsVariants {
    variants: Vec<Arc<LobbySettings>>,
}

impl SettingsVariants {
    pub fn get(&self, index: u8) -> Option<Arc<LobbySettings>> {
        self.variants.get(usize::from(index)).cloned()
    }

    pub fn report(&self) -> Option<Vec<ReportSettingsVariant>> {
        (!self.variants.is_empty()).then(|| {
            self.variants
                .iter()
                .map(|variant| variant.report())
                .collect()
        })
    }

    pub fn largest_tiles(&self) -> u64 {
        self.variants
            .iter()
            .map(|variant| variant.tiles())
            .max()
            .unwrap_or(0)
    }
}

pub(crate) fn settings_indexes(
    host: &HostState,
    settings: Option<Vec<LobbySettings>>,
) -> Result<Vec<Option<u8>>> {
    let Some(settings) = settings else {
        return Ok(vec![None]);
    };
    if settings.is_empty() || settings.len() > MAX_SETTINGS_VARIANTS {
        bail!("rms.generate settings lists 1 to {MAX_SETTINGS_VARIANTS} lobby settings");
    }
    for (index, setting) in settings.iter().enumerate() {
        if settings[..index].contains(setting) {
            bail!("rms.generate settings lists the same lobby setting twice");
        }
    }
    let run = LobbySettings::of_run(&host.context.config);
    let others = settings
        .iter()
        .filter(|setting| **setting != run)
        .collect::<Vec<_>>();
    if others.is_empty() {
        return Ok(vec![None; settings.len()]);
    }
    if !host.quality_report {
        bail!(
            "rms.generate can sample other lobby settings only with the quality check, which this run does not have; leave settings out to use the run's own"
        );
    }
    for setting in &others {
        setting.check()?;
    }
    let mut variants = host.variants.lock().expect("map-test settings poisoned");
    let new = others
        .iter()
        .filter(|setting| {
            !variants
                .variants
                .iter()
                .any(|known| known.as_ref() == **setting)
        })
        .count();
    if variants.variants.len() + new > MAX_SETTINGS_VARIANTS {
        bail!("a map test samples at most {MAX_SETTINGS_VARIANTS} lobby settings besides its own");
    }
    Ok(settings
        .into_iter()
        .map(|setting| {
            if setting == run {
                return None;
            }
            let index = match variants
                .variants
                .iter()
                .position(|known| known.as_ref() == &setting)
            {
                Some(index) => index,
                None => {
                    variants.variants.push(Arc::new(setting));
                    variants.variants.len() - 1
                }
            };
            Some(index as u8)
        })
        .collect())
}

pub(crate) fn sample_settings(host: &HostState, index: Option<u8>) -> Result<Arc<LobbySettings>> {
    match index {
        None => Ok(Arc::new(LobbySettings::of_run(&host.context.config))),
        Some(index) => host
            .variants
            .lock()
            .expect("map-test settings poisoned")
            .get(index)
            .ok_or_else(|| anyhow!("settings variant is invalid")),
    }
}

pub(crate) fn alloc_settings<'v>(heap: Heap<'v>, settings: &LobbySettings) -> Value<'v> {
    let players = settings
        .players
        .iter()
        .map(|player| {
            heap.alloc(AllocStruct(vec![
                ("slot", heap.alloc(u32::from(player.slot))),
                ("team", heap.alloc(u32::from(player.team))),
                ("civilization_id", heap.alloc(player.civilization_id.0)),
                ("color", heap.alloc(u32::from(player.color))),
            ]))
        })
        .collect::<Vec<_>>();
    heap.alloc(AllocStruct(vec![
        ("map_size", heap.alloc(settings.map_size.as_str())),
        ("width", heap.alloc(u32::from(settings.dimensions.width))),
        ("height", heap.alloc(u32::from(settings.dimensions.height))),
        ("players", heap.alloc(AllocTuple(players))),
    ]))
}

fn attribute<'v>(value: Value<'v>, name: &str, heap: Heap<'v>) -> Result<Value<'v>> {
    value
        .get_attr(name, heap)
        .map_err(|error| anyhow!("{error:#}"))?
        .ok_or_else(|| anyhow!(NOT_SETTINGS))
}

fn small<T: TryFrom<u32>>(value: Value<'_>) -> Result<T> {
    T::try_from(unpack_u32(value)?).map_err(|_| anyhow!("a lobby setting's player is out of range"))
}

fn settings_from_value<'v>(value: Value<'v>, heap: Heap<'v>) -> Result<LobbySettings> {
    let map_size = attribute(value, "map_size", heap)?
        .unpack_str()
        .ok_or_else(|| anyhow!(NOT_SETTINGS))?
        .to_owned();
    let side = |name: &str| -> Result<u16> {
        u16::try_from(unpack_u32(attribute(value, name, heap)?)?).map_err(|_| {
            anyhow!("a lobby setting's map is 1 to {MAX_VARIANT_SIDE} tiles on each side")
        })
    };
    let dimensions = MapDimensions {
        width: side("width")?,
        height: side("height")?,
    };
    let mut players = Vec::new();
    for player in attribute(value, "players", heap)?
        .iterate(heap)
        .map_err(|_| anyhow!(NOT_SETTINGS))?
    {
        if players.len() >= 8 {
            bail!("a lobby setting needs 1 to 8 players");
        }
        players.push(PlayerConfiguration {
            slot: small(attribute(player, "slot", heap)?)?,
            team: small(attribute(player, "team", heap)?)?,
            civilization_id: CivilizationId(unpack_u32(attribute(
                player,
                "civilization_id",
                heap,
            )?)?),
            color: small(attribute(player, "color", heap)?)?,
        });
    }
    Ok(LobbySettings {
        map_size,
        dimensions,
        players,
    })
}

pub(crate) fn settings_argument<'v>(
    value: Value<'v>,
    heap: Heap<'v>,
) -> Result<Option<Vec<LobbySettings>>> {
    if value.is_none() {
        return Ok(None);
    }
    if !matches!(value.get_type(), "list" | "tuple") {
        return Ok(Some(vec![settings_from_value(value, heap)?]));
    }
    let mut settings = Vec::new();
    for item in value.iterate(heap).map_err(|_| anyhow!(NOT_SETTINGS))? {
        if settings.len() >= MAX_SETTINGS_VARIANTS {
            bail!("rms.generate settings lists 1 to {MAX_SETTINGS_VARIANTS} lobby settings");
        }
        settings.push(settings_from_value(item, heap)?);
    }
    Ok(Some(settings))
}

fn teams_argument<'v>(
    value: Value<'v>,
    players: Option<usize>,
    run_players: usize,
    heap: Heap<'v>,
) -> Result<Option<Vec<u8>>> {
    const TEAMS: &str = "rms.settings teams is a list of team numbers from 0 to 4, one per player, or a layout such as \"2v2\" or \"ffa\"";
    if value.is_none() {
        return Ok(None);
    }
    if let Some(layout) = value.unpack_str() {
        let players = match layout {
            "ffa" => players.or(Some(run_players)),
            _ => players,
        };
        return quality::team_layout(layout, players)
            .map(Some)
            .map_err(|error| anyhow!("rms.settings teams: {error}"));
    }
    let mut teams = Vec::new();
    for item in value.iterate(heap).map_err(|_| anyhow!(TEAMS))? {
        if teams.len() >= 8 {
            bail!("rms.settings teams names at most 8 players");
        }
        let team = unpack_u32(item).map_err(|_| anyhow!(TEAMS))?;
        if team > u32::from(quality::MAX_LOBBY_TEAM) {
            bail!(TEAMS);
        }
        teams.push(team as u8);
    }
    if teams.is_empty() {
        bail!(TEAMS);
    }
    if let Some(players) = players
        && players != teams.len()
    {
        bail!(
            "rms.settings teams names {} players, but players is {players}",
            teams.len()
        );
    }
    Ok(Some(teams))
}

fn new_settings<'v>(
    run: LobbySettings,
    map_size: Value<'v>,
    players: Value<'v>,
    teams: Value<'v>,
    heap: Heap<'v>,
) -> Result<LobbySettings> {
    let mut settings = run;
    if !map_size.is_none() {
        let name = map_size.unpack_str().ok_or_else(|| {
            anyhow!(
                "rms.settings map_size is one of {}",
                quality::lobby_map_size_names()
            )
        })?;
        if name != settings.map_size {
            let Some(side) = quality::lobby_map_side(name) else {
                bail!(
                    "rms.settings map_size is one of {}, not \"{}\"",
                    quality::lobby_map_size_names(),
                    name.escape_debug()
                );
            };
            settings.map_size = name.to_owned();
            settings.dimensions = MapDimensions {
                width: side,
                height: side,
            };
        }
    }
    let count = optional_u32(players)
        .map_err(|_| anyhow!("rms.settings players is a number from 1 to 8"))?
        .map(|count| {
            if (1..=8).contains(&count) {
                Ok(count as usize)
            } else {
                Err(anyhow!("rms.settings players is a number from 1 to 8"))
            }
        })
        .transpose()?;
    let teams = teams_argument(teams, count, settings.players.len(), heap)?;
    let count = teams
        .as_ref()
        .map(Vec::len)
        .or(count)
        .unwrap_or(settings.players.len());
    if count == settings.players.len() {
        if let Some(teams) = &teams {
            for (player, team) in settings.players.iter_mut().zip(teams) {
                player.team = *team;
            }
        }
    } else {
        settings.players = quality::setting_players(&settings.players, count, teams.as_deref());
    }
    Ok(settings)
}

#[starlark_module]
pub(crate) fn variant_globals(builder: &mut GlobalsBuilder) {
    fn __rms_settings<'v>(
        map_size: Value<'v>,
        players: Value<'v>,
        teams: Value<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let run = LobbySettings::of_run(&host(eval)?.context.config);
        let heap = eval.heap();
        let settings = new_settings(run, map_size, players, teams, heap)?;
        Ok(alloc_settings(heap, &settings))
    }

    fn __rms_sample_settings<'v>(
        handle: u32,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let host = host(eval)?;
        let settings = sample_settings(host, sample(host, handle)?.settings_index)?;
        Ok(alloc_settings(eval.heap(), &settings))
    }

    fn __rms_sample_settings_index<'v>(
        handle: u32,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        Ok(sample(host(eval)?, handle)?
            .settings_index
            .map_or_else(Value::new_none, |index| eval.heap().alloc(u32::from(index))))
    }
}
