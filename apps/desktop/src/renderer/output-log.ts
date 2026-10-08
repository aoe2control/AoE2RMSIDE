import type { PreviewProvenanceOperation } from '../shared/api';
import { t } from '../shared/i18n/translator';
import { generationResultWords } from '../shared/message-catalog';
import { wordOutputWords, type OutputMessage, type OutputWords } from '../shared/output-message';
import {
  emptySeverityCounts,
  severityFilterShowsAll,
  type SeverityCounts,
  type SeverityFilter,
} from './severity-filter';

export const maximumOutputEntries = 200;
export const maximumOutputGroupRows = 200;
const maximumPendingRuns = 16;
const maximumClearedRuns = 64;

export interface OutputRow {
  id: number;
  time: number;
  message: OutputMessage;
  repeat: number;
}

export type OutputRunResult =
  'exact' | 'synthetic' | 'unchanged' | 'failed' | 'stopped' | 'passed' | 'test-failed';

export interface OutputRunHeader {
  kind: 'preview' | 'map-test';
  script: string;
  seed?: number;
  size?: string;
  players?: number;
  maps?: number;
  durationMs?: number;
  result: OutputRunResult;
  resultLabel: OutputWords;
  mapHash?: string;
  requestHash?: string;
  constructs?: OutputRunConstructs;
}

export interface OutputRunConstructs {
  note: OutputWords;
  items: { label: string; operation: PreviewProvenanceOperation }[];
  omitted: number;
}

export interface OutputGroup {
  kind: 'run';
  id: string;
  time: number;
  header: OutputRunHeader;
  rows: OutputRow[];
  droppedRows: number;
}

export type OutputEntry = { kind: 'row'; row: OutputRow } | OutputGroup;

export interface OutputLogState {
  entries: OutputEntry[];
  pending: ReadonlyMap<string, OutputRow[]>;
  toggled: ReadonlyMap<string, boolean>;
  nextId: number;
  revision: number;
  cleared: ReadonlyMap<string, { header: OutputRunHeader; time: number }>;
}

export function emptyOutputLog(): OutputLogState {
  return {
    entries: [],
    pending: new Map(),
    toggled: new Map(),
    nextId: 1,
    revision: 0,
    cleared: new Map(),
  };
}

export function clearOutputLog(state: OutputLogState): OutputLogState {
  const cleared = new Map(state.cleared);
  for (const entry of state.entries) {
    if (entry.kind !== 'run') continue;
    cleared.delete(entry.id);
    cleared.set(entry.id, { header: entry.header, time: entry.time });
  }
  while (cleared.size > maximumClearedRuns) cleared.delete(cleared.keys().next().value!);
  return {
    entries: [],
    pending: state.pending,
    toggled: new Map(),
    nextId: state.nextId,
    revision: state.revision + 1,
    cleared,
  };
}

function sameMessage(left: OutputMessage, right: OutputMessage): boolean {
  return (
    left.code === right.code &&
    left.severity === right.severity &&
    left.source === right.source &&
    left.headline === right.headline &&
    left.cause === right.cause &&
    left.detail === right.detail &&
    left.monospace === right.monospace &&
    left.action?.label === right.action?.label &&
    left.action?.link === right.action?.link
  );
}

function withRow(
  rows: readonly OutputRow[],
  message: OutputMessage,
  time: number,
  id: number,
): { rows: OutputRow[]; added: boolean } {
  const last = rows.at(-1);
  if (last && !message.monospace && sameMessage(last.message, message)) {
    return {
      rows: [...rows.slice(0, -1), { ...last, time, repeat: last.repeat + 1 }],
      added: false,
    };
  }
  return { rows: [...rows, { id, time, message, repeat: 1 }], added: true };
}

function capEntries(entries: OutputEntry[]): OutputEntry[] {
  return entries.length > maximumOutputEntries
    ? entries.slice(entries.length - maximumOutputEntries)
    : entries;
}

function capGroupRows(group: OutputGroup): OutputGroup {
  const excess = group.rows.length - maximumOutputGroupRows;
  if (excess <= 0) return group;
  return { ...group, rows: group.rows.slice(excess), droppedRows: group.droppedRows + excess };
}

export function appendOutputMessage(
  state: OutputLogState,
  message: OutputMessage,
  time: number,
  runId?: string,
): OutputLogState {
  const id = state.nextId;
  if (runId !== undefined) {
    const index = state.entries.findIndex((entry) => entry.kind === 'run' && entry.id === runId);
    if (index >= 0) {
      const group = state.entries[index] as OutputGroup;
      const next = withRow(group.rows, message, time, id);
      const entries = [...state.entries];
      entries[index] = capGroupRows({ ...group, rows: next.rows });
      return { ...state, entries, nextId: id + 1, revision: state.revision + 1 };
    }
    const clearedGroup = state.cleared.get(runId);
    if (clearedGroup) {
      const cleared = new Map(state.cleared);
      cleared.delete(runId);
      const group: OutputGroup = {
        kind: 'run',
        id: runId,
        time: clearedGroup.time,
        header: clearedGroup.header,
        rows: [{ id, time, message, repeat: 1 }],
        droppedRows: 0,
      };
      return {
        ...state,
        entries: capEntries([...state.entries, group]),
        cleared,
        nextId: id + 1,
        revision: state.revision + 1,
      };
    }
    const pending = new Map(state.pending);
    const current = pending.get(runId) ?? [];
    pending.delete(runId);
    pending.set(runId, withRow(current, message, time, id).rows.slice(-maximumOutputGroupRows));
    while (pending.size > maximumPendingRuns) pending.delete(pending.keys().next().value!);
    return { ...state, pending, nextId: id + 1 };
  }
  const last = state.entries.at(-1);
  if (last?.kind === 'row' && !message.monospace && sameMessage(last.row.message, message)) {
    const entries = [...state.entries];
    entries[entries.length - 1] = {
      kind: 'row',
      row: { ...last.row, time, repeat: last.row.repeat + 1 },
    };
    return { ...state, entries, nextId: id + 1, revision: state.revision + 1 };
  }
  return {
    ...state,
    entries: capEntries([...state.entries, { kind: 'row', row: { id, time, message, repeat: 1 } }]),
    nextId: id + 1,
    revision: state.revision + 1,
  };
}

