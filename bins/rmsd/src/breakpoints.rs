use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rms_engine::{
    AtomicCancellationToken, CancellationToken, ExecutionCounter, ExecutionObserver, ExecutionStep,
    OperationBoundary, OperationEdge, VisualStage, VisualState,
};
use rms_protocol::v1;
use rms_semantics::SemanticProgram;

pub(crate) const MAXIMUM_BREAKPOINTS: usize = 1024;
const PAUSED_POLL: Duration = Duration::from_millis(100);

#[derive(Default)]
pub(crate) struct BreakpointControl {
    state: Mutex<ControlState>,
    wake: Condvar,
}

#[derive(Default)]
struct ControlState {
    paused: bool,
    command: Option<v1::BreakpointAction>,
}

impl BreakpointControl {
    pub(crate) fn command(&self, action: v1::BreakpointAction) -> bool {
        if !matches!(
            action,
            v1::BreakpointAction::Continue | v1::BreakpointAction::Step
        ) {
            return false;
        }
        let mut state = self.state.lock().expect("breakpoint control poisoned");
        if !state.paused || state.command.is_some() {
            return false;
        }
        state.command = Some(action);
        self.wake.notify_all();
        true
    }

    pub(crate) fn wake(&self) {
        let _state = self.state.lock().expect("breakpoint control poisoned");
        self.wake.notify_all();
    }

    fn begin_pause(&self) {
        let mut state = self.state.lock().expect("breakpoint control poisoned");
        state.paused = true;
        state.command = None;
    }

    fn wait(&self, cancellation: &AtomicCancellationToken) -> Option<v1::BreakpointAction> {
        let mut state = self.state.lock().expect("breakpoint control poisoned");
        loop {
            if cancellation.is_cancelled() {
                state.paused = false;
                return None;
            }
            if let Some(action) = state.command.take() {
                state.paused = false;
                return Some(action);
            }
            state = self
                .wake
                .wait_timeout(state, PAUSED_POLL)
                .expect("breakpoint control poisoned")
                .0;
        }
    }
}

pub(crate) type BreakpointControls = Arc<Mutex<BTreeMap<String, Arc<BreakpointControl>>>>;

