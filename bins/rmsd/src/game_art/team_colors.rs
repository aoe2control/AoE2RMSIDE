use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const PALETTES: [&str; 3] = ["resources", "_common", "palettes"];
pub(crate) const SPRITE_COLORS: &str = "spritecolors.json";
pub(crate) const PLAYER_COLOR_PALETTES: [&str; 8] = [
    "playercolor_blue.pal",
    "playercolor_red.pal",
    "playercolor_green.pal",
    "playercolor_yellow.pal",
    "playercolor_teal.pal",
    "playercolor_purple.pal",
    "playercolor_grey.pal",
    "playercolor_orange.pal",
];
pub(crate) const MAXIMUM_TEAM_COLOR_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct TeamColor {
    pub(crate) red: f64,
    pub(crate) green: f64,
    pub(crate) blue: f64,
    pub(crate) pivot: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct TeamColors {
    pub(crate) gaia: Option<TeamColor>,
    pub(crate) players: Vec<Option<TeamColor>>,
}

fn unit(value: Option<&Value>) -> Option<f64> {
    let value = value?.as_f64()?;
    (value.is_finite() && (0.0..=1.0).contains(&value)).then_some(value)
}

fn team_color(entry: Option<&Value>) -> Option<TeamColor> {
    let rgba = entry?.get("FloatRGBA")?;
    Some(TeamColor {
        red: unit(rgba.get("r"))?,
        green: unit(rgba.get("g"))?,
        blue: unit(rgba.get("b"))?,
        pivot: match rgba.get("a") {
            None => 1.0,
            pivot => unit(pivot)?,
        },
    })
}

pub(crate) fn parse_sprite_colors(bytes: &[u8]) -> Option<TeamColors> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let document: Value = serde_json::from_slice(bytes).ok()?;
    let teams = document.get("TeamColors")?.as_object()?;
    Some(TeamColors {
        gaia: team_color(teams.get("Gaia")),
        players: (1..=PLAYER_COLOR_PALETTES.len())
            .map(|player| team_color(teams.get(&format!("Player {player}"))))
            .collect(),
    })
}

pub(crate) fn palette_team_color(bytes: &[u8]) -> Option<TeamColor> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    if lines.next()? != "JASC-PAL" || lines.next()? != "0100" {
        return None;
    }
    let count: usize = lines.next()?.parse().ok()?;
    if count == 0 {
        return None;
    }
    let mut channels = lines.next()?.split_whitespace().map(str::parse::<u8>);
    let mut channel = || channels.next()?.ok().map(|value| f64::from(value) / 255.0);
    Some(TeamColor {
        red: channel()?,
        green: channel()?,
        blue: channel()?,
        pivot: 1.0,
    })
}

pub(crate) fn installation_team_colors(
    mut read: impl FnMut(&str) -> Option<Vec<u8>>,
) -> Option<TeamColors> {
    let document = read(SPRITE_COLORS).and_then(|bytes| parse_sprite_colors(&bytes));
    let players = PLAYER_COLOR_PALETTES
        .iter()
        .enumerate()
        .map(|(index, file)| {
            document
                .as_ref()
                .and_then(|colors| colors.players.get(index).copied().flatten())
                .or_else(|| read(file).and_then(|bytes| palette_team_color(&bytes)))
        })
        .collect::<Vec<_>>();
    let gaia = document.and_then(|colors| colors.gaia);
    (gaia.is_some() || players.iter().any(Option::is_some)).then_some(TeamColors { gaia, players })
}
