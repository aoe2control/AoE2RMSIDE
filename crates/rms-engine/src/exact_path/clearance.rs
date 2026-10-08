use super::{FRONTIER, Hierarchy, ISOLATED, Rectangle};

pub(crate) const GOAL: u8 = 0x10;

#[derive(Clone, Copy, Debug)]
struct Region {
    goal: [f32; 2],
    clearance: f32,
    auxiliary_radius: f32,
    bounds: Rectangle,
}

impl Region {
    fn new(
        map: &Hierarchy,
        goal: [f32; 2],
        clearance: f32,
        auxiliary_radius: f32,
    ) -> Result<Self, &'static str> {
        if !goal[0].is_finite()
            || !goal[1].is_finite()
            || !clearance.is_finite()
            || !auxiliary_radius.is_finite()
            || goal[0] < 0.0
            || goal[1] < 0.0
            || goal[0] >= f32::from(map.width)
            || goal[1] >= f32::from(map.height)
        {
            return Err("path goal outside the finite map domain");
        }
        let mut extent = clearance + auxiliary_radius;
        if auxiliary_radius < 1.0 {
            extent += 1.0;
        }
        let lower = [goal[0] - extent, goal[1] - extent];
        let upper = [(extent + goal[0]) + 0.1, (extent + goal[1]) + 0.1];
        let narrow = |value: f32| {
            if value.is_finite() && (-2_147_483_648.0..2_147_483_648.0).contains(&value) {
                Ok((value as i32) as i16)
            } else {
                Err("path clearance bounds exceed signed conversion domain")
            }
        };
        Ok(Self {
            goal,
            clearance,
            auxiliary_radius,
            bounds: Rectangle {
                left: narrow(lower[0])?.max(0),
                top: narrow(lower[1])?.max(0),
                right: narrow(upper[0])?.min(map.width as i16 - 1),
                bottom: narrow(upper[1])?.min(map.height as i16 - 1),
            },
        })
    }

    fn includes(&self, level: usize, x: u16, y: u16) -> bool {
        self.bounds.left >> level <= x as i16
            && self.bounds.right >> level >= x as i16
            && self.bounds.top >> level <= y as i16
            && self.bounds.bottom >> level >= y as i16
    }

    fn intersects(&self, map: &Hierarchy, level: usize, x: u16, y: u16) -> bool {
        if !self.includes(level, x, y) {
            return false;
        }
        let radius = self.auxiliary_radius + 0.5;
        for tx in (x << level)..((x + 1) << level) {
            for ty in (y << level)..((y + 1) << level) {
                let tile = map.cell(0, tx, ty);
                if tile.connections == 0 && tile.flags & ISOLATED == 0 {
                    continue;
                }
                let dx = axis_distance(tx, self.goal[0], self.clearance, radius);
                if dx > radius {
                    continue;
                }
                let dy = axis_distance(ty, self.goal[1], self.clearance, radius);
                if dy <= radius && radius * radius >= (dy * dy) + (dx * dx) {
                    return true;
                }
            }
        }
        false
    }
}

fn axis_distance(tile: u16, goal: f32, clearance: f32, radius: f32) -> f32 {
    let distance = (f32::from(tile) - (goal + -0.5)).abs();
    let mut remaining = if distance <= clearance {
        0.0
    } else {
        distance - clearance
    };
    if remaining == clearance {
        remaining = (remaining - radius).max(0.0);
    }
    remaining
}

impl Hierarchy {
    pub(crate) fn mark_clearance(
        &mut self,
        goal: [f32; 2],
        clearance: f32,
        auxiliary_radius: f32,
        mark: bool,
    ) -> Result<bool, &'static str> {
        let region = Region::new(self, goal, clearance, auxiliary_radius)?;
        let mut changed = 0;
        for x in (region.bounds.left >> 3)..=(region.bounds.right >> 3) {
            for y in (region.bounds.top >> 3)..=(region.bounds.bottom >> 3) {
                changed += self.mark_region_cell(&region, 3, x as u16, y as u16, mark);
            }
        }
        if changed != 0 {
            return Ok(true);
        }
        let x = goal[0] as u16;
        let y = goal[1] as u16;
        for level in (0..4).rev() {
            let index = self.index(level, x >> level, y >> level);
            let cell = &mut self.cells[index];
            if cell.flags & FRONTIER != 0 {
                let previous = cell.flags & GOAL != 0;
                if mark && !previous {
                    cell.flags += GOAL;
                    return Ok(true);
                }
                if !mark && previous {
                    cell.flags -= GOAL;
                }
                return Ok(false);
            }
        }
        Ok(false)
    }

    fn mark_region_cell(
        &mut self,
        region: &Region,
        level: usize,
        x: u16,
        y: u16,
        mark: bool,
    ) -> u32 {
        if !region.includes(level, x, y) {
            return 0;
        }
        let index = self.index(level, x, y);
        if self.cells[index].flags & FRONTIER != 0 {
            if region.intersects(self, level, x, y) {
                let previous = self.cells[index].flags & GOAL != 0;
                if mark && !previous {
                    self.cells[index].flags += GOAL;
                    return 1;
                }
                if !mark && previous {
                    self.cells[index].flags -= GOAL;
                    return 1;
                }
            }
            return 0;
        }
        if level == 0 {
            return 0;
        }
        let mut changed = 0;
        for [dx, dy] in [[0, 0], [1, 0], [0, 1], [1, 1]] {
            changed += self.mark_region_cell(region, level - 1, x * 2 + dx, y * 2 + dy, mark);
        }
        changed
    }
}
