#[cfg(feature = "latency-profile")]
pub(crate) use active::*;
#[cfg(not(feature = "latency-profile"))]
pub(crate) use inactive::*;

#[cfg(not(feature = "latency-profile"))]
mod inactive {
    use serde_json::Value;

    pub(crate) struct Timing;

    impl Timing {
        #[inline(always)]
        pub(crate) fn start() -> Self {
            Self
        }
        #[inline(always)]
        pub(crate) fn step(&mut self, _name: &'static str) {}
        #[inline(always)]
        pub(crate) fn finish(self, _method: &str, _id: Option<&Value>) {}
    }
}

#[cfg(feature = "latency-profile")]
mod active {
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::time::Instant;

    use serde_json::Value;

    pub(crate) const MARKER: &str = "rmside-latency-v1";
    const REPORTED_METHODS: [&str; 14] = [
        "rms/semanticIdentity",
        "textDocument/didOpen",
        "textDocument/didChange",
        "textDocument/formatting",
        "textDocument/semanticTokens/full",
        "textDocument/completion",
        "textDocument/hover",
        "textDocument/signatureHelp",
        "textDocument/codeAction",
        "textDocument/inlayHint",
        "textDocument/documentHighlight",
        "textDocument/documentLink",
        "completionItem/resolve",
        "rms/editorInventory",
    ];

    static STATE: AtomicU8 = AtomicU8::new(0);

    fn active() -> bool {
        match STATE.load(Ordering::Relaxed) {
            1 => false,
            2 => true,
            _ => {
                let on = std::env::var("RMSIDE_LATENCY_PROFILE").is_ok_and(|value| value == "1");
                match STATE.compare_exchange(
                    0,
                    if on { 2 } else { 1 },
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => on,
                    Err(current) => current == 2,
                }
            }
        }
    }

    pub(crate) struct Timing {
        started: Option<Instant>,
        elapsed_us: u64,
        steps: Vec<(&'static str, u64)>,
    }

    impl Timing {
        pub(crate) fn start() -> Self {
            Self {
                started: active().then(Instant::now),
                elapsed_us: 0,
                steps: Vec::new(),
            }
        }

        pub(crate) fn step(&mut self, name: &'static str) {
            let Some(started) = self.started else {
                return;
            };
            let elapsed = micros(started.elapsed()).max(self.elapsed_us);
            if self.steps.len() < 8 {
                self.steps.push((name, elapsed - self.elapsed_us));
                self.elapsed_us = elapsed;
            }
        }

        pub(crate) fn finish(self, method: &str, id: Option<&Value>) {
            if self.started.is_none() {
                return;
            }
            let Some(line) = format_line(method, id, self.elapsed_us, &self.steps) else {
                return;
            };
            emit(line);
        }
    }

    fn micros(duration: std::time::Duration) -> u64 {
        u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
    }

    fn format_line(
        method: &str,
        id: Option<&Value>,
        inclusive: u64,
        steps: &[(&'static str, u64)],
    ) -> Option<String> {
        let method = REPORTED_METHODS
            .iter()
            .find(|candidate| **candidate == method)
            .copied()
            .unwrap_or("other");
        let identity = match id {
            Some(value) => format!(",\"kind\":\"request\",\"id\":{}", value.as_u64()?),
            None if method.starts_with("textDocument/did") => {
                ",\"kind\":\"notification\"".to_owned()
            }
            None => return None,
        };
        let steps = steps
            .iter()
            .map(|(name, value)| format!("[\"{name}\",{value}]"))
            .collect::<Vec<_>>()
            .join(",");
        Some(format!(
            "{MARKER} {{\"process\":\"rms-ls\",\"method\":\"{method}\"{identity},\"inclusiveUs\":{inclusive},\"steps\":[{steps}]}}"
        ))
    }

    fn emit(line: String) {
        eprintln!("{line}");
    }
}
