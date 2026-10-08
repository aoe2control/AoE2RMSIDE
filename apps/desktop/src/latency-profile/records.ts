export const latencyProfileMarker = 'rmside-latency-profile-v1';
export const nativeLatencyPrefix = 'rmside-latency-v1 ';

export const maximumRecords = 256;
export const maximumSteps = 48;
export const maximumMarks = 64;
export const maximumNativeLines = 512;
const maximumNativeLineBytes = 8 * 1024;

export interface MainRecord {
  requestId: string;
  kind: 'generation' | 'language';
  openedAt: number;
  cursor: number;
  closedAt?: number;
  outcome?: 'committed' | 'failed';
  steps: Array<[string, number]>;
  within: Record<string, number>;
  languageIds: number[];
}

export interface NativeLatencyLine {
  process: 'rmsd' | 'rms-ls';
  kind: 'generation' | 'request' | 'notification';
  request?: string;
  id?: number;
  method?: string;
  outcome?: string;
  inclusiveUs: number;
  steps: Array<[string, number]>;
  within: Array<[string, number]>;
  engineUs?: number;
  responseBytes?: number;
  cancelToTerminalUs?: number;
}

export interface MainSnapshot {
  marker: string;
  records: MainRecord[];
  native: NativeLatencyLine[];
  language: Array<{ id: number; method: string; sentAt: number; answeredAt?: number }>;
  startup: Record<string, number>;
  timeOrigin?: number;
}

export interface RendererRun {
  run: number;
  requestIds: string[];
  marks: Array<[string, number]>;
  input?: number;
  committed?: number;
  scene?: RendererScene;
}

export interface RendererScene {
  sceneStart?: number;
  sceneEnd?: number;
  renderStart?: number;
  renderEnd?: number;
  present?: number;
  fallback?: boolean;
  rebuilds?: Array<[number, number]>;
  settledPresent?: number;
}

export interface RendererCandidate {
  requestId: string;
  drawn: number;
  drawMs: number;
  present?: number;
  count: number;
  totalDrawMs: number;
}

export interface RendererSnapshot {
  marker: string;
  runs: RendererRun[];
  candidates: RendererCandidate[];
  startup: Record<string, number>;
  longTasks: Array<[number, number]>;
  longFrames: Array<[number, number, number]>;
  inputEvents: Array<{ type: string; start: number; duration: number; delay: number }>;
  timeOrigin?: number;
}

const rmsdSteps = new Set([
  'decode',
  'queue',
  'content',
  'source-catalog',
  'validate',
  'parse',
  'prepare',
  'generate',
  'respond',
  'frame',
  'write-wait',
  'write',
]);
const rmsdWithin = new Set(['trace-emit']);
const languageSteps = new Set(['decode', 'handle', 'write']);

function microseconds(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function pairs(value: unknown, allowed: Set<string>): Array<[string, number]> | undefined {
  if (!Array.isArray(value) || value.length > maximumSteps) return undefined;
  const result: Array<[string, number]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [name, amount] = entry as [unknown, unknown];
    const us = microseconds(amount);
    if (typeof name !== 'string' || !allowed.has(name) || us === undefined) return undefined;
    result.push([name, us]);
  }
  return result;
}

export function parseNativeLatencyLine(line: string): NativeLatencyLine | undefined {
  if (!line.startsWith(nativeLatencyPrefix) || line.length > maximumNativeLineBytes) {
    return undefined;
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line.slice(nativeLatencyPrefix.length)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const inclusiveUs = microseconds(value.inclusiveUs);
  if (inclusiveUs === undefined) return undefined;
  if (value.process === 'rmsd' && value.kind === 'generation') {
    const steps = pairs(value.steps, rmsdSteps);
    const within = pairs(value.within ?? [], rmsdWithin);
    if (!steps || !within || typeof value.request !== 'string' || value.request.length > 128) {
      return undefined;
    }
    const line: NativeLatencyLine = {
      process: 'rmsd',
      kind: 'generation',
      request: value.request,
      outcome: typeof value.outcome === 'string' ? value.outcome.slice(0, 16) : undefined,
      inclusiveUs,
      steps,
      within,
    };
    for (const key of ['engineUs', 'responseBytes', 'cancelToTerminalUs'] as const) {
      const amount = microseconds(value[key]);
      if (amount !== undefined) line[key] = amount;
    }
    return line;
  }
  if (value.process === 'rms-ls' && (value.kind === 'request' || value.kind === 'notification')) {
    const steps = pairs(value.steps, languageSteps);
    if (!steps || typeof value.method !== 'string' || value.method.length > 64) return undefined;
    const id = value.kind === 'request' ? microseconds(value.id) : undefined;
    if (value.kind === 'request' && id === undefined) return undefined;
    return {
      process: 'rms-ls',
      kind: value.kind,
      id,
      method: value.method,
      inclusiveUs,
      steps,
      within: [],
    };
  }
  return undefined;
}

export function splitNativeDiagnostics(buffered: string): {
  lines: string[];
  rest: string;
  partial: string;
} {
  const pieces = buffered.split(/\r?\n/u);
  let partial = pieces.pop() ?? '';
  const lines: string[] = [];
  const rest: string[] = [];
  for (const piece of pieces) {
    if (piece.startsWith(nativeLatencyPrefix)) lines.push(piece);
    else rest.push(piece);
  }
  if (
    !nativeLatencyPrefix.startsWith(partial.slice(0, nativeLatencyPrefix.length)) ||
    partial.length > maximumNativeLineBytes
  ) {
    rest.push(partial);
    partial = '';
  }
  return { lines, rest: rest.join('\n'), partial };
}
