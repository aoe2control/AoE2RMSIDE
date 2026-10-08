import type * as Contract from '../renderer/latency-probe';
import {
  latencyProfileMarker,
  maximumMarks,
  maximumRecords,
  type RendererCandidate,
  type RendererRun,
  type RendererScene,
  type RendererSnapshot,
} from './records';

const beforeRenderPriority = 0;
const afterRenderPriority = -50;
const inputWindowMilliseconds = 1_000;

const runs = new WeakMap<object, RendererRun>();
const ordered: RendererRun[] = [];
const candidates = new Map<string, RendererCandidate>();
const startup: Record<string, number> = {};
const longTasks: Array<[number, number]> = [];
const longFrames: Array<[number, number, number]> = [];
const inputEvents: RendererSnapshot['inputEvents'] = [];
let sequence = 0;
let lastInput: number | undefined;
let pendingCommit: RendererRun | undefined;
let pendingScene: RendererScene | undefined;
let settlingScene: { scene: RendererScene; committed: number; start?: number } | undefined;
const settleWindowMilliseconds = 2_000;

function run(job: object): RendererRun {
  let current = runs.get(job);
  if (!current) {
    current = { run: ++sequence, requestIds: [], marks: [] };
    runs.set(job, current);
    ordered.push(current);
    if (ordered.length > maximumRecords) ordered.shift();
  }
  return current;
}

function mark(current: RendererRun, name: string, time = performance.now()): void {
  if (
    current.marks.length >= maximumMarks ||
    current.marks.some(([existing]) => existing === name)
  ) {
    return;
  }
  current.marks.push([name, time]);
}

export const runScheduled: typeof Contract.runScheduled = (job) => {
  const current = run(job);
  const time = performance.now();
  if (lastInput !== undefined && time - lastInput <= inputWindowMilliseconds) {
    current.input = lastInput;
  }
  mark(current, 'schedule', time);
};

export const runMark: typeof Contract.runMark = (job, name) => mark(run(job), name);

export const runRequest: typeof Contract.runRequest = (job, clientRequestId) => {
  const current = run(job);
  if (current.requestIds.length < 8 && !current.requestIds.includes(clientRequestId)) {
    current.requestIds.push(clientRequestId);
  }
};

function present(scene: RendererScene, fallback: boolean): void {
  requestAnimationFrame(() => {
    if (scene.present !== undefined) return;
    scene.present = performance.now();
    scene.fallback = fallback;
  });
}

export const runCommitted: typeof Contract.runCommitted = (job) => {
  const current = run(job);
  current.committed = performance.now();
  const scene: RendererScene = {};
  current.scene = scene;
  pendingCommit = current;
  pendingScene = scene;
  settlingScene = { scene, committed: current.committed };
  requestAnimationFrame(() => {
    if (scene.sceneStart === undefined) present(scene, true);
  });
};

function followUpBuild(
  phase: 'start' | 'end',
  ticker: Parameters<typeof Contract.sceneBuild>[1],
): void {
  const settling = settlingScene;
  if (!settling || settling.scene.sceneEnd === undefined) return;
  const time = performance.now();
  if (time - settling.committed > settleWindowMilliseconds) {
    settlingScene = undefined;
    return;
  }
  if (phase === 'start') {
    settling.start ??= time;
    return;
  }
  if (settling.start === undefined) return;
  const rebuilds = (settling.scene.rebuilds ??= []);
  if (rebuilds.length < 32) rebuilds.push([settling.start, time]);
  settling.start = undefined;
  const scene = settling.scene;
  const presentSettled = () =>
    requestAnimationFrame(() => {
      scene.settledPresent = performance.now();
    });
  if (ticker) ticker.addOnce(presentSettled, undefined, afterRenderPriority);
  else presentSettled();
}

