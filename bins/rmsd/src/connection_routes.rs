use prost::Message;
use prost::encoding::{encoded_len_varint, key_len};
use rms_engine::{
    CONNECTION_ROUTE_RECORD_BYTES, CONNECTION_ROUTE_VERTEX_BYTES, CONNECTION_ROUTES_FORMAT_MAJOR,
    CONNECTION_ROUTES_FORMAT_MINOR, ConnectionRouteRecord, ConnectionRoutes, ConnectionRoutesError,
    MAXIMUM_CONNECTION_ROUTE_BYTES, MAXIMUM_CONNECTION_ROUTE_RECORDS, MapCoordinate,
    ROUTE_OMISSION_FRAME_BUDGET,
};
use rms_protocol::MAX_FRAME_BYTES;
use rms_protocol::v1::{self, envelope::Payload};

const MAP_STATE_ROUTES_TAG: u32 = 15;
const RECORDS_TAG: u32 = 9;
const VERTICES_TAG: u32 = 10;

pub fn protocol_connection_routes(routes: &ConnectionRoutes) -> v1::ConnectionRoutes {
    let mut records = Vec::with_capacity(routes.records.len() * CONNECTION_ROUTE_RECORD_BYTES);
    for record in &routes.records {
        for value in [
            record.graph_index,
            record.operation_index,
            record.first_vertex,
            record.vertex_count,
        ] {
            records.extend_from_slice(&value.to_le_bytes());
        }
    }
    let mut vertices = Vec::with_capacity(routes.vertices.len() * CONNECTION_ROUTE_VERTEX_BYTES);
    for vertex in &routes.vertices {
        vertices.extend_from_slice(&vertex.x.to_le_bytes());
        vertices.extend_from_slice(&vertex.y.to_le_bytes());
    }
    v1::ConnectionRoutes {
        format_major: CONNECTION_ROUTES_FORMAT_MAJOR,
        format_minor: CONNECTION_ROUTES_FORMAT_MINOR,
        total_attempts: routes.total_attempts,
        successful_attempts: routes.successful_attempts,
        failed_attempts: routes.failed_attempts,
        retained_attempts: routes.retained_attempts,
        retained_successful_attempts: routes.retained_successful_attempts,
        omission_reasons: routes.omission_reasons,
        records_le: records,
        vertices_le: vertices,
    }
}

pub fn decode_connection_routes(
    message: &v1::ConnectionRoutes,
) -> Result<ConnectionRoutes, ConnectionRoutesError> {
    let fail = |reason| Err(ConnectionRoutesError(reason));
    if message.format_major != CONNECTION_ROUTES_FORMAT_MAJOR {
        return fail("unsupported route format major");
    }
    if message.encoded_len() > MAXIMUM_CONNECTION_ROUTE_BYTES {
        return fail("routes exceed their byte bound");
    }
    if !message
        .records_le
        .len()
        .is_multiple_of(CONNECTION_ROUTE_RECORD_BYTES)
        || !message
            .vertices_le
            .len()
            .is_multiple_of(CONNECTION_ROUTE_VERTEX_BYTES)
        || message.records_le.len() / CONNECTION_ROUTE_RECORD_BYTES
            > MAXIMUM_CONNECTION_ROUTE_RECORDS
    {
        return fail("route columns have an invalid length");
    }
    let word = |bytes: &[u8], index: usize| {
        u32::from_le_bytes(
            bytes[index * 4..index * 4 + 4]
                .try_into()
                .expect("four bytes"),
        )
    };
    let records = message
        .records_le
        .chunks_exact(CONNECTION_ROUTE_RECORD_BYTES)
        .map(|record| ConnectionRouteRecord {
            graph_index: word(record, 0),
            operation_index: word(record, 1),
            first_vertex: word(record, 2),
            vertex_count: word(record, 3),
        })
        .collect();
    let vertices = message
        .vertices_le
        .chunks_exact(CONNECTION_ROUTE_VERTEX_BYTES)
        .map(|vertex| MapCoordinate {
            x: u16::from_le_bytes([vertex[0], vertex[1]]),
            y: u16::from_le_bytes([vertex[2], vertex[3]]),
        })
        .collect();
    Ok(ConnectionRoutes {
        total_attempts: message.total_attempts,
        successful_attempts: message.successful_attempts,
        failed_attempts: message.failed_attempts,
        retained_attempts: message.retained_attempts,
        retained_successful_attempts: message.retained_successful_attempts,
        omission_reasons: message.omission_reasons,
        records,
        vertices,
    })
}

fn delimited_growth(before: usize, after: usize) -> usize {
    (encoded_len_varint(after as u64) + after) - (encoded_len_varint(before as u64) + before)
}

fn prefix_length(routes: &v1::ConnectionRoutes, count: usize, trimmed: bool) -> usize {
    let mut header = routes.clone_header();
    if trimmed {
        header.omission_reasons |= ROUTE_OMISSION_FRAME_BUDGET;
    }
    let bytes = |tag: u32, length: usize| {
        if length == 0 {
            0
        } else {
            key_len(tag) + encoded_len_varint(length as u64) + length
        }
    };
    header.encoded_len()
        + bytes(RECORDS_TAG, count * CONNECTION_ROUTE_RECORD_BYTES)
        + bytes(
            VERTICES_TAG,
            vertex_end(routes, count) * CONNECTION_ROUTE_VERTEX_BYTES,
        )
}

