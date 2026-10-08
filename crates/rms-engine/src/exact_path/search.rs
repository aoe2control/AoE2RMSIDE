#[path = "hierarchy.rs"]
pub(crate) mod hierarchy;
#[path = "portal.rs"]
mod portal;
#[path = "queue.rs"]
mod queue;

use hierarchy::{DOWN, FRONTIER, Hierarchy, ISOLATED, LEFT, RIGHT, SPLIT, UP, clearance::GOAL};
use queue::Queue;

const QUEUED: u8 = 0x10;
const VISITED: u8 = 0x20;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Node {
    level: u8,
    cell: [i16; 2],
    point: [i16; 2],
    cost: f32,
    priority: f32,
    parent: Option<usize>,
    direction: u8,
    shortcut: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Exit {
    Goal,
    Exhausted,
    NearGoalLimit,
    BlockedStart,
}

#[derive(Debug, PartialEq)]
pub(crate) struct SearchResult {
    pub(crate) status: u8,
    pub(crate) length: f32,
}

#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub(crate) nodes: usize,
    pub(crate) buckets: usize,
}

struct Search<'a> {
    map: &'a mut Hierarchy,
    nodes: Vec<Node>,
    queue: Queue,
    goal: [i16; 2],
    closest: Option<usize>,
    closest_distance: f32,
    popped: u32,
    node_limit: usize,
}

pub(crate) fn search(
    map: &mut Hierarchy,
    start: [f32; 2],
    goal: [f32; 2],
    clearance: f32,
    auxiliary_radius: f32,
    limits: Limits,
    no_route: u8,
) -> Result<SearchResult, &'static str> {
    if start.iter().any(|value| !value.is_finite() || *value < 0.0)
        || start[0] >= f32::from(map.width)
        || start[1] >= f32::from(map.height)
        || limits.nodes > u32::MAX as usize
    {
        return Err("path start or node bound outside supported domain");
    }
    let goal_marker = map.mark_clearance(goal, clearance, auxiliary_radius, true)?;
    let mut state = Search {
        map,
        nodes: Vec::new(),
        queue: Queue::new(limits.buckets, limits.nodes),
        goal: [goal[0] as i16, goal[1] as i16],
        closest: None,
        closest_distance: 999_999.0,
        popped: 0,
        node_limit: limits.nodes,
    };
    let outcome = state
        .run([start[0] as i16, start[1] as i16])
        .and_then(|(terminal, exit)| {
            let status = if terminal.is_none() {
                no_route
            } else if exit == Exit::Goal && goal_marker {
                1
            } else {
                2
            };
            let path = state.reconstruct(terminal, status, start, goal, clearance)?;
            Ok((terminal, exit, status, path))
        });
    let unmark = state
        .map
        .mark_clearance(goal, clearance, auxiliary_radius, false);
    for node in &state.nodes {
        let index = state.map.index(
            node.level as usize,
            node.cell[0] as u16,
            node.cell[1] as u16,
        );
        state.map.cells[index].connections &= 15;
    }
    unmark?;
    let (_terminal, _exit, status, path) = outcome?;
    let length = path_length(&path);
    Ok(SearchResult { status, length })
}

