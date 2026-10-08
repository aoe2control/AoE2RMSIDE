use super::{ExactConnectionState, MapConnection, MapCoordinate, MapDimensions};

pub const CONNECTION_ROUTES_FORMAT_MAJOR: u32 = 1;
pub const CONNECTION_ROUTES_FORMAT_MINOR: u32 = 0;
pub const MAXIMUM_CONNECTION_ROUTE_RECORDS: usize = 2_048;
pub const MAXIMUM_CONNECTION_ROUTE_BYTES: usize = 2 * 1024 * 1024;
pub const CONNECTION_ROUTE_SUMMARY_BYTES: usize = 96;
pub const CONNECTION_ROUTE_RECORD_BYTES: usize = 16;
pub const CONNECTION_ROUTE_VERTEX_BYTES: usize = 4;
pub const FAILED_CONNECTION_SEARCH: u32 = u32::MAX;

pub const ROUTE_OMISSION_ATTEMPT_RETENTION: u32 = 1;
pub const ROUTE_OMISSION_PRESENTATION_BUDGET: u32 = 1 << 1;
pub const ROUTE_OMISSION_FRAME_BUDGET: u32 = 1 << 2;
pub const ROUTE_OMISSION_KNOWN: u32 = ROUTE_OMISSION_ATTEMPT_RETENTION
    | ROUTE_OMISSION_PRESENTATION_BUDGET
    | ROUTE_OMISSION_FRAME_BUDGET;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConnectionRouteRecord {
    pub graph_index: u32,
    pub operation_index: u32,
    pub first_vertex: u32,
    pub vertex_count: u32,
}

