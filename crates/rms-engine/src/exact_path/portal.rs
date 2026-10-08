use super::{DOWN, Hierarchy, LEFT, Node, RIGHT, Search, UP};

struct Portal {
    moving_axis: usize,
    low: i16,
    high: i16,
    fixed: i16,
    level: u8,
    direction: u8,
}

impl Portal {
    fn new(node: Node, parent: Node) -> Result<Self, &'static str> {
        if node.level > 3 || parent.level > 3 {
            return Err("portal level outside hierarchy");
        }
        let finer = if node.level <= parent.level {
            node
        } else {
            parent
        };
        let moving_axis = match node.direction {
            UP | DOWN => 0,
            LEFT | RIGHT => 1,
            _ => return Err("portal has no cardinal direction"),
        };
        let low = finer.cell[moving_axis].wrapping_shl(u32::from(finer.level));
        let high = low.wrapping_add((1i16 << finer.level) - 1);
        let fixed = node.cell[1 - moving_axis].wrapping_shl(u32::from(node.level));
        let fixed = if matches!(node.direction, DOWN | RIGHT) {
            fixed.wrapping_add((1i16 << node.level) - 1)
        } else {
            fixed
        };
        Ok(Self {
            moving_axis,
            low,
            high,
            fixed,
            level: finer.level,
            direction: node.direction,
        })
    }

    fn point(&self, moving: i16) -> [i16; 2] {
        if self.moving_axis == 0 {
            [moving, self.fixed]
        } else {
            [self.fixed, moving]
        }
    }

    fn connects(&self, map: &Hierarchy, moving: i16) -> Result<bool, &'static str> {
        let [x, y] = self.point(moving);
        if x < 0 || y < 0 || x as u16 >= map.widths[0] || y as u16 >= map.heights[0] {
            return Err("portal scan outside allocated base grid");
        }
        Ok(map.cell(0, x as u16, y as u16).connections & self.direction != 0)
    }

    fn nearest(&self, map: &Hierarchy, target: i16, missing: i16) -> Result<i16, &'static str> {
        let mut result = missing;
        let mut distance = 9999i16;
        for candidate in target..=self.high {
            if self.connects(map, candidate)? {
                result = candidate;
                distance = candidate.wrapping_sub(target);
                break;
            }
        }
        for candidate in (self.low..=target).rev() {
            if distance <= 0 {
                break;
            }
            if self.connects(map, candidate)? {
                result = candidate;
                break;
            }
            distance -= 1;
        }
        Ok(result)
    }
}

impl Search<'_> {
    pub(super) fn resolve_portal(&self, index: usize) -> Result<Option<[i16; 2]>, &'static str> {
        let node = self.nodes[index];
        let Some(parent) = node.parent else {
            return Ok(None);
        };
        let portal = Portal::new(node, self.nodes[parent])?;
        let moving = if portal.level == 0 {
            portal.low
        } else {
            let midpoint = portal.low.wrapping_add(1i16 << (portal.level - 1));
            portal.nearest(self.map, midpoint, midpoint)?
        };
        let mut point = portal.point(moving);
        point[0] = point[0].min(self.map.width as i16 - 1);
        point[1] = point[1].min(self.map.height as i16 - 1);
        Ok(Some(point))
    }

    pub(super) fn project_portal(
        &self,
        index: usize,
        towards: [i16; 2],
        last: [i16; 2],
    ) -> Result<Option<[i16; 2]>, &'static str> {
        let node = self.nodes[index];
        let Some(parent) = node.parent else {
            return Ok(None);
        };
        let mut portal = Portal::new(node, self.nodes[parent])?;
        if portal.moving_axis == 0 {
            portal.high = portal.high.min(self.map.width as i16 - 1);
            if node.direction == DOWN {
                portal.fixed = portal.fixed.min(self.map.height as i16 - 1);
            }
        }
        let along = portal.moving_axis;
        let perpendicular = 1 - along;
        let delta_along = towards[along].wrapping_sub(last[along]);
        let delta_perpendicular = towards[perpendicular].wrapping_sub(last[perpendicular]);
        let reaches_edge = if matches!(node.direction, UP | LEFT) {
            portal.fixed <= last[perpendicular]
        } else {
            portal.fixed >= last[perpendicular]
        };
        let crossing = if reaches_edge {
            portal.fixed.wrapping_sub(last[perpendicular])
        } else {
            0
        };
        let target = if crossing != 0 && delta_perpendicular != 0 {
            (i32::from(last[along] as u16)
                + i32::from(delta_along) * i32::from(crossing) / i32::from(delta_perpendicular))
                as i16
        } else {
            last[along]
        };
        let moving = if target <= portal.low {
            let mut found = -1;
            for candidate in portal.low..=portal.high {
                if portal.connects(self.map, candidate)? {
                    found = candidate;
                    break;
                }
            }
            found
        } else if target >= portal.high {
            let mut found = -1;
            for candidate in (portal.low..=portal.high).rev() {
                if portal.connects(self.map, candidate)? {
                    found = candidate;
                    break;
                }
            }
            found
        } else {
            portal.nearest(self.map, target, -1)?
        };
        Ok(Some(portal.point(moving)))
    }
}
