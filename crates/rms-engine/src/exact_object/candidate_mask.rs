use std::rc::Rc;

use super::*;
use crate::placement_oracle::{self, AcceleratorFault, OracleCheck, PlacementCheckMode};

pub(super) fn fresh_version() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct TileBits {
    width: usize,
    height: usize,
    stride: usize,
    words: Vec<u64>,
}

impl TileBits {
    pub(super) fn new(width: usize, height: usize) -> Self {
        let stride = width.div_ceil(64);
        Self {
            width,
            height,
            stride,
            words: vec![0; stride * height],
        }
    }

    pub(super) fn for_dimensions(dimensions: MapDimensions) -> Self {
        Self::new(
            usize::from(dimensions.width),
            usize::from(dimensions.height),
        )
    }

    pub(super) fn from_fn(width: usize, height: usize, value: impl Fn(usize) -> bool) -> Self {
        let mut bits = Self::new(width, height);
        for tile in 0..width * height {
            if value(tile) {
                bits.set(tile, true);
            }
        }
        bits
    }

    pub(super) fn has_shape(&self, dimensions: MapDimensions) -> bool {
        self.width == usize::from(dimensions.width) && self.height == usize::from(dimensions.height)
    }

    #[inline]
    fn position(&self, tile: usize) -> (usize, u64) {
        let (y, x) = (tile / self.width, tile % self.width);
        (y * self.stride + x / 64, 1_u64 << (x % 64))
    }

    #[inline]
    pub(super) fn get(&self, tile: usize) -> bool {
        let (word, bit) = self.position(tile);
        self.words[word] & bit != 0
    }

    #[inline]
    pub(super) fn get_xy(&self, x: usize, y: usize) -> bool {
        self.words[y * self.stride + x / 64] & (1_u64 << (x % 64)) != 0
    }

    #[inline]
    pub(super) fn set(&mut self, tile: usize, value: bool) {
        let (word, bit) = self.position(tile);
        if value {
            self.words[word] |= bit;
        } else {
            self.words[word] &= !bit;
        }
    }

    fn row(&self, y: usize) -> &[u64] {
        &self.words[y * self.stride..(y + 1) * self.stride]
    }

    fn row_mut(&mut self, y: usize) -> &mut [u64] {
        &mut self.words[y * self.stride..(y + 1) * self.stride]
    }

    pub(super) fn fill_span(&mut self, y: usize, minimum_x: usize, maximum_x: usize) {
        debug_assert!(minimum_x <= maximum_x && maximum_x < self.width);
        let row = self.row_mut(y);
        let (first, last) = (minimum_x / 64, maximum_x / 64);
        for (offset, word) in row[first..=last].iter_mut().enumerate() {
            let index = first + offset;
            let mut mask = u64::MAX;
            if index == first {
                mask &= u64::MAX << (minimum_x % 64);
            }
            if index == last {
                mask &= u64::MAX >> (63 - maximum_x % 64);
            }
            *word |= mask;
        }
    }

    pub(super) fn and_rows(&mut self, other: &Self, minimum_y: usize, maximum_y: usize) {
        if minimum_y > maximum_y {
            return;
        }
        let range = minimum_y * self.stride..(maximum_y + 1) * self.stride;
        for (word, other) in self.words[range.clone()]
            .iter_mut()
            .zip(&other.words[range])
        {
            *word &= other;
        }
    }

    pub(super) fn and_not_rows(&mut self, other: &Self, minimum_y: usize, maximum_y: usize) {
        if minimum_y > maximum_y {
            return;
        }
        let range = minimum_y * self.stride..(maximum_y + 1) * self.stride;
        for (word, other) in self.words[range.clone()]
            .iter_mut()
            .zip(&other.words[range])
        {
            *word &= !other;
        }
    }

    pub(super) fn or_rows(&mut self, other: &Self, minimum_y: usize, maximum_y: usize) {
        if minimum_y > maximum_y {
            return;
        }
        let range = minimum_y * self.stride..(maximum_y + 1) * self.stride;
        for (word, other) in self.words[range.clone()]
            .iter_mut()
            .zip(&other.words[range])
        {
            *word |= other;
        }
    }