fn vertex_end(routes: &v1::ConnectionRoutes, count: usize) -> usize {
    let start = count * CONNECTION_ROUTE_RECORD_BYTES + 8;
    routes
        .records_le
        .get(start..start + 4)
        .map_or(
            routes.vertices_le.len() / CONNECTION_ROUTE_VERTEX_BYTES,
            |bytes| u32::from_le_bytes(bytes.try_into().expect("four bytes")) as usize,
        )
        .min(routes.vertices_le.len() / CONNECTION_ROUTE_VERTEX_BYTES)
}

trait CloneHeader {
    fn clone_header(&self) -> Self;
}

impl CloneHeader for v1::ConnectionRoutes {
    fn clone_header(&self) -> Self {
        Self {
            format_major: self.format_major,
            format_minor: self.format_minor,
            total_attempts: self.total_attempts,
            successful_attempts: self.successful_attempts,
            failed_attempts: self.failed_attempts,
            retained_attempts: self.retained_attempts,
            retained_successful_attempts: self.retained_successful_attempts,
            omission_reasons: self.omission_reasons,
            records_le: Vec::new(),
            vertices_le: Vec::new(),
        }
    }
}

fn routes_slot(message: &mut v1::Envelope) -> Option<&mut Option<v1::ConnectionRoutes>> {
    match message.payload.as_mut() {
        Some(Payload::GenerationResponse(response)) => response
            .map_state
            .as_mut()
            .map(|map_state| &mut map_state.connection_routes),
        _ => None,
    }
}

pub(crate) fn fit_connection_routes(message: &mut v1::Envelope) {
    let Some(routes) = routes_slot(message).and_then(Option::take) else {
        return;
    };
    let Some(Payload::GenerationResponse(response)) = message.payload.as_ref() else {
        return;
    };
    let Some(map_state) = response.map_state.as_ref() else {
        return;
    };
    let map_without = map_state.encoded_len();
    let response_without = response.encoded_len();
    let envelope_without = message.encoded_len();
    if envelope_without > MAX_FRAME_BYTES {
        return;
    }
    let envelope_with = |routes_length: usize| {
        let map_with = map_without
            + key_len(MAP_STATE_ROUTES_TAG)
            + encoded_len_varint(routes_length as u64)
            + routes_length;
        let response_with = response_without + delimited_growth(map_without, map_with);
        envelope_without + delimited_growth(response_without, response_with)
    };
    let presented = routes.records_le.len() / CONNECTION_ROUTE_RECORD_BYTES;
    let fits = |count: usize| {
        let length = prefix_length(&routes, count, count < presented);
        length <= MAXIMUM_CONNECTION_ROUTE_BYTES && envelope_with(length) <= MAX_FRAME_BYTES
    };
    let kept = if fits(presented) {
        Some(presented)
    } else if !fits(0) {
        None
    } else {
        let (mut fitting, mut failing) = (0, presented);
        while failing - fitting > 1 {
            let middle = fitting + (failing - fitting) / 2;
            if fits(middle) {
                fitting = middle;
            } else {
                failing = middle;
            }
        }
        Some(fitting)
    };
    let Some(kept) = kept else {
        return;
    };
    if kept == presented {
        let mut summary = routes.clone_header();
        summary.omission_reasons |= ROUTE_OMISSION_FRAME_BUDGET;
        if let Some(slot) = routes_slot(message) {
            *slot = Some(routes);
        }
        if message.encoded_len() <= MAX_FRAME_BYTES {
            return;
        }
        if let Some(slot) = routes_slot(message) {
            *slot = (presented > 0).then_some(summary);
        }
        if message.encoded_len() > MAX_FRAME_BYTES
            && let Some(slot) = routes_slot(message)
        {
            *slot = None;
        }
        return;
    }
    let mut fitted = routes.clone_header();
    if kept < presented {
        fitted.omission_reasons |= ROUTE_OMISSION_FRAME_BUDGET;
    }
    fitted.records_le = routes.records_le[..kept * CONNECTION_ROUTE_RECORD_BYTES].to_vec();
    fitted.vertices_le =
        routes.vertices_le[..vertex_end(&routes, kept) * CONNECTION_ROUTE_VERTEX_BYTES].to_vec();
    drop(routes);
    let summary = (kept > 0).then(|| {
        let mut summary = fitted.clone_header();
        summary.omission_reasons |= ROUTE_OMISSION_FRAME_BUDGET;
        summary
    });
    if let Some(slot) = routes_slot(message) {
        *slot = Some(fitted);
    }
    if message.encoded_len() <= MAX_FRAME_BYTES {
        return;
    }
    if let Some(slot) = routes_slot(message) {
        *slot = summary;
    }
    if message.encoded_len() > MAX_FRAME_BYTES
        && let Some(slot) = routes_slot(message)
    {
        *slot = None;
    }
}
