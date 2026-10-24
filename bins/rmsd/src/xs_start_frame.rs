use prost::Message;
use rms_protocol::v1;
use rms_protocol::v1::envelope::Payload;

pub(crate) fn fit_xs_start(message: &mut v1::Envelope) {
    if message.encoded_len() <= rms_protocol::MAX_FRAME_BYTES {
        return;
    }
    let Some(Payload::GenerationResponse(response)) = message.payload.as_mut() else {
        return;
    };
    let Some(report) = response.xs_start.as_mut() else {
        return;
    };
    if !report.recorded_calls.is_empty() {
        report.omitted_recorded_calls = report
            .omitted_recorded_calls
            .saturating_add(report.recorded_calls.len() as u32);
        report.recorded_calls = Vec::new();
    }
    if message.encoded_len() <= rms_protocol::MAX_FRAME_BYTES {
        return;
    }
    if let Some(Payload::GenerationResponse(response)) = message.payload.as_mut() {
        response.xs_start = None;
    }
}
