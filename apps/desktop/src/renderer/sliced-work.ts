import { useEffect, useLayoutEffect, useState } from 'react';

export interface SlicedWork {
  run(shouldYield: () => boolean): boolean;
}

export const workSliceMilliseconds = 4;

export function sliceDeadline(
  budget: number,
  now: () => number = () => performance.now(),
): () => boolean {
  const end = now() + budget;
  return () => now() >= end;
}

export type TaskQueue = (task: () => void) => void;

export function messageChannelQueue(): TaskQueue {
  const channel = new MessageChannel();
  const tasks: (() => void)[] = [];
  channel.port1.onmessage = () => tasks.shift()?.();
  return (task) => {
    tasks.push(task);
    channel.port2.postMessage(null);
  };
}

let sharedQueue: TaskQueue | null = null;

export function runInSlices(
  work: SlicedWork,
  onDone: () => void,
  options: { budget?: number; queue?: TaskQueue; now?: () => number } = {},
): () => void {
  const queue = options.queue ?? (sharedQueue ??= messageChannelQueue());
  const budget = options.budget ?? workSliceMilliseconds;
  let stopped = false;
  const slice = () => {
    if (stopped) return;
    if (work.run(sliceDeadline(budget, options.now))) onDone();
    else queue(slice);
  };
  queue(slice);
  return () => {
    stopped = true;
  };
}

export function useFinishedWork<T extends SlicedWork>(work: T | null): T | null {
  const [finished, setFinished] = useState<T | null>(null);
  useLayoutEffect(() => {
    if (!work) return undefined;
    if (work.run(sliceDeadline(workSliceMilliseconds))) {
      setFinished(work);
      return undefined;
    }
    return runInSlices(work, () => setFinished(work));
  }, [work]);
  return finished;
}

export function initiallyMountedRows(
  previousMounted: number,
  total: number,
  first: number,
): number {
  return Math.min(total, Math.max(previousMounted, first));
}

export function useRowsMountedInFrames(
  rows: readonly unknown[],
  first: number,
  step: number,
): number {
  const [state, setState] = useState(() => ({
    rows,
    mounted: initiallyMountedRows(0, rows.length, first),
  }));
  let mounted = state.mounted;
  if (state.rows !== rows) {
    mounted = initiallyMountedRows(Math.min(state.mounted, state.rows.length), rows.length, first);
    setState({ rows, mounted });
  }
  const total = rows.length;
  useEffect(() => {
    if (mounted >= total) return undefined;
    const frame = requestAnimationFrame(() =>
      setState((current) =>
        current.rows === rows
          ? { rows, mounted: Math.min(total, current.mounted + Math.max(1, step)) }
          : current,
      ),
    );
    return () => cancelAnimationFrame(frame);
  }, [mounted, rows, step, total]);
  return Math.min(mounted, total);
}