impl ConnectionRouteRecord {
    pub fn succeeded(&self) -> bool {
        self.graph_index != FAILED_CONNECTION_SEARCH
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConnectionRoutes {
    pub total_attempts: u64,
    pub successful_attempts: u64,
    pub failed_attempts: u64,
    pub retained_attempts: u32,
    pub retained_successful_attempts: u32,
    pub omission_reasons: u32,
    pub records: Vec<ConnectionRouteRecord>,
    pub vertices: Vec<MapCoordinate>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectionRoutesError(pub &'static str);

impl ConnectionRoutes {
    pub fn from_connection_state(state: &ExactConnectionState) -> Option<Self> {
        Self::build(
            &state.paths,
            |descriptor| {
                state
                    .descriptors
                    .get(usize::from(descriptor))
                    .map(|value| value.operation_index)
            },
            (
                state.statistics.path_attempts,
                state.statistics.successful_paths,
                state.statistics.failed_paths,
            ),
            &state.connections,
            &state.connection_operation_indices,
            state.dimensions,
        )
    }

    fn build(
        paths: &[super::ExactConnectionPathAttempt],
        descriptor_operation: impl Fn(u16) -> Option<u32>,
        (total, successful, failed): (u64, u64, u64),
        connections: &[MapConnection],
        connection_operation_indices: &[u32],
        dimensions: MapDimensions,
    ) -> Option<Self> {
        if paths.len() > MAXIMUM_CONNECTION_ROUTE_RECORDS
            || connection_operation_indices.len() != connections.len()
        {
            return None;
        }
        let retained_attempts = u32::try_from(paths.len()).ok()?;
        let retained_successful_attempts =
            u32::try_from(paths.iter().filter(|path| path.success).count()).ok()?;
        let mut presented = 0_usize;
        let mut vertex_total = 0_usize;
        let mut bytes = CONNECTION_ROUTE_SUMMARY_BYTES;
        for path in paths {
            let vertices = if path.success {
                path.tiles.len() + 1
            } else {
                2
            };
            let needed = CONNECTION_ROUTE_RECORD_BYTES + vertices * CONNECTION_ROUTE_VERTEX_BYTES;
            if bytes + needed > MAXIMUM_CONNECTION_ROUTE_BYTES {
                break;
            }
            bytes += needed;
            vertex_total += vertices;
            presented += 1;
        }
        let mut routes = Self {
            total_attempts: total,
            successful_attempts: successful,
            failed_attempts: failed,
            retained_attempts,
            retained_successful_attempts,
            omission_reasons: 0,
            records: Vec::with_capacity(presented),
            vertices: Vec::with_capacity(vertex_total),
        };
        if total > u64::from(retained_attempts) {
            routes.omission_reasons |= ROUTE_OMISSION_ATTEMPT_RETENTION;
        }
        if presented < paths.len() {
            routes.omission_reasons |= ROUTE_OMISSION_PRESENTATION_BUDGET;
        }
        let mut graph_index = 0_u32;
        for path in &paths[..presented] {
            let operation_index = descriptor_operation(path.descriptor_index)?;
            let first_vertex = u32::try_from(routes.vertices.len()).ok()?;
            if path.success {
                let connection = connections.get(graph_index as usize)?;
                if connection.start != path.start
                    || connection.end != path.target_effective
                    || connection_operation_indices[graph_index as usize] != operation_index
                {
                    return None;
                }
                routes.vertices.push(path.start);
                routes
                    .vertices
                    .extend(path.tiles.iter().rev().map(|tile| tile.coordinate));
                routes.records.push(ConnectionRouteRecord {
                    graph_index,
                    operation_index,
                    first_vertex,
                    vertex_count: u32::try_from(path.tiles.len() + 1).ok()?,
                });
                graph_index += 1;
            } else {
                routes.vertices.push(path.start);
                routes.vertices.push(path.target_requested);
                routes.records.push(ConnectionRouteRecord {
                    graph_index: FAILED_CONNECTION_SEARCH,
                    operation_index,
                    first_vertex,
                    vertex_count: 2,
                });
            }
        }
        routes
            .validate(
                dimensions,
                connections,
                connection_operation_indices,
                u32::MAX as usize,
            )
            .ok()?;
        Some(routes)
    }

    pub fn presentation_bytes(&self) -> usize {
        CONNECTION_ROUTE_SUMMARY_BYTES
            + self.records.len() * CONNECTION_ROUTE_RECORD_BYTES
            + self.vertices.len() * CONNECTION_ROUTE_VERTEX_BYTES
    }

    pub fn retained_heap_bytes(&self) -> usize {
        self.records.capacity() * size_of::<ConnectionRouteRecord>()
            + self.vertices.capacity() * size_of::<MapCoordinate>()
    }

    pub fn presented_successful_attempts(&self) -> usize {
        self.records
            .iter()
            .filter(|record| record.succeeded())
            .count()
    }

    pub fn keep_first(&mut self, count: usize, reason: u32) {
        if count >= self.records.len() {
            return;
        }
        let vertex_end = self
            .records
            .get(count)
            .map_or(self.vertices.len(), |record| record.first_vertex as usize);
        self.records.truncate(count);
        self.vertices.truncate(vertex_end);
        self.omission_reasons |= reason;
    }

    pub fn validate(
        &self,
        dimensions: MapDimensions,
        connections: &[MapConnection],
        connection_operation_indices: &[u32],
        operation_count: usize,
    ) -> Result<(), ConnectionRoutesError> {
        let fail = |reason| Err(ConnectionRoutesError(reason));
        let tile_count = dimensions
            .tile_count()
            .map_err(|_| ConnectionRoutesError("map dimensions are invalid"))?;
        if connection_operation_indices.len() != connections.len() {
            return fail("connection provenance does not match the connection graph");
        }
        if self.successful_attempts.checked_add(self.failed_attempts) != Some(self.total_attempts)
            || u64::from(self.retained_attempts) > self.total_attempts
            || self.retained_successful_attempts > self.retained_attempts
            || u64::from(self.retained_successful_attempts) > self.successful_attempts
            || u64::from(self.retained_attempts - self.retained_successful_attempts)
                > self.failed_attempts
            || self.retained_attempts as usize > MAXIMUM_CONNECTION_ROUTE_RECORDS
            || self.records.len() > self.retained_attempts as usize
        {
            return fail("route counts are inconsistent");
        }
        if self.presentation_bytes() > MAXIMUM_CONNECTION_ROUTE_BYTES {
            return fail("routes exceed their byte bound");
        }
        let retention = self.total_attempts > u64::from(self.retained_attempts);
        if retention != (self.omission_reasons & ROUTE_OMISSION_ATTEMPT_RETENTION != 0) {
            return fail("the attempt retention reason does not match the counts");
        }
        let trimmed = self.records.len() < self.retained_attempts as usize;
        let trim_reasons = self.omission_reasons
            & (ROUTE_OMISSION_PRESENTATION_BUDGET | ROUTE_OMISSION_FRAME_BUDGET);
        if trimmed != (trim_reasons != 0) {
            return fail("the omission reasons do not match the presented records");
        }
        let mut next_vertex = 0_usize;
        let mut next_graph_index = 0_u32;
        let mut failures = 0_u32;
        for record in &self.records {
            let first = record.first_vertex as usize;
            let count = record.vertex_count as usize;
            if first != next_vertex || count == 0 || count > tile_count {
                return fail("route vertices are not contiguous");
            }
            let Some(route) = self.vertices.get(first..first + count) else {
                return fail("route vertices exceed the vertex column");
            };
            if route
                .iter()
                .any(|vertex| vertex.index(dimensions).is_none())
            {
                return fail("a route vertex lies outside the map");
            }
            if record.operation_index as usize >= operation_count {
                return fail("a route names an unknown provenance operation");
            }
            if record.succeeded() {
                if record.graph_index != next_graph_index {
                    return fail("successful routes are not in connection graph order");
                }
                let index = record.graph_index as usize;
                let (Some(connection), Some(&operation)) = (
                    connections.get(index),
                    connection_operation_indices.get(index),
                ) else {
                    return fail("a route names an unknown connection");
                };
                if operation != record.operation_index
                    || route.first() != Some(&connection.start)
                    || route.last() != Some(&connection.end)
                {
                    return fail("a route does not match its connection");
                }
                if route.windows(2).any(|pair| {
                    let dx = pair[0].x.abs_diff(pair[1].x);
                    let dy = pair[0].y.abs_diff(pair[1].y);
                    dx.max(dy) != 1
                }) {
                    return fail("a route step is not to an adjacent tile");
                }
                next_graph_index += 1;
            } else {
                if count != 2 {
                    return fail("a failed search does not have two endpoints");
                }
                failures += 1;
            }
            next_vertex = first + count;
        }
        if next_vertex != self.vertices.len() {
            return fail("unreferenced route vertices remain");
        }
        if next_graph_index > self.retained_successful_attempts
            || failures > self.retained_attempts - self.retained_successful_attempts
        {
            return fail("presented routes exceed the kept searches");
        }
        Ok(())
    }
}