    pub(super) fn or_assign(&mut self, other: &Self) {
        for (word, other) in self.words.iter_mut().zip(&other.words) {
            *word |= other;
        }
    }

    pub(super) fn clear_rows(&mut self, minimum_y: usize, maximum_y: usize) {
        if minimum_y > maximum_y {
            return;
        }
        self.words[minimum_y * self.stride..(maximum_y + 1) * self.stride].fill(0);
    }

    fn clear_padding(&mut self) {
        let used = self.width % 64;
        if used == 0 || self.stride == 0 {
            return;
        }
        let mask = u64::MAX >> (64 - used);
        for y in 0..self.height {
            self.words[y * self.stride + self.stride - 1] &= mask;
        }
    }

    pub(super) fn dilated(&self, negative: u32, positive: u32) -> Self {
        let mut bits = self.clone();
        if bits.width == 0 || bits.height == 0 {
            return bits;
        }
        if placement_oracle::fault() == AcceleratorFault::ClassMaskShrinksWindow {
            let positive = positive.saturating_sub(1);
            bits.dilate_rows(negative, positive);
            bits.dilate_columns(negative, positive);
            return bits;
        }
        bits.dilate_rows(negative, positive);
        bits.dilate_columns(negative, positive);
        bits
    }

    fn dilate_rows(&mut self, negative: u32, positive: u32) {
        let reach = |amount: u32| (amount as usize).min(self.width.saturating_sub(1));
        let (negative, positive) = (reach(negative), reach(positive));
        let stride = self.stride;
        for y in 0..self.height {
            let row = &mut self.words[y * stride..(y + 1) * stride];
            or_prefix(positive, |shift| or_shifted_toward_lower(row, shift));
            or_prefix(negative, |shift| or_shifted_toward_higher(row, shift));
        }
        self.clear_padding();
    }

    fn dilate_columns(&mut self, negative: u32, positive: u32) {
        let reach = |amount: u32| (amount as usize).min(self.height.saturating_sub(1));
        let (negative, positive) = (reach(negative), reach(positive));
        let (stride, height) = (self.stride, self.height);
        let words = &mut self.words;
        or_prefix(positive, |shift| {
            for y in 0..height.saturating_sub(shift) {
                let (head, tail) = words.split_at_mut((y + shift) * stride);
                for (word, source) in head[y * stride..(y + 1) * stride]
                    .iter_mut()
                    .zip(&tail[..stride])
                {
                    *word |= source;
                }
            }
        });
        or_prefix(negative, |shift| {
            for y in (shift..height).rev() {
                let (head, tail) = words.split_at_mut(y * stride);
                for (word, source) in tail[..stride]
                    .iter_mut()
                    .zip(&head[(y - shift) * stride..(y - shift + 1) * stride])
                {
                    *word |= source;
                }
            }
        });
    }

    pub(super) fn push_ones(&self, window: CandidateWindow, output: &mut Vec<usize>) {
        let (minimum_x, maximum_x) = (usize::from(window.minimum_x), usize::from(window.maximum_x));
        if minimum_x > maximum_x || window.minimum_y > window.maximum_y {
            return;
        }
        let (first, last) = (minimum_x / 64, maximum_x / 64);
        for y in usize::from(window.minimum_y)..=usize::from(window.maximum_y) {
            let row = self.row(y);
            for (index, &word) in row.iter().enumerate().take(last + 1).skip(first) {
                let mut word = word;
                if index == first {
                    word &= u64::MAX << (minimum_x % 64);
                }
                if index == last {
                    word &= u64::MAX >> (63 - maximum_x % 64);
                }
                while word != 0 {
                    let bit = word.trailing_zeros() as usize;
                    output.push(y * self.width + index * 64 + bit);
                    word &= word - 1;
                }
            }
        }
    }
}

fn or_prefix(amount: usize, mut step: impl FnMut(usize)) {
    let mut covered = 1_usize;
    while covered <= amount {
        let shift = covered.min(amount + 1 - covered);
        step(shift);
        covered += shift;
    }
}

