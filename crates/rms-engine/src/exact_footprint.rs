use super::{GenerationError, MapDimensions, world_error};

#[derive(Clone, Copy, Debug)]
pub(super) struct Region {
    center: [i32; 2],
    bounds: [i32; 4],
}

impl Region {
    pub(super) fn prepare(
        position: [f32; 2],
        radius: [f32; 2],
        dimensions: MapDimensions,
        inserting: bool,
    ) -> Result<Option<Self>, GenerationError> {
        let truncate = |value: f32| {
            if value.is_finite() && (-2147483648.0..2147483648.0).contains(&value) {
                Ok(value as i32)
            } else {
                Err(world_error("footprint coordinate exceeds signed32 domain"))
            }
        };
        if radius
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(world_error("footprint radius is invalid"));
        }
        let center = [truncate(position[0])?, truncate(position[1])?];
        let raw = [
            truncate(position[0] - radius[0])?,
            truncate(position[1] - radius[1])?,
            truncate((position[0] + radius[0]) - 0.01)?,
            truncate((position[1] + radius[1]) - 0.01)?,
        ];
        if raw[0] == raw[2] && raw[1] == raw[3] {
            return Ok(None);
        }
        let bounds = [
            raw[0].min(raw[2]),
            raw[1].min(raw[3]),
            raw[0].max(raw[2]),
            raw[1].max(raw[3]),
        ];
        if inserting
            && (center[0] < bounds[0]
                || center[0] > bounds[2]
                || center[1] < bounds[1]
                || center[1] > bounds[3])
        {
            return Ok(None);
        }
        if bounds[0] >= i32::from(dimensions.width)
            || bounds[1] >= i32::from(dimensions.height)
            || bounds[2] < 0
            || bounds[3] < 0
        {
            return Ok(None);
        }
        Ok(Some(Self {
            center,
            bounds: [
                bounds[0].max(0),
                bounds[1].max(0),
                bounds[2].min(i32::from(dimensions.width) - 1),
                bounds[3].min(i32::from(dimensions.height) - 1),
            ],
        }))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Pattern {
    key: u32,
    offsets: Vec<[i32; 2]>,
}

impl Pattern {
    fn key(region: Region) -> u32 {
        let [x, y] = region.center;
        let [left, top, right, bottom] = region.bounds;
        u32::from_le_bytes([
            (x - left) as u8,
            (y - top) as u8,
            (right - x) as u8,
            (bottom - y) as u8,
        ])
    }

    fn new(region: Region) -> Self {
        let [x, y] = region.center;
        let [left, top, right, bottom] = region.bounds;
        let samples = |span: i32| if span <= 2 { span } else { (span + 1) / 2 };
        let nx = samples(right - left + 1);
        let ny = samples(bottom - top + 1);
        let capacity = if ny == 1 {
            nx
        } else if bottom - top == 1 {
            2 * nx
        } else {
            2 * (nx + ny) - 4
        } + 1;
        let mut offsets = Vec::with_capacity(capacity as usize);
        let mut add = |px, py| {
            let offset = [px - x, py - y];
            if offset != [0, 0] && offsets.len() < capacity as usize && !offsets.contains(&offset) {
                offsets.push(offset);
            }
        };
        add(left, top);
        add(right, top);
        add(left, bottom);
        add(right, bottom);
        for index in 1..nx - 1 {
            add(left + 2 * index, top);
            if ny > 1 {
                add(right - 2 * index, bottom);
            }
        }
        for index in 1..ny - 1 {
            add(left, top + 2 * index);
            if nx > 1 {
                add(right, bottom - 2 * index);
            }
        }
        Self {
            key: Self::key(region),
            offsets,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct Footprints {
    cells: Vec<[u8; 2]>,
    patterns: Vec<Pattern>,
    unavailable: bool,
}

impl Footprints {
    pub(super) fn invalidate(&mut self) {
        *self = Self {
            unavailable: true,
            ..Self::default()
        };
    }

    pub(super) fn insert(&mut self, region: Region, dimensions: MapDimensions) {
        if self.unavailable {
            return;
        }
        if self.cells.is_empty() {
            self.cells.resize(
                usize::from(dimensions.width) * usize::from(dimensions.height),
                [0; 2],
            );
        }
        let [left, top, right, bottom] = region.bounds;
        let [cx, cy] = region.center;
        for y in top..=bottom {
            for x in left..=right {
                let cell = if [x, y] == region.center && left == right && top == bottom {
                    [0x40, 0]
                } else if [x, y] == region.center {
                    let key = Pattern::key(region);
                    let index = self
                        .patterns
                        .iter()
                        .position(|pattern| pattern.key == key)
                        .unwrap_or_else(|| {
                            let index = self.patterns.len();
                            self.patterns.push(Pattern::new(region));
                            index
                        });
                    [0x40, index.wrapping_add(1) as u8]
                } else {
                    let nibble = |offset: i32| (offset.clamp(-8, 7) & 15) as u8;
                    [0x20, nibble(x - cx) | (nibble(y - cy) << 4)]
                };
                self.cells[y as usize * usize::from(dimensions.width) + x as usize] = cell;
            }
        }
    }

    pub(super) fn remove(&mut self, region: Region, dimensions: MapDimensions) {
        if self.unavailable || self.cells.is_empty() {
            return;
        }
        let [left, top, right, bottom] = region.bounds;
        for y in top..=bottom {
            for x in left..=right {
                self.cells[y as usize * usize::from(dimensions.width) + x as usize] = [0; 2];
            }
        }
    }
}
