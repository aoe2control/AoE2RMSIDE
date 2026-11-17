use rms_content::TerrainId;

use crate::{PlacedObject, VisualStage, VisualState};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationEdge {
    Before,
    After,
}

#[derive(Clone, Copy, Debug)]
pub struct OperationBoundary<'a> {
    pub edge: OperationEdge,
    pub stage: VisualStage,
    pub operations: &'a [u32],
    pub state: VisualState<'a>,
    pub tile_operations: &'a [u32],
    pub object_operations: &'a [u32],
    pub cliff_operations: &'a [u32],
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct StageView<'a> {
    pub terrain: &'a [TerrainId],
    pub elevation: Option<&'a [i16]>,
    pub tile_operations: &'a [u32],
    pub objects: &'a [PlacedObject],
    pub object_operations: &'a [u32],
}

pub(crate) trait StageObserver {
    fn substage(&mut self, _view: &StageView<'_>) {}
    fn boundaries_enabled(&self) -> bool {
        false
    }
    fn boundary(&mut self, _edge: OperationEdge, _operation: u32, _view: &StageView<'_>) {}
}

pub(crate) struct NoStageObserver;

impl StageObserver for NoStageObserver {}

pub(crate) fn operation_run_edges(operations: &[u32], index: usize) -> (bool, bool) {
    let operation = operations[index];
    let first = index == 0 || operations[index - 1] != operation;
    let last = operations.get(index + 1) != Some(&operation);
    (first, last)
}