fn or_shifted_toward_lower(row: &mut [u64], shift: usize) {
    let (words, bits) = (shift / 64, shift % 64);
    for index in 0..row.len() {
        let low = row.get(index + words).copied().unwrap_or(0);
        let high = row.get(index + words + 1).copied().unwrap_or(0);
        let shifted = if bits == 0 {
            low
        } else {
            (low >> bits) | (high << (64 - bits))
        };
        row[index] |= shifted;
    }
}

fn or_shifted_toward_higher(row: &mut [u64], shift: usize) {
    let (words, bits) = (shift / 64, shift % 64);
    for index in (0..row.len()).rev() {
        let high = index.checked_sub(words).map_or(0, |source| row[source]);
        let low = index.checked_sub(words + 1).map_or(0, |source| row[source]);
        let shifted = if bits == 0 {
            high
        } else {
            (high << bits) | (low >> (64 - bits))
        };
        row[index] |= shifted;
    }
}

fn integer_square_root(value: u32) -> u32 {
    let mut root = f64::from(value).sqrt() as u32;
    while u64::from(root) * u64::from(root) > u64::from(value) {
        root -= 1;
    }
    while u64::from(root + 1) * u64::from(root + 1) <= u64::from(value) {
        root += 1;
    }
    root
}

const MAXIMUM_CIRCULAR_MASK_EXTENT: u16 = 46_340;

#[derive(Clone)]
enum ClassComponent {
    Unfiltered,
    Nothing,
    Windows {
        mode: ExactObjectClassFilterMode,
        masks: Vec<Rc<TileBits>>,
    },
}

impl ClassComponent {
    fn allows(&self, x: usize, y: usize) -> bool {
        match self {
            Self::Unfiltered => true,
            Self::Nothing => false,
            Self::Windows { mode, masks } => {
                let found = masks.iter().any(|mask| mask.get_xy(x, y));
                match mode {
                    ExactObjectClassFilterMode::Require => found,
                    ExactObjectClassFilterMode::Exclude => !found,
                }
            }
        }
    }

