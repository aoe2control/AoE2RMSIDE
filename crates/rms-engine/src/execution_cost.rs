use std::time::Instant;

use crate::visual_checkpoint::{VisualStage, VisualState};

pub const EXECUTION_COST_CONTRACT_MAJOR: u32 = 1;
pub const EXECUTION_COST_CONTRACT_MINOR: u32 = 0;
pub const MAXIMUM_EXECUTION_GROUPS: usize = 16;
pub const MAXIMUM_EXECUTION_STEPS: usize = 32;
pub const MAXIMUM_STEP_COUNTERS: usize = 8;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ExecutionGroup {
    Parse,
    Setup,
    Land,
    Elevation,
    Cliffs,
    Terrain,
    Connections,
    Objects,
    Finalize,
}

impl ExecutionGroup {
    pub const ALL: [Self; 9] = [
        Self::Parse,
        Self::Setup,
        Self::Land,
        Self::Elevation,
        Self::Cliffs,
        Self::Terrain,
        Self::Connections,
        Self::Objects,
        Self::Finalize,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Parse => "parse",
            Self::Setup => "setup",
            Self::Land => "land",
            Self::Elevation => "elevation",
            Self::Cliffs => "cliffs",
            Self::Terrain => "terrain",
            Self::Connections => "connections",
            Self::Objects => "objects",
            Self::Finalize => "finalize",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ExecutionStep {
    ParseScript,
    SetupPlayers,
    LandGenerate,
    ElevationGenerate,
    CliffsGenerate,
    TerrainGenerate,
    ConnectionsGenerate,
    ObjectsGenerate,
    FinalizeGameMode,
    FinalizeObjectOrder,
    FinalizeCompositeTerrain,
}

pub const EXACT_EXECUTION_PLAN: [ExecutionStep; 11] = [
    ExecutionStep::ParseScript,
    ExecutionStep::SetupPlayers,
    ExecutionStep::LandGenerate,
    ExecutionStep::ElevationGenerate,
    ExecutionStep::CliffsGenerate,
    ExecutionStep::TerrainGenerate,
    ExecutionStep::ConnectionsGenerate,
    ExecutionStep::ObjectsGenerate,
    ExecutionStep::FinalizeGameMode,
    ExecutionStep::FinalizeObjectOrder,
    ExecutionStep::FinalizeCompositeTerrain,
];

impl ExecutionStep {
    pub const ALL: [Self; 11] = EXACT_EXECUTION_PLAN;

    pub const fn id(self) -> &'static str {
        match self {
            Self::ParseScript => "parse.script",
            Self::SetupPlayers => "setup.players",
            Self::LandGenerate => "land.generate",
            Self::ElevationGenerate => "elevation.generate",
            Self::CliffsGenerate => "cliffs.generate",
            Self::TerrainGenerate => "terrain.generate",
            Self::ConnectionsGenerate => "connections.generate",
            Self::ObjectsGenerate => "objects.generate",
            Self::FinalizeGameMode => "finalize.game-mode",
            Self::FinalizeObjectOrder => "finalize.object-order",
            Self::FinalizeCompositeTerrain => "finalize.composite-terrain",
        }
    }

    pub const fn group(self) -> ExecutionGroup {
        match self {
            Self::ParseScript => ExecutionGroup::Parse,
            Self::SetupPlayers => ExecutionGroup::Setup,
            Self::LandGenerate => ExecutionGroup::Land,
            Self::ElevationGenerate => ExecutionGroup::Elevation,
            Self::CliffsGenerate => ExecutionGroup::Cliffs,
            Self::TerrainGenerate => ExecutionGroup::Terrain,
            Self::ConnectionsGenerate => ExecutionGroup::Connections,
            Self::ObjectsGenerate => ExecutionGroup::Objects,
            Self::FinalizeGameMode | Self::FinalizeObjectOrder | Self::FinalizeCompositeTerrain => {
                ExecutionGroup::Finalize
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ExecutionCounter {
    Operations,
    RngDraws,
    CandidatesExamined,
    TilesAccepted,
    PathSearches,
    PathWork,
    PlacementRejections,
    ObjectsPlaced,
}

impl ExecutionCounter {
    pub const ALL: [Self; 8] = [
        Self::Operations,
        Self::RngDraws,
        Self::CandidatesExamined,
        Self::TilesAccepted,
        Self::PathSearches,
        Self::PathWork,
        Self::PlacementRejections,
        Self::ObjectsPlaced,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Operations => "operations",
            Self::RngDraws => "rng-draws",
            Self::CandidatesExamined => "candidates-examined",
            Self::TilesAccepted => "tiles-accepted",
            Self::PathSearches => "path-searches",
            Self::PathWork => "path-work",
            Self::PlacementRejections => "placement-rejections",
            Self::ObjectsPlaced => "objects-placed",
        }
    }
}

pub trait ExecutionObserver {
    fn execution_started(&mut self, plan: &'static [ExecutionStep]);
    fn step_started(&mut self, step: ExecutionStep);
    fn step_finished(&mut self, step: ExecutionStep, counters: &[(ExecutionCounter, u64)]);
    fn visual_boundary(&mut self, _stage: VisualStage, _state: &VisualState<'_>) {}
    fn visual_substage(&mut self, _stage: VisualStage, _state: &VisualState<'_>) {}
    fn exclude_observation(&mut self, _duration: std::time::Duration) {}
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NoopExecutionObserver;

impl ExecutionObserver for NoopExecutionObserver {
    fn execution_started(&mut self, _plan: &'static [ExecutionStep]) {}
    fn step_started(&mut self, _step: ExecutionStep) {}
    fn step_finished(&mut self, _step: ExecutionStep, _counters: &[(ExecutionCounter, u64)]) {}
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepCost {
    pub step: ExecutionStep,
    pub duration_us: u64,
    pub counters: Vec<(ExecutionCounter, u64)>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GroupCost {
    pub group: ExecutionGroup,
    pub duration_us: u64,
    pub steps: Vec<StepCost>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionCostSummary {
    pub contract_major: u32,
    pub contract_minor: u32,
    pub total_us: u64,
    pub groups: Vec<GroupCost>,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("execution-cost summary is invalid: {0}")]
pub struct ExecutionCostError(pub &'static str);

impl ExecutionCostSummary {
    pub fn validate(&self) -> Result<(), ExecutionCostError> {
        if self.contract_major != EXECUTION_COST_CONTRACT_MAJOR {
            return Err(ExecutionCostError("unsupported contract major"));
        }
        if self.groups.is_empty() || self.groups.len() > MAXIMUM_EXECUTION_GROUPS {
            return Err(ExecutionCostError("group count is out of bounds"));
        }
        let mut total = 0_u64;
        let mut step_count = 0_usize;
        let mut previous_step: Option<ExecutionStep> = None;
        let mut previous_group: Option<ExecutionGroup> = None;
        for group in &self.groups {
            if previous_group.is_some_and(|previous| previous >= group.group) {
                return Err(ExecutionCostError("groups are not unique and ordered"));
            }
            previous_group = Some(group.group);
            if group.steps.is_empty() {
                return Err(ExecutionCostError("a group has no steps"));
            }
            let mut sum = 0_u64;
            for step in &group.steps {
                step_count += 1;
                if step.step.group() != group.group {
                    return Err(ExecutionCostError("a step is outside its group"));
                }
                if previous_step.is_some_and(|previous| previous >= step.step) {
                    return Err(ExecutionCostError("steps are not unique and ordered"));
                }
                previous_step = Some(step.step);
                if step.counters.len() > MAXIMUM_STEP_COUNTERS
                    || step.counters.windows(2).any(|pair| pair[0].0 >= pair[1].0)
                {
                    return Err(ExecutionCostError(
                        "step counters are not bounded and unique",
                    ));
                }
                sum = sum
                    .checked_add(step.duration_us)
                    .ok_or(ExecutionCostError("group duration overflows"))?;
            }
            if sum != group.duration_us {
                return Err(ExecutionCostError("group duration differs from its steps"));
            }
            total = total
                .checked_add(group.duration_us)
                .ok_or(ExecutionCostError("total duration overflows"))?;
        }
        if step_count > MAXIMUM_EXECUTION_STEPS {
            return Err(ExecutionCostError("step count is out of bounds"));
        }
        if total != self.total_us {
            return Err(ExecutionCostError("total differs from its groups"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecutionProgress<'a> {
    Started {
        plan: &'static [ExecutionStep],
    },
    StepCompleted {
        step: &'a StepCost,
        completed_steps: u32,
        measured_total_us: u64,
        elapsed_us: u64,
    },
}

type ProgressSink<'a> = Box<dyn FnMut(ExecutionProgress<'_>) + 'a>;

pub struct ExecutionCostCollector<'a> {
    started_at: Option<Instant>,
    plan: &'static [ExecutionStep],
    open: Option<(ExecutionStep, Instant)>,
    excluded: std::time::Duration,
    steps: Vec<StepCost>,
    measured_total_us: u64,
    consistent: bool,
    progress: Option<ProgressSink<'a>>,
}

impl Default for ExecutionCostCollector<'_> {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> ExecutionCostCollector<'a> {
    pub fn new() -> Self {
        Self {
            started_at: None,
            plan: &[],
            open: None,
            excluded: std::time::Duration::ZERO,
            steps: Vec::new(),
            measured_total_us: 0,
            consistent: true,
            progress: None,
        }
    }

    pub fn with_progress(progress: impl FnMut(ExecutionProgress<'_>) + 'a) -> Self {
        Self {
            progress: Some(Box::new(progress)),
            ..Self::new()
        }
    }

    pub fn finish(self) -> Option<ExecutionCostSummary> {
        if !self.consistent
            || self.started_at.is_none()
            || self.open.is_some()
            || self.steps.len() != self.plan.len()
        {
            return None;
        }
        let mut groups: Vec<GroupCost> = Vec::new();
        for step in self.steps {
            let group = step.step.group();
            match groups.last_mut() {
                Some(last) if last.group == group => {
                    last.duration_us = last.duration_us.saturating_add(step.duration_us);
                    last.steps.push(step);
                }
                _ => groups.push(GroupCost {
                    group,
                    duration_us: step.duration_us,
                    steps: vec![step],
                }),
            }
        }
        let summary = ExecutionCostSummary {
            contract_major: EXECUTION_COST_CONTRACT_MAJOR,
            contract_minor: EXECUTION_COST_CONTRACT_MINOR,
            total_us: groups.iter().fold(0_u64, |total, group| {
                total.saturating_add(group.duration_us)
            }),
            groups,
        };
        summary.validate().ok().map(|()| summary)
    }
}

fn elapsed_us(since: Instant, now: Instant) -> u64 {
    u64::try_from(now.saturating_duration_since(since).as_micros()).unwrap_or(u64::MAX)
}

impl ExecutionObserver for ExecutionCostCollector<'_> {
    fn execution_started(&mut self, plan: &'static [ExecutionStep]) {
        if self.started_at.is_some() || plan.is_empty() || plan.len() > MAXIMUM_EXECUTION_STEPS {
            self.consistent = false;
            return;
        }
        self.started_at = Some(Instant::now());
        self.plan = plan;
        if let Some(progress) = self.progress.as_mut() {
            progress(ExecutionProgress::Started { plan });
        }
    }

    fn step_started(&mut self, step: ExecutionStep) {
        let in_plan_order = self.plan.contains(&step)
            && self
                .steps
                .last()
                .is_none_or(|previous| previous.step < step);
        if self.started_at.is_none() || self.open.is_some() || !in_plan_order {
            self.consistent = false;
            return;
        }
        self.excluded = std::time::Duration::ZERO;
        self.open = Some((step, Instant::now()));
    }

    fn step_finished(&mut self, step: ExecutionStep, counters: &[(ExecutionCounter, u64)]) {
        let now = Instant::now();
        let Some((open, started)) = self.open.take() else {
            self.consistent = false;
            return;
        };
        if open != step || counters.len() > MAXIMUM_STEP_COUNTERS {
            self.consistent = false;
            return;
        }
        let mut counters = counters.to_vec();
        counters.sort_unstable_by_key(|(counter, _)| *counter);
        if counters.windows(2).any(|pair| pair[0].0 == pair[1].0) {
            self.consistent = false;
            return;
        }
        let duration_us = elapsed_us(started, now).saturating_sub(
            u64::try_from(std::mem::take(&mut self.excluded).as_micros()).unwrap_or(u64::MAX),
        );
        self.measured_total_us = self.measured_total_us.saturating_add(duration_us);
        self.steps.push(StepCost {
            step,
            duration_us,
            counters,
        });
        if let (Some(progress), Some(started_at), Some(completed)) =
            (self.progress.as_mut(), self.started_at, self.steps.last())
        {
            progress(ExecutionProgress::StepCompleted {
                step: completed,
                completed_steps: u32::try_from(self.steps.len()).unwrap_or(u32::MAX),
                measured_total_us: self.measured_total_us,
                elapsed_us: elapsed_us(started_at, Instant::now()),
            });
        }
    }

    fn exclude_observation(&mut self, duration: std::time::Duration) {
        if self.open.is_some() {
            self.excluded = self.excluded.saturating_add(duration);
        }
    }
}

pub fn observe_exact_script_parse<E>(
    observer: &mut dyn ExecutionObserver,
    parse: impl FnOnce() -> Result<rms_semantics::SemanticProgram, E>,
) -> Result<rms_semantics::SemanticProgram, E> {
    observer.execution_started(&EXACT_EXECUTION_PLAN);
    observer.step_started(ExecutionStep::ParseScript);
    let program = parse()?;
    observer.step_finished(
        ExecutionStep::ParseScript,
        &[
            (
                ExecutionCounter::Operations,
                program.operations.len() as u64,
            ),
            (
                ExecutionCounter::RngDraws,
                program.rng_state_after_parser.draws(),
            ),
        ],
    );
    Ok(program)
}