export function settleOutputRun(
  state: OutputLogState,
  runId: string,
  header: OutputRunHeader | null,
  time: number,
): OutputLogState {
  const pending = new Map(state.pending);
  const rows = pending.get(runId) ?? [];
  pending.delete(runId);
  const cleared = new Map(state.cleared);
  cleared.delete(runId);
  if (!header) return { ...state, pending, cleared };
  const index = state.entries.findIndex((entry) => entry.kind === 'run' && entry.id === runId);
  if (index >= 0) {
    const entries = [...state.entries];
    const group = entries[index] as OutputGroup;
    entries[index] = capGroupRows({ ...group, header, rows: [...group.rows, ...rows] });
    return { ...state, entries, pending, cleared, revision: state.revision + 1 };
  }
  const group = capGroupRows({ kind: 'run', id: runId, time, header, rows, droppedRows: 0 });
  return {
    ...state,
    entries: capEntries([...state.entries, group]),
    pending,
    cleared,
    toggled: new Map(),
    revision: state.revision + 1,
  };
}

export function outputGroupOpen(state: OutputLogState, groupId: string): boolean {
  const toggled = state.toggled.get(groupId);
  if (toggled !== undefined) return toggled;
  return latestOutputGroupId(state) === groupId;
}

export function latestOutputGroupId(state: OutputLogState): string | null {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index]!;
    if (entry.kind === 'run') return entry.id;
  }
  return null;
}

export function toggleOutputGroup(state: OutputLogState, groupId: string): OutputLogState {
  const toggled = new Map(state.toggled);
  toggled.set(groupId, !outputGroupOpen(state, groupId));
  return { ...state, toggled };
}

export function outputMessageCount(state: OutputLogState): number {
  let count = 0;
  for (const entry of state.entries) {
    count += entry.kind === 'row' ? 1 : 1 + entry.rows.length;
  }
  return count;
}

export function outputRunHeaderPrefix(header: OutputRunHeader): string {
  const parts = [header.script];
  if (header.seed !== undefined) parts.push(t('output.run.seed', { seed: header.seed }));
  if (header.size) parts.push(header.size);
  if (header.players !== undefined) {
    parts.push(t('output.run.players', { count: header.players }));
  }
  if (header.maps !== undefined) parts.push(t('output.run.maps', { count: header.maps }));
  if (header.durationMs !== undefined) parts.push(formatRunDuration(header.durationMs));
  return parts.join(' · ');
}

export function outputRunResultLabel(header: OutputRunHeader): string | null {
  if (!header.constructs) return wordOutputWords(header.resultLabel);
  return header.result === 'unchanged' ? generationResultWords.reused : null;
}

export function outputRunConstructNote(header: OutputRunHeader): string | null {
  return header.constructs ? wordOutputWords(header.constructs.note) : null;
}

export function outputRunHeaderText(header: OutputRunHeader): string {
  return [
    outputRunHeaderPrefix(header),
    outputRunResultLabel(header),
    outputRunConstructNote(header),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

export function formatRunDuration(milliseconds: number): string {
  const value = Math.max(0, milliseconds);
  if (value < 1_000) return t('output.duration.milliseconds', { value: Math.round(value) });
  if (value < 60_000) return t('output.duration.seconds', { value: value / 1_000 });
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return t('output.duration.minutes', { minutes, seconds });
}

export function formatOutputTime(time: number): string {
  const date = new Date(time);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

const filteredGroups = new WeakMap<OutputGroup, { filter: SeverityFilter; group: OutputGroup }>();

export function filterOutputEntries(state: OutputLogState, filter: SeverityFilter): OutputEntry[] {
  if (severityFilterShowsAll(filter)) return state.entries;
  const shown: OutputEntry[] = [];
  for (const entry of state.entries) {
    if (entry.kind === 'row') {
      if (filter[entry.row.message.severity]) shown.push(entry);
      continue;
    }
    const kept = filteredGroups.get(entry);
    if (kept && kept.filter === filter) {
      if (kept.group.rows.length > 0) shown.push(kept.group);
      continue;
    }
    const rows = entry.rows.filter((row) => filter[row.message.severity]);
    const group = { ...entry, rows, droppedRows: 0 };
    filteredGroups.set(entry, { filter, group });
    if (rows.length > 0) shown.push(group);
  }
  return shown;
}

export function outputSeverityCounts(state: OutputLogState): SeverityCounts {
  const counts = emptySeverityCounts();
  for (const entry of state.entries) {
    if (entry.kind === 'row') counts[entry.row.message.severity] += 1;
    else for (const row of entry.rows) counts[row.message.severity] += 1;
  }
  return counts;
}