    fn restrict(&self, accepted: &mut TileBits, minimum_y: usize, maximum_y: usize) {
        match self {
            Self::Unfiltered => {}
            Self::Nothing => accepted.clear_rows(minimum_y, maximum_y),
            Self::Windows {
                mode: ExactObjectClassFilterMode::Exclude,
                masks,
            } => {
                for mask in masks {
                    accepted.and_not_rows(mask, minimum_y, maximum_y);
                }
            }
            Self::Windows {
                mode: ExactObjectClassFilterMode::Require,
                masks,
            } => {
                let mut found = TileBits::new(accepted.width, accepted.height);
                for mask in masks {
                    found.or_rows(mask, minimum_y, maximum_y);
                }
                accepted.and_rows(&found, minimum_y, maximum_y);
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct ClassInputs<'a> {
    pub(super) placed_object_classes: &'a PlacedObjectClassGrid,
    pub(super) appearance_objects: &'a TerrainAppearanceObjects,
    pub(super) terrain: &'a [TerrainId],
    pub(super) terrain_writes: u64,
    pub(super) content: CompatibleContentView<'a>,
    pub(super) roster: &'a super::super::exact_world::ObjectRoster,
}

impl ClassInputs<'_> {
    fn component(
        &self,
        filter: Option<&ExactObjectClassFilter>,
        definition: Option<&ObjectDefinition>,
    ) -> Option<ClassComponent> {
        let Some(filter) = filter else {
            return Some(ClassComponent::Unfiltered);
        };
        if self.roster.has_destroyed() && self.roster.dimensions().is_none() {
            return None;
        }
        let Some(definition) = definition else {
            return Some(ClassComponent::Nothing);
        };
        let mut masks = Vec::with_capacity(filter.constraints.len());
        for constraint in &filter.constraints {
            let extents = object_class_filter_extents(definition, constraint.radius);
            masks.push(self.placed_object_classes.class_window_mask(
                constraint.class_id,
                extents,
                self,
            )?);
        }
        if masks.is_empty() && filter.mode == ExactObjectClassFilterMode::Require {
            return Some(ClassComponent::Nothing);
        }
        Some(ClassComponent::Windows {
            mode: filter.mode,
            masks,
        })
    }
}

pub(super) struct RequestMask<'a> {
    window: CandidateWindow,
    width: usize,
    base: TileBits,
    accepted: Option<TileBits>,
    blocked: Option<Rc<TileBits>>,
    drawn: std::cell::RefCell<Vec<(usize, ClassComponent)>>,
    descriptor: &'a ExactObjectDescriptor,
    inputs: ClassInputs<'a>,
}

impl<'a> RequestMask<'a> {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn build(
        descriptor: &'a ExactObjectDescriptor,
        player: Option<(u8, MapCoordinate)>,
        dimensions: MapDimensions,
        actor_areas: ActorAreas<'_>,
        candidate_availability: &CandidateAvailability,
        master: &ClassFilterMaster<'_>,
        inputs: ClassInputs<'a>,
    ) -> Option<Self> {
        if placement_oracle::mode() == PlacementCheckMode::Reference
            || descriptor.minimum_distance_to_map_edge >= dimensions.width
            || descriptor.minimum_distance_to_map_edge >= dimensions.height
            || descriptor.actor_area_to_place_in.is_some()
            || !candidate_availability.bits.has_shape(dimensions)
        {
            return None;
        }
        let window = CandidateWindow::for_descriptor(descriptor, player, dimensions);
        let width = usize::from(dimensions.width);
        let (minimum_y, maximum_y) = (usize::from(window.minimum_y), usize::from(window.maximum_y));
        let mut base = TileBits::for_dimensions(dimensions);
        let circle = if descriptor.circular_placement && player.is_some() {
            descriptor.maximum_distance_to_players
        } else {
            None
        };
        if circle.is_some()
            && (dimensions.width > MAXIMUM_CIRCULAR_MASK_EXTENT
                || dimensions.height > MAXIMUM_CIRCULAR_MASK_EXTENT)
        {
            return None;
        }
        let center = object_placement_center(player, dimensions);
        for y in window.minimum_y..=window.maximum_y {
            let (mut minimum_x, mut maximum_x) = (window.minimum_x, window.maximum_x);
            if let Some(radius) = circle {
                let dy = u32::from(y.abs_diff(center.y));
                let limit = u32::from(radius) * u32::from(radius);
                if dy * dy > limit {
                    continue;
                }
                let reach = integer_square_root(limit - dy * dy);
                let reach = u16::try_from(reach).unwrap_or(u16::MAX);
                minimum_x = minimum_x.max(center.x.saturating_sub(reach));
                maximum_x = maximum_x.min(center.x.saturating_add(reach));
            }
            if minimum_x <= maximum_x {
                base.fill_span(
                    usize::from(y),
                    usize::from(minimum_x),
                    usize::from(maximum_x),
                );
            }
        }
        base.and_rows(&candidate_availability.bits, minimum_y, maximum_y);
        let blocked =
            if descriptor.avoid_actor_areas.is_empty() && !descriptor.avoid_all_actor_areas {
                None
            } else {
                Some(actor_areas.blocked_mask(
                    &descriptor.avoid_actor_areas,
                    descriptor.avoid_all_actor_areas,
                    dimensions,
                ))
            };
        let filter = descriptor.object_class_filter.as_ref();
        let accepted = match (filter, master.fixed) {
            (None, _) => Some(ClassComponent::Unfiltered),
            (Some(_), Some(fixed)) => Some(inputs.component(filter, fixed)?),
            (Some(_), None) => {
                if inputs.roster.has_destroyed() && inputs.roster.dimensions().is_none() {
                    return None;
                }
                None
            }
        }
        .map(|component| {
            let mut accepted = base.clone();
            component.restrict(&mut accepted, minimum_y, maximum_y);
            if let Some(blocked) = &blocked {
                accepted.and_not_rows(blocked, minimum_y, maximum_y);
            }
            accepted
        });
        Some(Self {
            window,
            width,
            base,
            accepted,
            blocked,
            drawn: std::cell::RefCell::new(Vec::new()),
            descriptor,
            inputs,
        })
    }

