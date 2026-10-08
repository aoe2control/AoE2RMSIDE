export function rovingKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0 || index < 0 || index >= count) return null;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

export function nextPaneIndex(
  current: number,
  available: readonly boolean[],
  backward: boolean,
): number | null {
  const count = available.length;
  if (!available.some(Boolean)) return null;
  const step = backward ? -1 : 1;
  let index = current < 0 ? (backward ? count : -1) : current;
  for (let tries = 0; tries < count; tries += 1) {
    index = (index + step + count) % count;
    if (available[index]) return index;
  }
  return null;
}
