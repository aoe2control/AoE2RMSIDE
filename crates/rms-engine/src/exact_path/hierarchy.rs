pub(crate) const UP: u8 = 1;
pub(crate) const LEFT: u8 = 2;
pub(crate) const RIGHT: u8 = 4;
pub(crate) const DOWN: u8 = 8;
pub(crate) const FRONTIER: u8 = 0x20;
pub(crate) const SPLIT: u8 = 0x40;
pub(crate) const ISOLATED: u8 = 0x80;

#[path = "clearance.rs"]
pub(crate) mod clearance;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(C)]
pub(crate) struct Cell {
    pub(crate) connections: u8,
    pub(crate) flags: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Hierarchy {
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) widths: [u16; 4],
    pub(crate) heights: [u16; 4],
    offsets: [usize; 4],
    pub(crate) cells: Vec<Cell>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Rectangle {
    pub(crate) left: i16,
    pub(crate) top: i16,
    pub(crate) right: i16,
    pub(crate) bottom: i16,
}

impl Hierarchy {
    pub(crate) fn new(width: u16, height: u16, walkable: &[bool]) -> Result<Self, &'static str> {
        if width == 0 || height == 0 || width > 480 || height > 480 {
            return Err("path dimensions exceed the generation domain");
        }
        if walkable.len() != usize::from(width) * usize::from(height) {
            return Err("path input length differs from dimensions");
        }
        let padded_width = (width + 7) & !7;
        let padded_height = (height + 7) & !7;
        let widths = std::array::from_fn(|level| padded_width >> level);
        let heights = std::array::from_fn(|level| padded_height >> level);
        let mut count = 0;
        let offsets = std::array::from_fn(|level| {
            let offset = count;
            count += usize::from(widths[level]) * usize::from(heights[level]);
            offset
        });
        let mut result = Self {
            width,
            height,
            widths,
            heights,
            offsets,
            cells: vec![Cell::default(); count],
        };
        for x in (0..widths[3]).rev() {
            for y in (0..heights[3]).rev() {
                result.initialize(3, x, y);
            }
        }
        result.refresh(
            walkable,
            Rectangle {
                left: 0,
                top: 0,
                right: width as i16,
                bottom: height as i16,
            },
        )?;
        Ok(result)
    }

    pub(crate) fn index(&self, level: usize, x: u16, y: u16) -> usize {
        self.offsets[level] + usize::from(y) * usize::from(self.widths[level]) + usize::from(x)
    }

    pub(crate) fn cell(&self, level: usize, x: u16, y: u16) -> Cell {
        self.cells[self.index(level, x, y)]
    }

