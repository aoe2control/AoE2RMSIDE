#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlacementCheckMode {
    Accelerated,
    Reference,
    Differential,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OracleCheck {
    Obstruction,
    RosterObstruction,
    ActorArea,
    ClassFilter,
    PathQueue,
    LifecycleProjection,
    ListClassFilter,
    AppearanceWindow,
    PathWalkable,
    AppearanceObstruction,
    ConnectionPaint,
    PlacedClassWindow,
    ClassFilterMaster,
    ClosestOrder,
    CandidateMaskQueue,
    CandidateMaskSample,
    ClosestQueue,
    GroupMaster,
    WeightedSample,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DifferentialReport {
    pub obstruction_decisions: u64,
    pub roster_obstruction_decisions: u64,
    pub actor_area_decisions: u64,
    pub class_filter_decisions: u64,
    pub path_queue_pops: u64,
    pub lifecycle_projections: u64,
    pub list_class_filter_decisions: u64,
    pub appearance_window_decisions: u64,
    pub walkable_refreshes: u64,
    pub appearance_obstruction_decisions: u64,
    pub connection_paints: u64,
    pub placed_class_window_decisions: u64,
    pub class_filter_master_resolutions: u64,
    pub closest_orderings: u64,
    pub candidate_mask_queues: u64,
    pub candidate_mask_samples: u64,
    pub closest_queues: u64,
    pub group_masters: u64,
    pub weighted_samples: u64,
    pub mismatches: u64,
    pub first_mismatch: Option<String>,
}

impl DifferentialReport {
    pub fn decisions(&self) -> u64 {
        self.obstruction_decisions
            .saturating_add(self.roster_obstruction_decisions)
            .saturating_add(self.actor_area_decisions)
            .saturating_add(self.class_filter_decisions)
            .saturating_add(self.path_queue_pops)
            .saturating_add(self.lifecycle_projections)
            .saturating_add(self.list_class_filter_decisions)
            .saturating_add(self.appearance_window_decisions)
            .saturating_add(self.walkable_refreshes)
            .saturating_add(self.appearance_obstruction_decisions)
            .saturating_add(self.connection_paints)
            .saturating_add(self.placed_class_window_decisions)
            .saturating_add(self.class_filter_master_resolutions)
            .saturating_add(self.closest_orderings)
            .saturating_add(self.candidate_mask_queues)
            .saturating_add(self.candidate_mask_samples)
            .saturating_add(self.closest_queues)
            .saturating_add(self.group_masters)
            .saturating_add(self.weighted_samples)
    }

    pub fn accumulate(&mut self, other: &Self) {
        self.obstruction_decisions = self
            .obstruction_decisions
            .saturating_add(other.obstruction_decisions);
        self.roster_obstruction_decisions = self
            .roster_obstruction_decisions
            .saturating_add(other.roster_obstruction_decisions);
        self.actor_area_decisions = self
            .actor_area_decisions
            .saturating_add(other.actor_area_decisions);
        self.class_filter_decisions = self
            .class_filter_decisions
            .saturating_add(other.class_filter_decisions);
        self.path_queue_pops = self.path_queue_pops.saturating_add(other.path_queue_pops);
        self.lifecycle_projections = self
            .lifecycle_projections
            .saturating_add(other.lifecycle_projections);
        self.list_class_filter_decisions = self
            .list_class_filter_decisions
            .saturating_add(other.list_class_filter_decisions);
        self.appearance_window_decisions = self
            .appearance_window_decisions
            .saturating_add(other.appearance_window_decisions);
        self.walkable_refreshes = self
            .walkable_refreshes
            .saturating_add(other.walkable_refreshes);
        self.appearance_obstruction_decisions = self
            .appearance_obstruction_decisions
            .saturating_add(other.appearance_obstruction_decisions);
        self.connection_paints = self
            .connection_paints
            .saturating_add(other.connection_paints);
        self.placed_class_window_decisions = self
            .placed_class_window_decisions
            .saturating_add(other.placed_class_window_decisions);
        self.class_filter_master_resolutions = self
            .class_filter_master_resolutions
            .saturating_add(other.class_filter_master_resolutions);
        self.closest_orderings = self
            .closest_orderings
            .saturating_add(other.closest_orderings);
        self.candidate_mask_queues = self
            .candidate_mask_queues
            .saturating_add(other.candidate_mask_queues);
        self.candidate_mask_samples = self
            .candidate_mask_samples
            .saturating_add(other.candidate_mask_samples);
        self.closest_queues = self.closest_queues.saturating_add(other.closest_queues);
        self.group_masters = self.group_masters.saturating_add(other.group_masters);
        self.weighted_samples = self.weighted_samples.saturating_add(other.weighted_samples);
        self.mismatches = self.mismatches.saturating_add(other.mismatches);
        if self.first_mismatch.is_none() {
            self.first_mismatch.clone_from(&other.first_mismatch);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MismatchPolicy {
    Panic,
    Record,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcceleratorFault {
    None,
    ObstructionIgnoresFootprints,
    ActorAreaIgnoresRadius,
    PathQueueOldestTieFirst,
    LifecycleProjectionIgnoresChanges,
    ListClassFilterIgnoresWindow,
    ActorAreaIdBucketsMisfiled,
    AppearanceClassIndexIgnoresWindow,
    LiveClassCountsIgnoreSurvivors,
    WalkableIgnoresTerrainChanges,
    WindowSumsDropLastRow,
    ClassFilterMasterCachesGroups,
    AvoidListResolvesStale,
    ClosestOrderReversesTies,
    ClassMaskShrinksWindow,
    AvoidMaskSkipsNewestArea,
    ClosestQueueReversesTies,
    GroupMastersShiftSamples,
}

#[cfg(not(any(test, feature = "placement-oracle")))]
#[inline(always)]
pub(crate) fn mode() -> PlacementCheckMode {
    PlacementCheckMode::Accelerated
}

#[cfg(not(any(test, feature = "placement-oracle")))]
#[inline(always)]
pub(crate) fn fault() -> AcceleratorFault {
    AcceleratorFault::None
}

#[cfg(not(any(test, feature = "placement-oracle")))]
#[inline(always)]
pub(crate) fn compare<T: PartialEq + std::fmt::Debug>(
    _check: OracleCheck,
    _reference: &T,
    _accelerated: &T,
    _context: impl FnOnce() -> String,
) {
}

#[cfg(any(test, feature = "placement-oracle"))]
pub(crate) use switch::{compare, fault, mode};
#[cfg(any(test, feature = "placement-oracle"))]
pub use switch::{process_report, set_process_mode, set_process_policy, with_fault, with_mode};

#[cfg(any(test, feature = "placement-oracle"))]
mod switch {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU8, Ordering};

    const DEFAULT_MODE: PlacementCheckMode = if cfg!(test) {
        PlacementCheckMode::Differential
    } else {
        PlacementCheckMode::Accelerated
    };

    const fn encode(mode: PlacementCheckMode) -> u8 {
        match mode {
            PlacementCheckMode::Accelerated => 0,
            PlacementCheckMode::Reference => 1,
            PlacementCheckMode::Differential => 2,
        }
    }

    fn decode(value: u8) -> PlacementCheckMode {
        match value {
            1 => PlacementCheckMode::Reference,
            2 => PlacementCheckMode::Differential,
            _ => PlacementCheckMode::Accelerated,
        }
    }

    static PROCESS_MODE: AtomicU8 = AtomicU8::new(encode(DEFAULT_MODE));
    static PROCESS_RECORDS: AtomicU8 = AtomicU8::new(0);
    static PROCESS_REPORT: Mutex<DifferentialReport> = Mutex::new(DifferentialReport {
        obstruction_decisions: 0,
        roster_obstruction_decisions: 0,
        actor_area_decisions: 0,
        class_filter_decisions: 0,
        path_queue_pops: 0,
        lifecycle_projections: 0,
        list_class_filter_decisions: 0,
        appearance_window_decisions: 0,
        walkable_refreshes: 0,
        appearance_obstruction_decisions: 0,
        connection_paints: 0,
        placed_class_window_decisions: 0,
        class_filter_master_resolutions: 0,
        closest_orderings: 0,
        candidate_mask_queues: 0,
        candidate_mask_samples: 0,
        closest_queues: 0,
        group_masters: 0,
        weighted_samples: 0,
        mismatches: 0,
        first_mismatch: None,
    });

    thread_local! {
        static SCOPE: Cell<Option<(PlacementCheckMode, MismatchPolicy)>> = const { Cell::new(None) };
        static FAULT: Cell<AcceleratorFault> = const { Cell::new(AcceleratorFault::None) };
        static REPORT: RefCell<DifferentialReport> = RefCell::new(DifferentialReport::default());
    }

    pub(crate) fn mode() -> PlacementCheckMode {
        SCOPE.with(Cell::get).map_or_else(
            || decode(PROCESS_MODE.load(Ordering::Relaxed)),
            |(mode, _)| mode,
        )
    }

    pub(crate) fn fault() -> AcceleratorFault {
        FAULT.with(Cell::get)
    }

    pub fn set_process_mode(mode: PlacementCheckMode) {
        PROCESS_MODE.store(encode(mode), Ordering::Relaxed);
    }

    pub fn set_process_policy(policy: MismatchPolicy) {
        PROCESS_RECORDS.store(
            u8::from(policy == MismatchPolicy::Record),
            Ordering::Relaxed,
        );
    }

    pub fn process_report() -> DifferentialReport {
        PROCESS_REPORT.lock().map_or_else(
            |poisoned| poisoned.into_inner().clone(),
            |report| report.clone(),
        )
    }

    pub fn with_mode<R>(
        mode: PlacementCheckMode,
        policy: MismatchPolicy,
        work: impl FnOnce() -> R,
    ) -> (R, DifferentialReport) {
        struct Restore {
            scope: Option<(PlacementCheckMode, MismatchPolicy)>,
            report: Option<DifferentialReport>,
        }
        impl Drop for Restore {
            fn drop(&mut self) {
                SCOPE.with(|value| value.set(self.scope));
                if let Some(report) = self.report.take() {
                    REPORT.with(|value| *value.borrow_mut() = report);
                }
            }
        }
        let restore = Restore {
            scope: SCOPE.with(|value| value.replace(Some((mode, policy)))),
            report: Some(REPORT.with(|value| value.replace(DifferentialReport::default()))),
        };
        let result = work();
        let report = REPORT.with(|value| value.borrow().clone());
        drop(restore);
        (result, report)
    }

    pub fn with_fault<R>(fault: AcceleratorFault, work: impl FnOnce() -> R) -> R {
        struct Restore(AcceleratorFault);
        impl Drop for Restore {
            fn drop(&mut self) {
                FAULT.with(|value| value.set(self.0));
            }
        }
        let _restore = Restore(FAULT.with(|value| value.replace(fault)));
        work()
    }

    fn record(report: &mut DifferentialReport, check: OracleCheck, message: Option<&String>) {
        match check {
            OracleCheck::Obstruction => report.obstruction_decisions += 1,
            OracleCheck::RosterObstruction => report.roster_obstruction_decisions += 1,
            OracleCheck::ActorArea => report.actor_area_decisions += 1,
            OracleCheck::ClassFilter => report.class_filter_decisions += 1,
            OracleCheck::PathQueue => report.path_queue_pops += 1,
            OracleCheck::LifecycleProjection => report.lifecycle_projections += 1,
            OracleCheck::ListClassFilter => report.list_class_filter_decisions += 1,
            OracleCheck::AppearanceWindow => report.appearance_window_decisions += 1,
            OracleCheck::PathWalkable => report.walkable_refreshes += 1,
            OracleCheck::AppearanceObstruction => {
                report.appearance_obstruction_decisions += 1;
            }
            OracleCheck::ConnectionPaint => report.connection_paints += 1,
            OracleCheck::PlacedClassWindow => report.placed_class_window_decisions += 1,
            OracleCheck::ClassFilterMaster => report.class_filter_master_resolutions += 1,
            OracleCheck::ClosestOrder => report.closest_orderings += 1,
            OracleCheck::CandidateMaskQueue => report.candidate_mask_queues += 1,
            OracleCheck::CandidateMaskSample => report.candidate_mask_samples += 1,
            OracleCheck::ClosestQueue => report.closest_queues += 1,
            OracleCheck::GroupMaster => report.group_masters += 1,
            OracleCheck::WeightedSample => report.weighted_samples += 1,
        }
        if let Some(message) = message {
            report.mismatches += 1;
            if report.first_mismatch.is_none() {
                report.first_mismatch = Some(message.clone());
            }
        }
    }

    const MARKER: &str = "rmside-placement-oracle-v1";

    pub(crate) fn compare<T: PartialEq + std::fmt::Debug>(
        check: OracleCheck,
        reference: &T,
        accelerated: &T,
        context: impl FnOnce() -> String,
    ) {
        let equal = reference == accelerated;
        let message = (!equal).then(|| {
            format!(
                "{MARKER}: {check:?} accelerator diverged from its reference: reference \
                 {reference:?}, accelerated {accelerated:?}; {}",
                context()
            )
        });
        let policy = match SCOPE.with(Cell::get) {
            Some((_, policy)) => {
                REPORT.with(|value| record(&mut value.borrow_mut(), check, message.as_ref()));
                policy
            }
            None => {
                let mut report = PROCESS_REPORT
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                record(&mut report, check, message.as_ref());
                if PROCESS_RECORDS.load(Ordering::Relaxed) == 1 {
                    MismatchPolicy::Record
                } else {
                    MismatchPolicy::Panic
                }
            }
        };
        if let Some(message) = message
            && policy == MismatchPolicy::Panic
        {
            panic!("{message}");
        }
    }
}