    fn drawn_accepts(
        &self,
        x: usize,
        y: usize,
        definition: Option<&ObjectDefinition>,
    ) -> Result<bool, MaskUnavailable> {
        let key = definition.map_or(0, |definition| std::ptr::from_ref(definition) as usize);
        let known = self
            .drawn
            .borrow()
            .iter()
            .find(|(known, _)| *known == key)
            .map(|(_, component)| component.allows(x, y));
        let allowed = match known {
            Some(allowed) => allowed,
            None => {
                let component = self
                    .inputs
                    .component(self.descriptor.object_class_filter.as_ref(), definition)
                    .ok_or(MaskUnavailable)?;
                let allowed = component.allows(x, y);
                self.drawn.borrow_mut().push((key, component));
                allowed
            }
        };
        Ok(allowed
            && !self
                .blocked
                .as_ref()
                .is_some_and(|blocked| blocked.get_xy(x, y)))
    }

    #[allow(clippy::too_many_arguments)]
    fn collect(
        &self,
        master: &ClassFilterMaster<'a>,
        object_groups: &[ExactObjectGroup],
        setup: &ExactSetupState,
        content: CompatibleContentView<'a>,
        runtime_attributes: &'a ObjectRuntimeAttributes,
        rng: &mut RmsRandom,
    ) -> Result<Result<Vec<usize>, GenerationError>, MaskUnavailable> {
        let mut candidates = Vec::new();
        if let Some(accepted) = &self.accepted {
            accepted.push_ones(self.window, &mut candidates);
            return Ok(Ok(candidates));
        }
        let mut eligible = Vec::new();
        self.base.push_ones(self.window, &mut eligible);
        candidates.reserve(eligible.len());
        for index in eligible {
            let definition = match master.resolve(
                self.descriptor,
                object_groups,
                setup,
                content,
                runtime_attributes,
                rng,
            ) {
                Ok(definition) => definition,
                Err(error) => return Ok(Err(error)),
            };
            if self.drawn_accepts(index % self.width, index / self.width, definition)? {
                candidates.push(index);
            }
        }
        Ok(Ok(candidates))
    }

    #[allow(clippy::too_many_arguments)]
    fn sample(
        &self,
        coordinate: MapCoordinate,
        master: &ClassFilterMaster<'a>,
        object_groups: &[ExactObjectGroup],
        setup: &ExactSetupState,
        content: CompatibleContentView<'a>,
        runtime_attributes: &'a ObjectRuntimeAttributes,
        rng: &mut RmsRandom,
    ) -> Result<Result<bool, GenerationError>, MaskUnavailable> {
        let (x, y) = (usize::from(coordinate.x), usize::from(coordinate.y));
        if let Some(accepted) = &self.accepted {
            return Ok(Ok(accepted.get_xy(x, y)));
        }
        if !self.base.get_xy(x, y) {
            return Ok(Ok(false));
        }
        let definition = match master.resolve(
            self.descriptor,
            object_groups,
            setup,
            content,
            runtime_attributes,
            rng,
        ) {
            Ok(definition) => definition,
            Err(error) => return Ok(Err(error)),
        };
        self.drawn_accepts(x, y, definition).map(Ok)
    }
}

#[derive(Debug)]
struct MaskUnavailable;

#[derive(PartialEq)]
struct QueueBuild {
    candidates: Result<Vec<usize>, String>,
    rng: RmsRngState,
}

impl std::fmt::Debug for QueueBuild {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.candidates {
            Ok(candidates) => write!(
                formatter,
                "{} candidates (first {:?}, last {:?}), {} draws",
                candidates.len(),
                candidates.first(),
                candidates.last(),
                self.rng.draws()
            ),
            Err(error) => write!(formatter, "error {error}, {} draws", self.rng.draws()),
        }
    }
}