    pub(crate) fn representative_base(
        &self,
        mut level: usize,
        mut x: u16,
        mut y: u16,
        goal_x: i16,
        goal_y: i16,
    ) -> Result<[u16; 2], &'static str> {
        if level >= 4 || x >= self.widths[level] || y >= self.heights[level] {
            return Err("path node outside the allocated hierarchy");
        }
        while level > 0 {
            level -= 1;
            x *= 2;
            y *= 2;
            let goal = [goal_x >> level, goal_y >> level];
            let mut best = 9999i16;
            let mut offset = [0, 0];
            for [dx, dy] in [[0, 0], [0, 1], [1, 0], [1, 1]] {
                let cx = x + dx;
                let cy = y + dy;
                let cell = self.cell(level, cx, cy);
                if cell.flags & 15 == 15 || cell.connections == 0 {
                    continue;
                }
                let distance = goal[0]
                    .wrapping_sub(cx as i16)
                    .max(0)
                    .wrapping_add(goal[1].wrapping_sub(cy as i16).max(0));
                if distance >= 0 && distance < best {
                    best = distance;
                    offset = [dx, dy];
                }
            }
            x += offset[0];
            y += offset[1];
        }
        Ok([x, y])
    }

    fn initialize(&mut self, level: usize, x: u16, y: u16) -> bool {
        let index = self.index(level, x, y);
        let flags = if level == 0 {
            if x >= self.width || y >= self.height {
                15
            } else {
                0
            }
        } else {
            let mut missing = 0;
            for (child, [dx, dy]) in [[0, 0], [1, 0], [0, 1], [1, 1]].into_iter().enumerate() {
                if self.initialize(level - 1, x * 2 + dx, y * 2 + dy) {
                    missing |= 1 << child;
                }
            }
            missing
        };
        self.cells[index] = Cell {
            connections: 0,
            flags,
        };
        flags == 15
    }

    pub(crate) fn refresh(
        &mut self,
        walkable: &[bool],
        changed: Rectangle,
    ) -> Result<(), &'static str> {
        if walkable.len() != usize::from(self.width) * usize::from(self.height) {
            return Err("path input length differs from dimensions");
        }
        let rectangle = Rectangle {
            left: changed.left.min(changed.right).wrapping_sub(1).max(0),
            top: changed.top.min(changed.bottom).wrapping_sub(1).max(0),
            right: changed
                .left
                .max(changed.right)
                .wrapping_add(1)
                .min(self.width as i16 - 1),
            bottom: changed
                .top
                .max(changed.bottom)
                .wrapping_add(1)
                .min(self.height as i16 - 1),
        };
        let mut x = rectangle.left >> 3;
        while x <= rectangle.right >> 3 {
            let mut y = rectangle.top >> 3;
            while y <= rectangle.bottom >> 3 {
                self.refresh_cell(3, x as u16, y as u16, rectangle, walkable);
                y += 1;
            }
            x += 1;
        }
        Ok(())
    }

    fn refresh_cell(
        &mut self,
        level: usize,
        x: u16,
        y: u16,
        changed: Rectangle,
        walkable: &[bool],
    ) -> Cell {
        let index = self.index(level, x, y);
        let previous = self.cells[index];
        if level == 0 {
            let cell = &mut self.cells[index];
            cell.flags &= 15 | ISOLATED;
            if i32::from(x) >= i32::from(changed.left)
                && i32::from(x) <= i32::from(changed.right)
                && i32::from(y) >= i32::from(changed.top)
                && i32::from(y) <= i32::from(changed.bottom)
            {
                cell.connections = 0;
                let tile = usize::from(y) * usize::from(self.width) + usize::from(x);
                if walkable[tile] {
                    cell.connections =
                        cardinal_connections(self.width, self.height, x, y, walkable);
                    if cell.connections == 0 {
                        cell.flags |= ISOLATED | FRONTIER;
                    } else {
                        cell.flags &= !ISOLATED;
                    }
                }
            }
            return *cell;
        }
        let positions = [
            [x * 2, y * 2],
            [x * 2 + 1, y * 2],
            [x * 2, y * 2 + 1],
            [x * 2 + 1, y * 2 + 1],
        ];
        let children = std::array::from_fn(|child| {
            if previous.flags & (1 << child) != 0 {
                Cell::default()
            } else {
                let [cx, cy] = positions[child];
                self.refresh_cell(level - 1, cx, cy, changed, walkable)
            }
        });
        let parent = merge_children(children, previous.flags & 15, level == 3);
        if parent.flags & SPLIT != 0 {
            for (child, [cx, cy]) in positions.into_iter().enumerate() {
                if children[child].flags & (SPLIT | FRONTIER) == 0 {
                    let child_index = self.index(level - 1, cx, cy);
                    self.cells[child_index].flags =
                        self.cells[child_index].flags.wrapping_add(FRONTIER);
                }
            }
        }
        self.cells[index] = parent;
        parent
    }
}

fn cardinal_connections(width: u16, height: u16, x: u16, y: u16, walkable: &[bool]) -> u8 {
    let index = usize::from(y) * usize::from(width) + usize::from(x);
    let mut result = 0;
    if x > 0 && walkable[index - 1] {
        result |= LEFT;
    }
    if x + 1 < width && walkable[index + 1] {
        result |= RIGHT;
    }
    if y > 0 && walkable[index - usize::from(width)] {
        result |= UP;
    }
    if y + 1 < height && walkable[index + usize::from(width)] {
        result |= DOWN;
    }
    result
}

fn merge_children([tl, tr, bl, br]: [Cell; 4], excluded: u8, top_level: bool) -> Cell {
    let connections = ((tr.connections | br.connections) & RIGHT)
        | ((tr.connections | tl.connections) & UP)
        | ((bl.connections | br.connections) & DOWN)
        | ((bl.connections | tl.connections) & LEFT);
    let forced_split = [tl, tr, bl, br]
        .iter()
        .any(|cell| cell.flags & (SPLIT | ISOLATED) != 0);
    let split = if forced_split {
        true
    } else {
        let edges = [
            tl.connections & RIGHT != 0,
            tr.connections & DOWN != 0,
            br.connections & LEFT != 0,
            bl.connections & UP != 0,
        ];
        let mut labels = [
            u8::from(tl.connections != 0),
            u8::from(tr.connections != 0) * 2,
            u8::from(bl.connections != 0) * 3,
            u8::from(br.connections != 0) * 4,
        ];
        if edges[0] {
            labels[1] = labels[0];
        }
        if edges[1] {
            labels[3] = labels[1];
        }
        if edges[2] {
            labels[2] = labels[3];
        }
        if edges[3] {
            labels[0] = labels[2];
        }
        if edges[0] {
            labels[1] = labels[0];
        }
        if edges[1] {
            labels[3] = labels[1];
        }
        let first = labels.iter().copied().find(|label| *label != 0);
        edges.iter().filter(|edge| **edge).count() == 3
            || (connections == 0 && first.is_some())
            || labels
                .iter()
                .any(|label| *label != 0 && Some(*label) != first)
    };
    Cell {
        connections,
        flags: excluded
            | if split {
                SPLIT
            } else if top_level {
                FRONTIER
            } else {
                0
            },
    }
}
