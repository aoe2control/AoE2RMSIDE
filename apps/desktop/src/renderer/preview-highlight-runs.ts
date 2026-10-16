const runsCache = new WeakMap<readonly number[], { width: number; runs: Int32Array }>();

export function highlightTileRuns(tileIndices: readonly number[], width: number): Int32Array {
  const cached = runsCache.get(tileIndices);
  if (cached && cached.width === width) return cached.runs;
  const runs = buildHighlightTileRuns(tileIndices, width);
  runsCache.set(tileIndices, { width, runs });
  return runs;
}

function buildHighlightTileRuns(tileIndices: readonly number[], width: number): Int32Array {
  if (!(width > 0) || tileIndices.length === 0) return new Int32Array(0);
  const sorted = new Float64Array(tileIndices.length);
  let count = 0;
  for (const tile of tileIndices) {
    if (Number.isInteger(tile) && tile >= 0) sorted[count++] = tile;
  }
  const tiles = sorted.subarray(0, count).sort();
  const runs: number[] = [];
  let index = 0;
  while (index < tiles.length) {
    const first = tiles[index]!;
    const y = Math.floor(first / width);
    const rowEnd = (y + 1) * width;
    let last = first;
    index += 1;
    while (index < tiles.length) {
      const next = tiles[index]!;
      if (next === last) {
        index += 1;
        continue;
      }
      if (next !== last + 1 || next >= rowEnd) break;
      last = next;
      index += 1;
    }
    runs.push(y, first - y * width, last - y * width + 1);
  }
  return Int32Array.from(runs);
}
