pub const MAXIMUM_TILE_WRITE_RUNS: usize = 524_288;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct TileWriteRun {
    pub operation_index: u32,
    pub first_tile: u32,
    pub tile_count: u32,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TileWriteRecorder {
    runs: Vec<TileWriteRun>,
    overflowed: bool,
}

impl TileWriteRecorder {
    pub fn record_changes(&mut self, before: Option<&[u32]>, after: &[u32]) {
        if self.overflowed {
            return;
        }
        let mut open: Option<TileWriteRun> = None;
        for (index, &operation_index) in after.iter().enumerate() {
            let written = operation_index != u32::MAX
                && before.is_none_or(|before| before.get(index) != Some(&operation_index));
            if !written {
                if let Some(run) = open.take() {
                    self.push(run);
                }
                continue;
            }
            let tile = index as u32;
            match open.as_mut() {
                Some(run)
                    if run.operation_index == operation_index
                        && run.first_tile + run.tile_count == tile =>
                {
                    run.tile_count += 1;
                }
                _ => {
                    if let Some(run) = open.replace(TileWriteRun {
                        operation_index,
                        first_tile: tile,
                        tile_count: 1,
                    }) {
                        self.push(run);
                    }
                }
            }
        }
        if let Some(run) = open {
            self.push(run);
        }
    }

    pub fn extend(&mut self, other: &TileWriteRecorder) {
        if other.overflowed {
            self.overflowed = true;
            self.runs = Vec::new();
            return;
        }
        for run in &other.runs {
            self.push(*run);
        }
    }

    fn push(&mut self, run: TileWriteRun) {
        if self.overflowed {
            return;
        }
        if self.runs.len() >= MAXIMUM_TILE_WRITE_RUNS {
            self.overflowed = true;
            self.runs = Vec::new();
            return;
        }
        self.runs.push(run);
    }

    pub fn finish(mut self, final_operations: &[u32]) -> Option<Vec<TileWriteRun>> {
        if self.overflowed {
            return None;
        }
        self.runs.sort_unstable();
        let mut merged: Vec<TileWriteRun> = Vec::with_capacity(self.runs.len());
        for run in self.runs {
            if let Some(last) = merged.last_mut()
                && last.operation_index == run.operation_index
                && run.first_tile <= last.first_tile + last.tile_count
            {
                let end = (last.first_tile + last.tile_count).max(run.first_tile + run.tile_count);
                last.tile_count = end - last.first_tile;
                continue;
            }
            merged.push(run);
        }
        let mut published = Vec::with_capacity(merged.len());
        for run in merged {
            let mut open: Option<TileWriteRun> = None;
            for tile in run.first_tile..run.first_tile + run.tile_count {
                let owned = final_operations.get(tile as usize) == Some(&run.operation_index);
                match (&mut open, owned) {
                    (Some(current), false) => current.tile_count += 1,
                    (None, false) => {
                        open = Some(TileWriteRun {
                            operation_index: run.operation_index,
                            first_tile: tile,
                            tile_count: 1,
                        });
                    }
                    (_, true) => {
                        if let Some(current) = open.take() {
                            published.push(current);
                        }
                    }
                }
            }
            if let Some(current) = open {
                published.push(current);
            }
            if published.len() > MAXIMUM_TILE_WRITE_RUNS {
                return None;
            }
        }
        Some(published)
    }
}