impl Search<'_> {
    fn reconstruct(
        &self,
        terminal: Option<usize>,
        status: u8,
        start: [f32; 2],
        goal: [f32; 2],
        clearance: f32,
    ) -> Result<Vec<[f32; 3]>, &'static str> {
        let Some(terminal) = terminal else {
            return Ok(Vec::new());
        };
        let node = self.nodes[terminal];
        let goal_tile = [goal[0] as i16, goal[1] as i16];
        let start_tile = [start[0] as i16, start[1] as i16];
        let terminal_point = if status == 1
            && self
                .map
                .cell(0, goal_tile[0] as u16, goal_tile[1] as u16)
                .connections
                != 0
        {
            [goal[0], 0.0, goal[1]]
        } else {
            let representative = self.map.representative_base(
                node.level as usize,
                node.cell[0] as u16,
                node.cell[1] as u16,
                goal_tile[0],
                goal_tile[1],
            )?;
            let tile = [representative[0] as i16, representative[1] as i16];
            if status == 1 && clearance + 0.01 >= coordinate_distance(goal_tile, tile) {
                [goal[0], 0.0, goal[1]]
            } else {
                tile_center(tile)
            }
        };
        let mut points = vec![terminal_point];
        let mut last = goal_tile;
        let mut current = Some(terminal);
        while let Some(index) = current {
            let towards = match self.nodes[index]
                .parent
                .and_then(|parent| self.nodes[parent].parent)
            {
                Some(grandparent) => self.resolve_portal(grandparent)?.unwrap_or(start_tile),
                None => start_tile,
            };
            if let Some(point) = self.project_portal(index, towards, last)? {
                points.push(tile_center(point));
                last = point;
            }
            current = self.nodes[index].parent;
        }
        points.push([start[0], 0.0, start[1]]);
        points.reverse();
        points.dedup();
        Ok(points)
    }

    fn allocate(&mut self, node: Node, enqueue: bool) -> Result<usize, &'static str> {
        if self.nodes.len() >= self.node_limit {
            return Err("path node work bound exceeded");
        }
        let index = self.nodes.len();
        if enqueue {
            self.queue.push(index as u32, node.priority, 0.0)?;
        }
        self.nodes.push(node);
        Ok(index)
    }

    fn run(&mut self, start: [i16; 2]) -> Result<(Option<usize>, Exit), &'static str> {
        let mut level = 3;
        while level > 0
            && self
                .map
                .cell(
                    level,
                    (start[0] >> level) as u16,
                    (start[1] >> level) as u16,
                )
                .flags
                & FRONTIER
                == 0
        {
            level -= 1;
        }
        let cell = [start[0] >> level, start[1] >> level];
        let index = self.map.index(level, cell[0] as u16, cell[1] as u16);
        let initial = self.map.cells[index];
        if initial.connections == 0 && initial.flags & ISOLATED == 0 {
            return Ok((None, Exit::BlockedStart));
        }
        let dx = f32::from(self.goal[0]) - f32::from(start[0]);
        let dy = f32::from(self.goal[1]) - f32::from(start[1]);
        let initial_distance = ((dy * dy) + (dx * dx)).sqrt();
        let root = self.allocate(
            Node {
                level: level as u8,
                cell,
                point: start,
                cost: 0.0,
                priority: initial_distance,
                parent: None,
                direction: 0,
                shortcut: false,
            },
            initial.flags & GOAL == 0,
        )?;
        if initial.flags & GOAL != 0 {
            return Ok((Some(root), Exit::Goal));
        }
        self.map.cells[index].connections = initial.connections.wrapping_add(QUEUED);
        while let Some(entry) = self.queue.pop() {
            self.popped += 1;
            let current = entry.node as usize;
            let node = self.nodes[current];
            let index = self.map.index(
                node.level as usize,
                node.cell[0] as u16,
                node.cell[1] as u16,
            );
            let connections = self.map.cells[index].connections;
            if connections & VISITED != 0 {
                continue;
            }
            self.map.cells[index].connections = connections.wrapping_add(VISITED);
            let residual = node.priority - node.cost;
            if self.closest_distance > residual {
                self.closest_distance = residual;
                self.closest = Some(current);
            }
            if near_goal_budget_exhausted(initial_distance, residual, self.popped) {
                self.closest = Some(current);
                return Ok((self.closest, Exit::NearGoalLimit));
            }
            for (direction, dx, dy, reciprocal) in [
                (LEFT, -1, 0, RIGHT),
                (RIGHT, 1, 0, LEFT),
                (UP, 0, -1, DOWN),
                (DOWN, 0, 1, UP),
            ] {
                if connections & direction == 0 {
                    continue;
                }
                if let Some(goal) = self.neighbor(
                    node.level,
                    [node.cell[0].wrapping_add(dx), node.cell[1].wrapping_add(dy)],
                    current,
                    reciprocal,
                )? {
                    return Ok((Some(goal), Exit::Goal));
                }
            }
        }
        Ok((self.closest, Exit::Exhausted))
    }

    fn neighbor(
        &mut self,
        level: u8,
        cell: [i16; 2],
        parent: usize,
        reciprocal: u8,
    ) -> Result<Option<usize>, &'static str> {
        let l = level as usize;
        if l >= 4
            || cell[0] < 0
            || cell[1] < 0
            || cell[0] as u16 >= self.map.widths[l]
            || cell[1] as u16 >= self.map.heights[l]
        {
            return Err("path connection points outside its hierarchy");
        }
        let index = self.map.index(l, cell[0] as u16, cell[1] as u16);
        let target = self.map.cells[index];
        if target.connections & reciprocal == 0 {
            return Ok(None);
        }
        if target.flags & FRONTIER != 0 {
            if target.connections & VISITED != 0 {
                return Ok(None);
            }
            let point = if level == 0 {
                cell
            } else {
                let half = 1i16 << (level - 1);
                [
                    cell[0].wrapping_shl(u32::from(level)).wrapping_add(half),
                    cell[1].wrapping_shl(u32::from(level)).wrapping_add(half),
                ]
            };
            let previous = self.nodes[parent];
            let shortcut = previous.parent.is_some()
                && !previous.shortcut
                && orthogonal(reciprocal, previous.direction);
            let predecessor = if shortcut {
                self.nodes[previous.parent.unwrap()]
            } else {
                previous
            };
            let cost = integer_distance(predecessor.point, point) + predecessor.cost;
            let priority = cost + integer_distance(self.goal, point);
            let node = self.allocate(
                Node {
                    level,
                    cell,
                    point,
                    cost,
                    priority,
                    parent: Some(parent),
                    direction: reciprocal,
                    shortcut,
                },
                true,
            )?;
            if target.connections & QUEUED == 0 {
                self.map.cells[index].connections = target.connections.wrapping_add(QUEUED);
            }
            return Ok(if target.flags & GOAL != 0 {
                Some(node)
            } else {
                None
            });
        }
        if target.flags & SPLIT == 0 {
            return self.neighbor(level + 1, [cell[0] >> 1, cell[1] >> 1], parent, reciprocal);
        }
        if level == 0 {
            return Err("base path cell cannot split");
        }
        for (dx, dy, edge_mask) in [
            (0, 0, LEFT | UP),
            (1, 0, RIGHT | UP),
            (0, 1, LEFT | DOWN),
            (1, 1, RIGHT | DOWN),
        ] {
            if reciprocal & edge_mask == 0 {
                continue;
            }
            if let Some(goal) = self.neighbor(
                level - 1,
                [
                    cell[0].wrapping_mul(2).wrapping_add(dx),
                    cell[1].wrapping_mul(2).wrapping_add(dy),
                ],
                parent,
                reciprocal,
            )? {
                return Ok(Some(goal));
            }
        }
        Ok(None)
    }
}

