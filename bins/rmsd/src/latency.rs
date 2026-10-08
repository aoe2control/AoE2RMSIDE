#[cfg(feature = "latency-profile")]
pub(crate) use active::*;
#[cfg(not(feature = "latency-profile"))]
pub(crate) use inactive::*;

#[cfg(not(feature = "latency-profile"))]
mod inactive {
    #[derive(Clone, Copy)]
    pub(crate) struct Mark;

    #[inline(always)]
    pub(crate) fn mark() -> Mark {
        Mark
    }
    #[inline(always)]
    pub(crate) fn received(_request_id: &str, _decode_started: Mark) {}
    #[inline(always)]
    pub(crate) fn step(_request_id: &str, _name: &'static str) {}
    #[inline(always)]
    pub(crate) fn within(_request_id: &str, _name: &'static str, _since: Mark) {}
    #[inline(always)]
    pub(crate) fn engine(_request_id: &str, _microseconds: u64) {}
    #[inline(always)]
    pub(crate) fn cancelled(_request_id: &str) {}
    #[inline(always)]
    pub(crate) fn terminal_picked(_messages: &[rms_protocol::v1::Envelope]) {}
    #[inline(always)]
    pub(crate) fn terminal_written(_messages: &[rms_protocol::v1::Envelope]) {}
}

#[cfg(feature = "latency-profile")]
mod active {
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::time::Instant;

    use prost::Message;
    use rms_protocol::v1::envelope::Payload;
    use rms_protocol::v1::{self, ErrorCode};

    pub(crate) const MARKER: &str = "rmside-latency-v1";
    const MAXIMUM_RECORDS: usize = 64;
    const MAXIMUM_STEPS: usize = 32;
    const MAXIMUM_REQUEST_ID: usize = 128;

    static STATE: AtomicU8 = AtomicU8::new(0);
    static RECORDS: Mutex<BTreeMap<String, Record>> = Mutex::new(BTreeMap::new());

    struct Record {
        decode_us: u64,
        received: Instant,
        cursor: Instant,
        elapsed_us: u64,
        steps: Vec<(&'static str, u64)>,
        within: Vec<(&'static str, u64)>,
        engine_us: Option<u64>,
        cancelled: Option<Instant>,
    }

    fn active() -> bool {
        match STATE.load(Ordering::Relaxed) {
            1 => false,
            2 => true,
            _ => {
                let on = std::env::var("RMSIDE_LATENCY_PROFILE").is_ok_and(|value| value == "1");
                STATE.store(if on { 2 } else { 1 }, Ordering::Relaxed);
                on
            }
        }
    }

    fn records() -> std::sync::MutexGuard<'static, BTreeMap<String, Record>> {
        RECORDS.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    fn micros(duration: std::time::Duration) -> u64 {
        u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
    }

    #[derive(Clone, Copy)]
    pub(crate) struct Mark(Option<Instant>);

    pub(crate) fn mark() -> Mark {
        Mark(active().then(Instant::now))
    }

    pub(crate) fn received(request_id: &str, decode_started: Mark) {
        let Some(started) = decode_started.0 else {
            return;
        };
        let now = Instant::now();
        let mut records = records();
        if records.len() >= MAXIMUM_RECORDS || records.contains_key(request_id) {
            return;
        }
        records.insert(
            request_id.to_owned(),
            Record {
                decode_us: micros(now - started),
                received: now,
                cursor: now,
                elapsed_us: 0,
                steps: Vec::new(),
                within: Vec::new(),
                engine_us: None,
                cancelled: None,
            },
        );
    }

    pub(crate) fn step(request_id: &str, name: &'static str) {
        if !active() {
            return;
        }
        let now = Instant::now();
        if let Some(record) = records().get_mut(request_id) {
            let elapsed = micros(now - record.received);
            push(
                &mut record.steps,
                name,
                elapsed.saturating_sub(record.elapsed_us),
            );
            record.elapsed_us = elapsed.max(record.elapsed_us);
            record.cursor = now;
        }
    }

    pub(crate) fn within(request_id: &str, name: &'static str, since: Mark) {
        let Some(since) = since.0 else {
            return;
        };
        let elapsed = micros(since.elapsed());
        if let Some(record) = records().get_mut(request_id) {
            push(&mut record.within, name, elapsed);
        }
    }

    pub(crate) fn engine(request_id: &str, microseconds: u64) {
        if !active() {
            return;
        }
        if let Some(record) = records().get_mut(request_id) {
            record.engine_us = Some(microseconds);
        }
    }

    pub(crate) fn cancelled(request_id: &str) {
        if !active() {
            return;
        }
        if let Some(record) = records().get_mut(request_id) {
            record.cancelled.get_or_insert_with(Instant::now);
        }
    }

    fn push(entries: &mut Vec<(&'static str, u64)>, name: &'static str, value: u64) {
        if let Some(entry) = entries.iter_mut().find(|(existing, _)| *existing == name) {
            entry.1 = entry.1.saturating_add(value);
        } else if entries.len() < MAXIMUM_STEPS {
            entries.push((name, value));
        }
    }

    fn terminals(messages: &[v1::Envelope]) -> impl Iterator<Item = (&v1::Envelope, &'static str)> {
        messages
            .iter()
            .filter_map(|message| match &message.payload {
                Some(Payload::GenerationResponse(_)) => Some((message, "committed")),
                Some(Payload::Error(error)) if error.code == ErrorCode::Cancelled as i32 => {
                    Some((message, "cancelled"))
                }
                Some(Payload::Error(_)) => Some((message, "failed")),
                _ => None,
            })
    }

    pub(crate) fn terminal_picked(messages: &[v1::Envelope]) {
        if !active() {
            return;
        }
        for (message, _) in terminals(messages) {
            step(&message.request_id, "write-wait");
        }
    }

    pub(crate) fn terminal_written(messages: &[v1::Envelope]) {
        if !active() {
            return;
        }
        for (message, outcome) in terminals(messages) {
            step(&message.request_id, "write");
            let Some(record) = records().remove(&message.request_id) else {
                continue;
            };
            let bytes = message.encoded_len();
            emit(format_line(&message.request_id, outcome, &record, bytes));
        }
    }

    fn format_line(request_id: &str, outcome: &str, record: &Record, bytes: usize) -> String {
        let inclusive = record.decode_us.saturating_add(record.elapsed_us);
        let pairs = |entries: &[(&'static str, u64)]| {
            entries
                .iter()
                .map(|(name, value)| format!("[\"{name}\",{value}]"))
                .collect::<Vec<_>>()
                .join(",")
        };
        let mut line = format!(
            "{MARKER} {{\"process\":\"rmsd\",\"kind\":\"generation\",\"request\":\"{}\",\"outcome\":\"{outcome}\",\"inclusiveUs\":{inclusive},\"responseBytes\":{bytes},\"steps\":[{}],\"within\":[{}]",
            sanitized(request_id),
            pairs(&[&[("decode", record.decode_us)], record.steps.as_slice()].concat()),
            pairs(&record.within),
        );
        if let Some(engine) = record.engine_us {
            line.push_str(&format!(",\"engineUs\":{engine}"));
        }
        if let Some(cancelled) = record.cancelled {
            line.push_str(&format!(
                ",\"cancelToTerminalUs\":{}",
                micros(record.cursor.saturating_duration_since(cancelled))
            ));
        }
        line.push('}');
        line
    }

    fn sanitized(request_id: &str) -> String {
        request_id
            .chars()
            .take(MAXIMUM_REQUEST_ID)
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':') {
                    character
                } else {
                    '_'
                }
            })
            .collect()
    }

    fn emit(line: String) {
        eprintln!("{line}");
    }
}
