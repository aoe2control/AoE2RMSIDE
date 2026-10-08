use super::*;
use rms_content::{
    ObjectId, RestrictionId, TerrainAppearanceDefinition, TerrainAppearancePlacement,
};
use rms_semantics::RmsRandom;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AppearanceCandidate {
    pub object_id: Option<ObjectId>,
    pub placement_restriction_id: Option<RestrictionId>,
    pub placement: TerrainAppearancePlacement,
    pub x_sample: Option<u32>,
    pub y_sample: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AppearanceAcceptance {
    pub object_id: Option<ObjectId>,
    pub placement: TerrainAppearancePlacement,
    pub x_sample: Option<u32>,
    pub y_sample: Option<u32>,
    pub auxiliary_sample: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactAppearanceObject {
    pub tile_index: u32,
    pub source_terrain_id: TerrainId,
    pub object_id: ObjectId,
    pub placement: TerrainAppearancePlacement,
    pub x_sample: Option<u32>,
    pub y_sample: Option<u32>,
    pub auxiliary_sample: Option<u32>,
}

impl ExactAppearanceObject {
    pub(crate) fn from_acceptance(
        tile_index: usize,
        source_terrain_id: TerrainId,
        acceptance: AppearanceAcceptance,
    ) -> Option<Self> {
        Some(Self {
            tile_index: u32::try_from(tile_index).ok()?,
            source_terrain_id,
            object_id: acceptance.object_id?,
            placement: acceptance.placement,
            x_sample: acceptance.x_sample,
            y_sample: acceptance.y_sample,
            auxiliary_sample: acceptance.auxiliary_sample,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn remove_replaced_appearances_on_terrain(
    appearances: &[ExactAppearanceObject],
    removed: &mut BTreeSet<u32>,
    roster: &mut super::exact_world::ObjectRoster,
    dimensions: MapDimensions,
    tile_index: usize,
    previous: TerrainId,
    content: CompatibleContentView<'_>,
    attributes: &super::exact_object::ObjectRuntimeAttributes,
    mut rejects_placement: impl FnMut(super::exact_world::WorldObject) -> Result<bool, GenerationError>,
    terrain: Option<&[TerrainId]>,
) -> Result<(), GenerationError> {
    let frames = &content
        .terrain(previous)
        .ok_or(GenerationError::IncompatibleContent)?
        .appearances;
    if tile_index >= dimensions.tile_count()? {
        return Err(GenerationError::IncompatibleContent);
    }
    let tile = MapCoordinate {
        x: (tile_index % usize::from(dimensions.width)) as u16,
        y: (tile_index / usize::from(dimensions.width)) as u16,
    };
    let mut index = 0;
    while let Some(&identity) = roster.members(tile).get(index) {
        let object = roster
            .object(identity)
            .ok_or(GenerationError::IncompatibleContent)?;
        if appearances
            .get(identity as usize)
            .is_some_and(|appearance| {
                object.object_id != appearance.object_id || removed.contains(&identity)
            })
        {
            return Err(GenerationError::IncompatibleContent);
        }
        if object.object_id.0 == 0 {
            index += 1;
            continue;
        }
        if frames
            .iter()
            .any(|frame| frame.object_id == Some(object.object_id))
            || rejects_placement(object)?
        {
            super::exact_object::destroy_world_object_on_terrain(
                roster, identity, content, attributes, true, terrain,
            )?;
            if (identity as usize) < appearances.len() {
                removed.insert(identity);
            }
        } else {
            index += 1;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct AppearanceRngStatistics {
    pub primary_draws: u64,
    pub auxiliary_draws: u64,
}

pub(crate) fn consume_terrain_appearances(
    appearances: &[TerrainAppearanceDefinition],
    rng: &mut RmsRandom,
    auxiliary_rng: &mut RmsRandom,
    stage: GenerationStage,
    cancellation: &dyn CancellationToken,
    mut commit: impl FnMut(AppearanceCandidate, &mut RmsRandom) -> Result<bool, GenerationError>,
) -> Result<AppearanceRngStatistics, GenerationError> {
    let mut statistics = AppearanceRngStatistics::default();
    for appearance in appearances {
        if statistics.primary_draws % 1024 == 0 {
            cancellation_checkpoint(cancellation, stage, statistics.primary_draws)?;
        }
        let (is_accepted, x_sample, y_sample) = match appearance.placement {
            TerrainAppearancePlacement::Randomized => match appearance.weight_per_thousand {
                0 => (false, None, None),
                1_000 => {
                    let x = rng.next_u32();
                    let y = rng.next_u32();
                    statistics.primary_draws += 2;
                    (true, Some(x), Some(y))
                }
                weight => {
                    let x = rng.next_u32();
                    let y = rng.next_u32();
                    let roll = rng.next_u32();
                    statistics.primary_draws += 3;
                    (thousandth_roll(roll) < u32::from(weight), Some(x), Some(y))
                }
            },
            TerrainAppearancePlacement::Centered => match appearance.weight_per_thousand {
                0 => (false, None, None),
                1_000 => (true, None, None),
                weight => {
                    let roll = rng.next_u32();
                    statistics.primary_draws += 1;
                    (thousandth_roll(roll) < u32::from(weight), None, None)
                }
            },
        };
        if is_accepted {
            let candidate = AppearanceCandidate {
                object_id: appearance.object_id,
                placement_restriction_id: appearance.placement_restriction_id,
                placement: appearance.placement,
                x_sample,
                y_sample,
            };
            if commit(candidate, auxiliary_rng)? {
                statistics.auxiliary_draws += 1;
            }
        }
    }
    Ok(statistics)
}

fn thousandth_roll(raw: u32) -> u32 {
    ((u64::from(raw) * 1_000) >> 32) as u32
}