fn orthogonal(a: u8, b: u8) -> bool {
    (matches!(a, LEFT | RIGHT) && matches!(b, UP | DOWN))
        || (matches!(a, UP | DOWN) && matches!(b, LEFT | RIGHT))
}

fn near_goal_budget_exhausted(initial_distance: f32, residual: f32, popped: u32) -> bool {
    residual <= 5.0 && initial_distance <= 10.0 && popped >= 10 * initial_distance as u32
}

fn integer_distance(a: [i16; 2], b: [i16; 2]) -> f32 {
    let dx = i32::from(a[0]) - i32::from(b[0]);
    let dy = i32::from(a[1]) - i32::from(b[1]);
    let squared = dy.wrapping_mul(dy).wrapping_add(dx.wrapping_mul(dx));
    (squared as f32).sqrt()
}

fn coordinate_distance(a: [i16; 2], b: [i16; 2]) -> f32 {
    let dx = f32::from(a[0]) - f32::from(b[0]);
    let dy = f32::from(a[1]) - f32::from(b[1]);
    ((dy * dy) + (dx * dx)).sqrt()
}

fn tile_center(point: [i16; 2]) -> [f32; 3] {
    [f32::from(point[0]) + 0.5, 0.0, f32::from(point[1]) + 0.5]
}

fn path_length(points: &[[f32; 3]]) -> f32 {
    let mut length = 0.0f32;
    for pair in points.windows(2) {
        let dx = pair[1][0] - pair[0][0];
        let dy = pair[1][1] - pair[0][1];
        let dz = pair[1][2] - pair[0][2];
        length += (((dy * dy) + (dx * dx)) + (dz * dz)).sqrt();
    }
    length
}