export const sceneBuild: typeof Contract.sceneBuild = (phase, ticker) => {
  const scene = pendingScene;
  if (!scene || !pendingCommit) {
    followUpBuild(phase, ticker);
    return;
  }
  if (phase === 'start') {
    scene.sceneStart ??= performance.now();
    return;
  }
  if (scene.sceneStart === undefined || scene.sceneEnd !== undefined) return;
  scene.sceneEnd = performance.now();
  pendingScene = undefined;
  if (!ticker) {
    present(scene, false);
    return;
  }
  ticker.addOnce(
    () => {
      scene.renderStart = performance.now();
    },
    undefined,
    beforeRenderPriority,
  );
  ticker.addOnce(
    () => {
      scene.renderEnd = performance.now();
      present(scene, false);
    },
    undefined,
    afterRenderPriority,
  );
};

export const candidateDrawn: typeof Contract.candidateDrawn = (requestId, drawMilliseconds) => {
  const existing = candidates.get(requestId);
  if (existing) {
    existing.count += 1;
    existing.totalDrawMs += drawMilliseconds;
    return;
  }
  if (candidates.size >= maximumRecords) return;
  const candidate: RendererCandidate = {
    requestId,
    drawn: performance.now(),
    drawMs: drawMilliseconds,
    count: 1,
    totalDrawMs: drawMilliseconds,
  };
  candidates.set(requestId, candidate);
  requestAnimationFrame(() => {
    candidate.present = performance.now();
  });
};

export const startupMark: typeof Contract.startupMark = (name) => {
  startup[name] ??= performance.now();
};

function snapshot(): RendererSnapshot {
  for (const entry of performance.getEntriesByType('paint'))
    startup[entry.name] ??= entry.startTime;
  const navigation = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  if (navigation) {
    startup['dom-content-loaded'] ??= navigation.domContentLoadedEventEnd;
    startup['load'] ??= navigation.loadEventEnd;
  }
  return {
    marker: latencyProfileMarker,
    timeOrigin: performance.timeOrigin,
    runs: ordered.map((current) => structuredClone(current)),
    candidates: [...candidates.values()].map((candidate) => ({ ...candidate })),
    startup: { ...startup },
    longTasks: longTasks.map(([start, duration]) => [start, duration]),
    longFrames: longFrames.map(([start, duration, blocking]) => [start, duration, blocking]),
    inputEvents: inputEvents.map((entry) => ({ ...entry })),
  };
}

for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(
    type,
    (event) => {
      lastInput = event.timeStamp;
    },
    { capture: true, passive: true },
  );
}

function observe(type: string, record: (entry: PerformanceEntry) => void): void {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record(entry);
    }).observe({ type, buffered: true });
  } catch {}
}
observe('longtask', (entry) => {
  longTasks.push([entry.startTime, entry.duration]);
  if (longTasks.length > 4096) longTasks.shift();
});
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceEventTiming[]) {
      inputEvents.push({
        type: entry.name.slice(0, 24),
        start: entry.startTime,
        duration: entry.duration,
        delay: Math.max(0, entry.processingStart - entry.startTime),
      });
      if (inputEvents.length > 4096) inputEvents.shift();
    }
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
} catch {}
observe('long-animation-frame', (entry) => {
  const blocking = (entry as PerformanceEntry & { blockingDuration?: number }).blockingDuration;
  longFrames.push([entry.startTime, entry.duration, blocking ?? 0]);
  if (longFrames.length > 4096) longFrames.shift();
});

startup.script = performance.now();
function watchSessionReady(started: number): void {
  if (document.querySelector('.app-shell[data-session-ready="true"]')) {
    startup['session-ready'] ??= performance.now();
    return;
  }
  if (performance.now() - started < 60_000) {
    requestAnimationFrame(() => watchSessionReady(started));
  }
}
requestAnimationFrame(() => watchSessionReady(performance.now()));
Object.defineProperty(window, '__rmsideLatencyProfile', {
  configurable: false,
  enumerable: false,
  value: Object.freeze({
    marker: latencyProfileMarker,
    snapshot,
    clear() {
      ordered.length = 0;
      candidates.clear();
      longTasks.length = 0;
      longFrames.length = 0;
      inputEvents.length = 0;
    },
  }),
});
