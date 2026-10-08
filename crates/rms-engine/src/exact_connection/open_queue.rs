use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::placement_oracle::{self, AcceleratorFault, OracleCheck, PlacementCheckMode};

#[derive(Clone, Debug, Default)]
struct OpenNode {
    queued: bool,
    previous: Option<usize>,
    next: Option<usize>,
    cumulative_cost_bits: u32,
    priority_bits: u32,
}

pub(super) struct ReferenceOpenQueue {
    head: Option<usize>,
    nodes: Vec<OpenNode>,
}

impl ReferenceOpenQueue {
    pub(super) fn new(tile_count: usize) -> Self {
        Self {
            head: None,
            nodes: vec![OpenNode::default(); tile_count],
        }
    }

    pub(super) fn insert(&mut self, index: usize, cumulative_cost: f32, priority: f32) {
        self.remove(index);
        let mut previous = None;
        let mut current = self.head;
        while let Some(current_index) = current {
            if f32::from_bits(self.nodes[current_index].priority_bits) >= priority {
                break;
            }
            previous = current;
            current = self.nodes[current_index].next;
        }
        self.nodes[index].queued = true;
        self.nodes[index].previous = previous;
        self.nodes[index].next = current;
        self.nodes[index].cumulative_cost_bits = cumulative_cost.to_bits();
        self.nodes[index].priority_bits = priority.to_bits();
        if let Some(previous) = previous {
            self.nodes[previous].next = Some(index);
        } else {
            self.head = Some(index);
        }
        if let Some(current) = current {
            self.nodes[current].previous = Some(index);
        }
    }

    fn remove(&mut self, index: usize) {
        if !self.nodes[index].queued {
            return;
        }
        let previous = self.nodes[index].previous;
        let next = self.nodes[index].next;
        if let Some(previous) = previous {
            self.nodes[previous].next = next;
        } else {
            self.head = next;
        }
        if let Some(next) = next {
            self.nodes[next].previous = previous;
        }
        self.nodes[index].queued = false;
        self.nodes[index].previous = None;
        self.nodes[index].next = None;
    }

    pub(super) fn pop(&mut self) -> Option<(usize, f32)> {
        let index = self.head?;
        let cumulative = f32::from_bits(self.nodes[index].cumulative_cost_bits);
        self.remove(index);
        Some((index, cumulative))
    }
}

#[derive(Clone, Copy, Debug)]
struct HeapEntry {
    priority: f32,
    cumulative_bits: u32,
    sequence: u32,
    index: u32,
}

impl HeapEntry {
    fn pop_order(&self, other: &Self) -> Ordering {
        let newer_first = if placement_oracle::fault() == AcceleratorFault::PathQueueOldestTieFirst
        {
            other.sequence.cmp(&self.sequence)
        } else {
            self.sequence.cmp(&other.sequence)
        };
        other
            .priority
            .partial_cmp(&self.priority)
            .expect("heap priorities are never NaN")
            .then(newer_first)
    }
}

impl PartialEq for HeapEntry {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for HeapEntry {}

impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        self.pop_order(other)
    }
}

pub(super) struct HeapOpenQueue {
    heap: BinaryHeap<HeapEntry>,
    live_sequence: Vec<u32>,
    next_sequence: u32,
    fallback: Option<ReferenceOpenQueue>,
}

impl HeapOpenQueue {
    pub(super) fn new(tile_count: usize) -> Self {
        Self {
            heap: BinaryHeap::new(),
            live_sequence: vec![0; tile_count],
            next_sequence: 1,
            fallback: None,
        }
    }

    pub(super) fn insert(&mut self, index: usize, cumulative_cost: f32, priority: f32) {
        if self.fallback.is_none()
            && (priority.is_nan() || self.next_sequence == u32::MAX || index > u32::MAX as usize)
        {
            self.convert_to_list();
        }
        if let Some(list) = &mut self.fallback {
            list.insert(index, cumulative_cost, priority);
            return;
        }
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.live_sequence[index] = sequence;
        self.heap.push(HeapEntry {
            priority,
            cumulative_bits: cumulative_cost.to_bits(),
            sequence,
            index: index as u32,
        });
    }

    pub(super) fn pop(&mut self) -> Option<(usize, f32)> {
        if let Some(list) = &mut self.fallback {
            return list.pop();
        }
        while let Some(entry) = self.heap.pop() {
            let index = entry.index as usize;
            if self.live_sequence[index] != entry.sequence {
                continue;
            }
            self.live_sequence[index] = 0;
            return Some((index, f32::from_bits(entry.cumulative_bits)));
        }
        None
    }

    fn convert_to_list(&mut self) {
        let mut list = ReferenceOpenQueue::new(self.live_sequence.len());
        let mut live: Vec<HeapEntry> = std::mem::take(&mut self.heap)
            .into_vec()
            .into_iter()
            .filter(|entry| self.live_sequence[entry.index as usize] == entry.sequence)
            .collect();
        live.sort_unstable_by(|left, right| right.cmp(left));
        let mut tail: Option<usize> = None;
        for entry in live {
            let index = entry.index as usize;
            list.nodes[index] = OpenNode {
                queued: true,
                previous: tail,
                next: None,
                cumulative_cost_bits: entry.cumulative_bits,
                priority_bits: entry.priority.to_bits(),
            };
            match tail {
                Some(previous) => list.nodes[previous].next = Some(index),
                None => list.head = Some(index),
            }
            tail = Some(index);
        }
        self.live_sequence
            .iter_mut()
            .for_each(|sequence| *sequence = 0);
        self.fallback = Some(list);
    }
}

pub(super) enum PathOpenQueue {
    Accelerated(HeapOpenQueue),
    Reference(ReferenceOpenQueue),
    Differential(HeapOpenQueue, ReferenceOpenQueue),
}

impl PathOpenQueue {
    pub(super) fn new(tile_count: usize) -> Self {
        match placement_oracle::mode() {
            PlacementCheckMode::Accelerated => Self::Accelerated(HeapOpenQueue::new(tile_count)),
            PlacementCheckMode::Reference => Self::Reference(ReferenceOpenQueue::new(tile_count)),
            PlacementCheckMode::Differential => Self::Differential(
                HeapOpenQueue::new(tile_count),
                ReferenceOpenQueue::new(tile_count),
            ),
        }
    }

    pub(super) fn insert(&mut self, index: usize, cumulative_cost: f32, priority: f32) {
        match self {
            Self::Accelerated(heap) => heap.insert(index, cumulative_cost, priority),
            Self::Reference(list) => list.insert(index, cumulative_cost, priority),
            Self::Differential(heap, list) => {
                heap.insert(index, cumulative_cost, priority);
                list.insert(index, cumulative_cost, priority);
            }
        }
    }

    pub(super) fn pop(&mut self) -> Option<(usize, f32)> {
        match self {
            Self::Accelerated(heap) => heap.pop(),
            Self::Reference(list) => list.pop(),
            Self::Differential(heap, list) => {
                let accelerated = heap.pop().map(|(index, cost)| (index, cost.to_bits()));
                let reference = list.pop().map(|(index, cost)| (index, cost.to_bits()));
                placement_oracle::compare(OracleCheck::PathQueue, &reference, &accelerated, || {
                    "path open-queue pop (node, cumulative cost bits)".to_owned()
                });
                reference.map(|(index, bits)| (index, f32::from_bits(bits)))
            }
        }
    }
}