pub(crate) fn validate_breakpoints(breakpoints: &[v1::GenerationBreakpoint]) -> Result<(), String> {
    if breakpoints.len() > MAXIMUM_BREAKPOINTS {
        return Err(format!(
            "a request carries at most {MAXIMUM_BREAKPOINTS} breakpoints"
        ));
    }
    let mut ids = BTreeSet::new();
    for breakpoint in breakpoints {
        if !ids.insert(breakpoint.id) {
            return Err("breakpoint IDs must be distinct".to_owned());
        }
        if breakpoint.source_id.is_empty() || breakpoint.source_id.len() > 4096 {
            return Err("a breakpoint's source must be 1 to 4096 bytes".to_owned());
        }
        if breakpoint.byte_start > breakpoint.byte_end {
            return Err("a breakpoint's byte range is reversed".to_owned());
        }
        if !matches!(
            v1::BreakpointEdge::try_from(breakpoint.edge),
            Ok(v1::BreakpointEdge::Before | v1::BreakpointEdge::After)
        ) {
            return Err("a breakpoint's edge must be before or after".to_owned());
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedBreakpoint {
    pub id: u32,
    pub edge: OperationEdge,
    pub operations: Vec<u32>,
}

pub(crate) fn resolve_breakpoints(
    breakpoints: &[v1::GenerationBreakpoint],
    program: &SemanticProgram,
) -> Vec<ResolvedBreakpoint> {
    breakpoints
        .iter()
        .map(|breakpoint| {
            let key = source_key(&breakpoint.source_id);
            let operations = program
                .operations
                .iter()
                .enumerate()
                .filter(|(_, operation)| {
                    let start = operation.source_range.start.0;
                    breakpoint.byte_start <= start
                        && start < breakpoint.byte_end
                        && source_key(operation.source_id.as_str()) == key
                })
                .filter_map(|(index, _)| u32::try_from(index).ok())
                .collect();
            ResolvedBreakpoint {
                id: breakpoint.id,
                edge: if breakpoint.edge == v1::BreakpointEdge::Before as i32 {
                    OperationEdge::Before
                } else {
                    OperationEdge::After
                },
                operations,
            }
        })
        .collect()
}

fn source_key(source_id: &str) -> String {
    let Some(rest) = source_id
        .get(..7)
        .filter(|scheme| scheme.eq_ignore_ascii_case("file://"))
        .map(|_| &source_id[7..])
    else {
        return source_id.to_owned();
    };
    let bytes = rest.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(value) = bytes
                .get(index + 1..index + 3)
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            decoded.push(value);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    let path = String::from_utf8_lossy(&decoded).replace('\\', "/");
    format!("file://{}", path.to_lowercase())
}

pub(crate) struct StopFacts<'a> {
    pub sequence: u32,
    pub breakpoint_ids: &'a [u32],
}

pub(crate) struct BreakpointObserver<'a> {
    inner: &'a mut dyn ExecutionObserver,
    breakpoints: Vec<ResolvedBreakpoint>,
    fired_before: BTreeSet<u32>,
    reached: BTreeSet<u32>,
    stepping: bool,
    stopped: bool,
    stop_sequence: u32,
    cancellation: &'a AtomicCancellationToken,
    control: Arc<BreakpointControl>,
    publish: &'a mut dyn FnMut(&OperationBoundary<'_>, StopFacts<'_>),
}

impl<'a> BreakpointObserver<'a> {
    pub(crate) fn new(
        inner: &'a mut dyn ExecutionObserver,
        breakpoints: Vec<ResolvedBreakpoint>,
        cancellation: &'a AtomicCancellationToken,
        control: Arc<BreakpointControl>,
        publish: &'a mut dyn FnMut(&OperationBoundary<'_>, StopFacts<'_>),
    ) -> Self {
        Self {
            inner,
            breakpoints,
            fired_before: BTreeSet::new(),
            reached: BTreeSet::new(),
            stepping: false,
            stopped: false,
            stop_sequence: 0,
            cancellation,
            control,
            publish,
        }
    }

    pub(crate) fn reached(&self) -> Vec<u32> {
        self.reached.iter().copied().collect()
    }

    fn hits(&mut self, boundary: &OperationBoundary<'_>) -> Vec<u32> {
        let mut hits = Vec::new();
        for breakpoint in &self.breakpoints {
            if breakpoint.edge != boundary.edge
                || (breakpoint.edge == OperationEdge::Before
                    && self.fired_before.contains(&breakpoint.id))
                || !sorted_intersect(&breakpoint.operations, boundary.operations)
            {
                continue;
            }
            hits.push(breakpoint.id);
        }
        if boundary.edge == OperationEdge::Before {
            self.fired_before.extend(hits.iter().copied());
        }
        hits
    }
}

fn sorted_intersect(left: &[u32], right: &[u32]) -> bool {
    let (mut left_index, mut right_index) = (0, 0);
    while left_index < left.len() && right_index < right.len() {
        match left[left_index].cmp(&right[right_index]) {
            std::cmp::Ordering::Less => left_index += 1,
            std::cmp::Ordering::Greater => right_index += 1,
            std::cmp::Ordering::Equal => return true,
        }
    }
    false
}

impl ExecutionObserver for BreakpointObserver<'_> {
    fn execution_started(&mut self, plan: &'static [ExecutionStep]) {
        self.inner.execution_started(plan);
    }

    fn step_started(&mut self, step: ExecutionStep) {
        self.inner.step_started(step);
    }

    fn step_finished(&mut self, step: ExecutionStep, counters: &[(ExecutionCounter, u64)]) {
        self.inner.step_finished(step, counters);
    }

    fn visual_boundary(&mut self, stage: VisualStage, state: &VisualState<'_>) {
        self.inner.visual_boundary(stage, state);
    }

    fn visual_substage(&mut self, stage: VisualStage, state: &VisualState<'_>) {
        self.inner.visual_substage(stage, state);
    }

    fn exclude_observation(&mut self, duration: Duration) {
        self.inner.exclude_observation(duration);
    }

    fn observes_operation_boundaries(&self) -> bool {
        true
    }

    fn operation_boundary(&mut self, boundary: &OperationBoundary<'_>) {
        self.inner.operation_boundary(boundary);
        if self.stopped || self.cancellation.is_cancelled() {
            return;
        }
        let hits = self.hits(boundary);
        let step = self.stepping && boundary.edge == OperationEdge::After;
        if hits.is_empty() && !step {
            return;
        }
        self.reached.extend(hits.iter().copied());
        self.stop_sequence = self.stop_sequence.saturating_add(1);
        self.control.begin_pause();
        (self.publish)(
            boundary,
            StopFacts {
                sequence: self.stop_sequence,
                breakpoint_ids: &hits,
            },
        );
        match self.control.wait(self.cancellation) {
            Some(v1::BreakpointAction::Step) => self.stepping = true,
            Some(_) => self.stepping = false,
            None => self.stopped = true,
        }
    }
}