fn first_difference(left: &QueueBuild, right: &QueueBuild) -> String {
    match (&left.candidates, &right.candidates) {
        (Ok(left), Ok(right)) => left
            .iter()
            .zip(right)
            .position(|(left, right)| left != right)
            .map_or_else(
                || format!("lengths {} and {}", left.len(), right.len()),
                |at| format!("first difference at {at}: {} and {}", left[at], right[at]),
            ),
        _ => "an error on one route".to_owned(),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn collect_with_masks<'a>(
    masks: Option<&RequestMask<'a>>,
    master: &ClassFilterMaster<'a>,
    object_groups: &[ExactObjectGroup],
    setup: &ExactSetupState,
    content: CompatibleContentView<'a>,
    runtime_attributes: &'a ObjectRuntimeAttributes,
    rng: &mut RmsRandom,
    reference: impl FnOnce(&mut RmsRandom) -> Result<Vec<usize>, GenerationError>,
) -> Result<Vec<usize>, GenerationError> {
    let Some(masks) = masks else {
        return reference(rng);
    };
    let accelerated = |rng: &mut RmsRandom| {
        masks.collect(
            master,
            object_groups,
            setup,
            content,
            runtime_attributes,
            rng,
        )
    };
    match placement_oracle::mode() {
        PlacementCheckMode::Reference => reference(rng),
        PlacementCheckMode::Accelerated => {
            if masks.accepted.is_some() {
                return accelerated(rng).unwrap_or_else(|_| unreachable!("fixed masks"));
            }
            let mut attempt = rng.clone();
            match accelerated(&mut attempt) {
                Ok(result) => {
                    *rng = attempt;
                    result
                }
                Err(MaskUnavailable) => reference(rng),
            }
        }
        PlacementCheckMode::Differential => {
            let mut attempt = rng.clone();
            let accelerated = accelerated(&mut attempt);
            let result = reference(rng);
            if let Ok(accelerated) = accelerated {
                let reference_build = QueueBuild {
                    candidates: result
                        .as_ref()
                        .map_err(|error| format!("{error:?}"))
                        .cloned(),
                    rng: rng.state(),
                };
                let accelerated_build = QueueBuild {
                    candidates: accelerated.map_err(|error| format!("{error:?}")),
                    rng: attempt.state(),
                };
                placement_oracle::compare(
                    OracleCheck::CandidateMaskQueue,
                    &reference_build,
                    &accelerated_build,
                    || {
                        format!(
                            "queue build of operation {}: {}",
                            masks.descriptor.operation_index,
                            first_difference(&reference_build, &accelerated_build)
                        )
                    },
                );
            }
            result
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sample_with_masks<'a>(
    masks: Option<&RequestMask<'a>>,
    coordinate: MapCoordinate,
    master: &ClassFilterMaster<'a>,
    object_groups: &[ExactObjectGroup],
    setup: &ExactSetupState,
    content: CompatibleContentView<'a>,
    runtime_attributes: &'a ObjectRuntimeAttributes,
    rng: &mut RmsRandom,
    reference: impl FnOnce(&mut RmsRandom) -> Result<bool, GenerationError>,
) -> Result<bool, GenerationError> {
    let Some(masks) = masks else {
        return reference(rng);
    };
    let accelerated = |rng: &mut RmsRandom| {
        masks.sample(
            coordinate,
            master,
            object_groups,
            setup,
            content,
            runtime_attributes,
            rng,
        )
    };
    match placement_oracle::mode() {
        PlacementCheckMode::Reference => reference(rng),
        PlacementCheckMode::Accelerated => {
            if masks.accepted.is_some() {
                return accelerated(rng).unwrap_or_else(|_| unreachable!("fixed masks"));
            }
            let mut attempt = rng.clone();
            match accelerated(&mut attempt) {
                Ok(result) => {
                    *rng = attempt;
                    result
                }
                Err(MaskUnavailable) => reference(rng),
            }
        }
        PlacementCheckMode::Differential => {
            let mut attempt = rng.clone();
            let accelerated = accelerated(&mut attempt);
            let result = reference(rng);
            if let Ok(accelerated) = accelerated {
                let describe = |answer: &Result<bool, GenerationError>, rng: &RmsRandom| {
                    (
                        answer
                            .as_ref()
                            .map_err(|error| format!("{error:?}"))
                            .cloned(),
                        rng.state(),
                    )
                };
                placement_oracle::compare(
                    OracleCheck::CandidateMaskSample,
                    &describe(&result, rng),
                    &describe(&accelerated, &attempt),
                    || {
                        format!(
                            "shuffle sample {coordinate:?} of operation {}",
                            masks.descriptor.operation_index
                        )
                    },
                );
            }
            result
        }
    }
}
