import { app } from 'electron';
import type * as Contract from '../main/latency-probe';
import {
  latencyProfileMarker,
  maximumNativeLines,
  maximumRecords,
  maximumSteps,
  parseNativeLatencyLine,
  splitNativeDiagnostics,
  type MainRecord,
  type MainSnapshot,
  type NativeLatencyLine,
} from './records';

const active = process.env.RMSIDE_LATENCY_PROFILE === '1' && !app.isPackaged;

const records = new Map<string, MainRecord>();
const order: string[] = [];
const native: NativeLatencyLine[] = [];
const language: MainSnapshot['language'] = [];
const startupMarks: Record<string, number> = { module: performance.now() };
const partialLines = new Map<string, string>();
const languageRecords = new Map<number, string>();
let languageRecord: string | undefined;
let fullTraceEnabled = false;

function record(requestId: string): MainRecord | undefined {
  return active ? records.get(requestId) : undefined;
}

export const openRequest: typeof Contract.openRequest = (requestId, kind) => {
  if (!active || records.has(requestId)) return;
  const time = performance.now();
  records.set(requestId, {
    requestId,
    kind,
    openedAt: time,
    cursor: time,
    steps: [],
    within: {},
    languageIds: [],
  });
  order.push(requestId);
  while (order.length > maximumRecords) records.delete(order.shift()!);
};

export const stepUntil: typeof Contract.stepUntil = (requestId, name, time) => {
  const current = record(requestId);
  if (!current || current.closedAt !== undefined || current.steps.length >= maximumSteps) return;
  const until = Math.max(time, current.cursor);
  current.steps.push([name, until - current.cursor]);
  current.cursor = until;
};

export const step: typeof Contract.step = (requestId, name) =>
  stepUntil(requestId, name, performance.now());

export const within: typeof Contract.within = (requestId, name, milliseconds) => {
  const current = record(requestId);
  if (!current) return;
  current.within[name] = (current.within[name] ?? 0) + milliseconds;
};

export const closeRequest: typeof Contract.closeRequest = (requestId, outcome) => {
  const current = record(requestId);
  if (!current || current.closedAt !== undefined) return;
  current.closedAt = current.cursor;
  current.outcome = outcome;
};

export const now: typeof Contract.now = () => (active ? performance.now() : 0);

export const startup: typeof Contract.startup = (mark) => {
  if (active && startupMarks[mark] === undefined) startupMarks[mark] = performance.now();
};

export const fullTraceAllowed: typeof Contract.fullTraceAllowed = () => active && fullTraceEnabled;

export const languageContext: typeof Contract.languageContext = (requestId) => {
  languageRecord = active ? requestId : undefined;
};

export const languageExchange: typeof Contract.languageExchange = (id, method, phase) => {
  if (!active) return;
  if (phase === 'sent') {
    if (languageRecord) {
      languageRecords.set(id, languageRecord);
      record(languageRecord)?.languageIds.push(id);
      languageRecord = undefined;
    }
    language.push({ id, method, sentAt: performance.now() });
    if (language.length > maximumRecords) language.shift();
    return;
  }
  const entry = language.find((candidate) => candidate.id === id);
  if (entry) entry.answeredAt = performance.now();
  languageRecords.delete(id);
};

export const nativeDiagnostics: typeof Contract.nativeDiagnostics = (processName, chunk) => {
  if (!active) return chunk;
  const { lines, rest, partial } = splitNativeDiagnostics(
    (partialLines.get(processName) ?? '') + chunk,
  );
  partialLines.set(processName, partial);
  for (const line of lines) {
    const parsed = parseNativeLatencyLine(line);
    if (!parsed) continue;
    native.push(parsed);
    if (native.length > maximumNativeLines) native.shift();
  }
  return rest;
};

function snapshot(): MainSnapshot {
  return {
    marker: latencyProfileMarker,
    records: order.flatMap((id) => {
      const current = records.get(id);
      return current ? [structuredClone(current)] : [];
    }),
    native: native.map((line) => structuredClone(line)),
    language: language.map((entry) => ({ ...entry })),
    startup: { ...startupMarks },
    timeOrigin: performance.timeOrigin,
  };
}

if (active) {
  Object.defineProperty(globalThis, '__rmsideLatencyProfile', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      marker: latencyProfileMarker,
      snapshot,
      allowFullTrace() {
        fullTraceEnabled = true;
      },
      clear() {
        records.clear();
        order.length = 0;
        native.length = 0;
        language.length = 0;
      },
    }),
  });
}
