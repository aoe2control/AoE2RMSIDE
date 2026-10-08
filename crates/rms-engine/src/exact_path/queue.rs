#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Entry {
    pub(crate) node: u32,
    priority: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Queue {
    buckets: Vec<Vec<Entry>>,
    minimum: Option<usize>,
    count: usize,
    bucket_limit: usize,
    entry_limit: usize,
}

impl Queue {
    pub(crate) fn new(bucket_limit: usize, entry_limit: usize) -> Self {
        Self {
            buckets: Vec::new(),
            minimum: None,
            count: 0,
            bucket_limit,
            entry_limit,
        }
    }

    pub(crate) fn push(
        &mut self,
        node: u32,
        cost: f32,
        heuristic: f32,
    ) -> Result<(), &'static str> {
        let priority = cost + heuristic;
        if !cost.is_finite()
            || !heuristic.is_finite()
            || cost < 0.0
            || heuristic < 0.0
            || !priority.is_finite()
            || priority >= 2_147_483_648.0
        {
            return Err("path priority outside the finite distance domain");
        }
        let bucket_index = (priority as i32) as usize;
        if bucket_index >= self.bucket_limit || self.count >= self.entry_limit {
            return Err("path queue work bound exceeded");
        }
        self.buckets
            .resize_with(self.buckets.len().max(bucket_index + 1), Vec::new);
        let bucket = &mut self.buckets[bucket_index];
        let entry = Entry { node, priority };
        if self.minimum == Some(bucket_index) {
            let mut insertion = bucket.len();
            while insertion > 0 && bucket[insertion - 1].priority <= priority {
                insertion -= 1;
            }
            bucket.insert(insertion, entry);
        } else {
            bucket.push(entry);
            if self.minimum.is_none_or(|minimum| bucket_index < minimum) {
                self.minimum = Some(bucket_index);
            }
        }
        self.count += 1;
        Ok(())
    }

    pub(crate) fn pop(&mut self) -> Option<Entry> {
        let minimum = self.minimum?;
        let result = self.buckets[minimum]
            .pop()
            .expect("active bucket is nonempty");
        self.count -= 1;
        if self.buckets[minimum].is_empty() {
            self.minimum =
                (minimum + 1..self.buckets.len()).find(|index| !self.buckets[*index].is_empty());
            if let Some(next) = self.minimum {
                let bucket = &mut self.buckets[next];
                let budget = bucket.len();
                sort_descending(bucket, budget);
            }
        }
        Some(result)
    }
}

fn sort_descending(mut entries: &mut [Entry], mut budget: usize) {
    while entries.len() > 32 {
        if budget == 0 {
            heap_sort(entries);
            return;
        }
        let (equal_start, equal_end) = partition(entries);
        budget = (budget >> 2) + (budget >> 1);
        if equal_start < entries.len() - equal_end {
            sort_descending(&mut entries[..equal_start], budget);
            entries = &mut entries[equal_end..];
        } else {
            sort_descending(&mut entries[equal_end..], budget);
            entries = &mut entries[..equal_start];
        }
    }
    for next in 1..entries.len() {
        let value = entries[next];
        let mut hole = next;
        while hole > 0 && value.priority > entries[hole - 1].priority {
            entries[hole] = entries[hole - 1];
            hole -= 1;
        }
        entries[hole] = value;
    }
}

fn median_three(entries: &mut [Entry], first: usize, middle: usize, last: usize) {
    if entries[middle].priority > entries[first].priority {
        entries.swap(first, middle);
    }
    if entries[last].priority > entries[middle].priority {
        entries.swap(middle, last);
        if entries[middle].priority > entries[first].priority {
            entries.swap(first, middle);
        }
    }
}

fn choose_pivot(entries: &mut [Entry]) {
    let last = entries.len() - 1;
    let middle = entries.len() / 2;
    if entries.len() <= 41 {
        median_three(entries, 0, middle, last);
    } else {
        let step = entries.len() / 8;
        median_three(entries, 0, step, 2 * step);
        median_three(entries, middle - step, middle, middle + step);
        median_three(entries, last - 2 * step, last - step, last);
        median_three(entries, step, middle, last - step);
    }
}

fn partition(entries: &mut [Entry]) -> (usize, usize) {
    choose_pivot(entries);
    let mut equal_start = entries.len() / 2;
    let mut equal_end = equal_start + 1;
    let priority = entries[equal_start].priority;
    while equal_start > 0 && entries[equal_start - 1].priority == priority {
        equal_start -= 1;
    }
    while equal_end < entries.len() && entries[equal_end].priority == priority {
        equal_end += 1;
    }
    let mut left = equal_start;
    let mut right = equal_end;
    loop {
        while right < entries.len() && entries[right].priority <= priority {
            if entries[right].priority == priority {
                entries.swap(equal_end, right);
                equal_end += 1;
            }
            right += 1;
        }
        while left > 0 && entries[left - 1].priority >= priority {
            if entries[left - 1].priority == priority {
                equal_start -= 1;
                entries.swap(equal_start, left - 1);
            }
            left -= 1;
        }
        if left == 0 && right == entries.len() {
            return (equal_start, equal_end);
        }
        if left == 0 {
            if equal_end != right {
                entries.swap(equal_start, equal_end);
            }
            equal_end += 1;
            entries.swap(equal_start, right);
            equal_start += 1;
            right += 1;
        } else if right == entries.len() {
            left -= 1;
            equal_start -= 1;
            entries.swap(left, equal_start);
            equal_end -= 1;
            entries.swap(equal_start, equal_end);
        } else {
            left -= 1;
            entries.swap(left, right);
            right += 1;
        }
    }
}

fn heap_sort(entries: &mut [Entry]) {
    for root in (0..entries.len() / 2).rev() {
        let value = entries[root];
        heap_replace(entries, root, value);
    }
    for end in (1..entries.len()).rev() {
        let value = entries[end];
        entries[end] = entries[0];
        heap_replace(&mut entries[..end], 0, value);
    }
}

fn heap_replace(entries: &mut [Entry], root: usize, value: Entry) {
    let count = entries.len();
    let last_parent = (count - 1) / 2;
    let mut hole = root;
    while hole < last_parent {
        let left = 2 * hole + 1;
        let right = left + 1;
        let child = if entries[right].priority <= entries[left].priority {
            right
        } else {
            left
        };
        entries[hole] = entries[child];
        hole = child;
    }
    if hole == last_parent && count.is_multiple_of(2) {
        entries[hole] = entries[count - 1];
        hole = count - 1;
    }
    while hole > root {
        let parent = (hole - 1) / 2;
        if entries[parent].priority <= value.priority {
            break;
        }
        entries[hole] = entries[parent];
        hole = parent;
    }
    entries[hole] = value;
}
