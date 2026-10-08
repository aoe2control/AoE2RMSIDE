import type { LanguageServerDiagnostic } from '../shared/api';
import {
  presentCompatibilitySummary,
  presentDiagnostic,
  skippedIncludeNote,
  undefinedNumericNote,
} from '../shared/message-catalog';
import { t } from '../shared/i18n/translator';
import type { OutputMessage, OutputSeverity } from '../shared/output-message';
import {
  emptySeverityCounts,
  severityFilterShowsAll,
  type SeverityCounts,
  type SeverityFilter,
} from './severity-filter';

export interface ProblemTarget {
  uri: string;
  line: number;
  character: number;
}

export interface ProblemEntry {
  key: string;
  severity: OutputSeverity;
  message: OutputMessage;
  position: string;
  location: string;
  target: ProblemTarget;
  count: number;
}

export interface ProblemFileGroup {
  uri: string;
  name: string;
  path: string;
  protected: boolean;
  entries: ProblemEntry[];
  counts: SeverityCounts;
}

export interface ProblemsModelOptions {
  isProtected(uri: string): boolean;
}

interface Position {
  line: number;
  character: number;
}

function validPosition(value: unknown): Position | null {
  if (!value || typeof value !== 'object') return null;
  const { line, character } = value as Record<string, unknown>;
  return Number.isInteger(line) &&
    Number.isInteger(character) &&
    Number(line) >= 0 &&
    Number(character) >= 0
    ? { line: Number(line), character: Number(character) }
    : null;
}

function diagnosticAnchor(
  uri: string,
  diagnostic: LanguageServerDiagnostic,
): { uri: string; start: Position; message: string } {
  const start = validPosition(diagnostic.range.start) ?? { line: 0, character: 0 };
  const data = diagnostic.data;
  if (data && typeof data === 'object') {
    const { rmsSourceUri, rmsSourceRange } = data as Record<string, unknown>;
    if (
      typeof rmsSourceUri === 'string' &&
      rmsSourceUri.length > 0 &&
      rmsSourceUri.length <= 4096
    ) {
      const anchored =
        rmsSourceRange && typeof rmsSourceRange === 'object'
          ? validPosition((rmsSourceRange as Record<string, unknown>).start)
          : null;
      return {
        uri: rmsSourceUri,
        start: anchored ?? (rmsSourceUri === uri ? start : { line: 0, character: 0 }),
        message: diagnostic.message,
      };
    }
  }
  const suffix = / in ((?:file|rmside-[a-z-]+):\/\/\S+?)\.?$/u.exec(diagnostic.message);
  if (suffix && suffix[1] !== uri) {
    return {
      uri: suffix[1]!,
      start: { line: 0, character: 0 },
      message: diagnostic.message.slice(0, suffix.index),
    };
  }
  return { uri, start, message: diagnostic.message };
}

function severityOf(diagnostic: LanguageServerDiagnostic): OutputSeverity {
  if (diagnostic.severity === 1) return 'error';
  if (diagnostic.severity === 2 || diagnostic.severity === undefined) return 'warning';
  return 'info';
}

export function readableSourcePath(uri: string): string {
  let path = uri.replace(/[?#].*$/u, '').replace(/^file:\/\/\/?/u, '');
  try {
    path = decodeURIComponent(path);
  } catch {}
  return /^[A-Za-z]:\//u.test(path) ? path.replaceAll('/', '\\') : path;
}

export function readableSourceName(uri: string): string {
  const segments = readableSourcePath(uri).split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? uri;
}

const severityRank: Record<OutputSeverity, number> = { error: 0, warning: 1, info: 2 };

export function problemGroups(
  diagnosticsByUri: Iterable<readonly [string, readonly LanguageServerDiagnostic[]]>,
  options: ProblemsModelOptions,
): ProblemFileGroup[] {
  const groups = new Map<string, ProblemFileGroup>();
  const summaries = new Map<
    string,
    { names: Set<string>; includes: Set<string>; first: ProblemTarget }
  >();
  const groupFor = (uri: string): ProblemFileGroup => {
    let group = groups.get(uri);
    if (!group) {
      group = {
        uri,
        name: readableSourceName(uri),
        path: readableSourcePath(uri),
        protected: options.isProtected(uri),
        entries: [],
        counts: emptySeverityCounts(),
      };
      groups.set(uri, group);
    }
    return group;
  };
  const entryKeys = new Map<string, ProblemEntry>();
  for (const [uri, diagnostics] of diagnosticsByUri) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === 4) continue;
      const anchor = diagnosticAnchor(uri, diagnostic);
      const severity = severityOf(diagnostic);
      const code = diagnostic.code === undefined ? undefined : String(diagnostic.code);
      const target = { uri: anchor.uri, ...anchor.start };
      const group = groupFor(anchor.uri);
      if (group.protected && (code === 'RMS2034' || code === 'RMS2022')) {
        const undefinedName = code === 'RMS2034' ? undefinedNumericNote(anchor.message) : null;
        const skipped = code === 'RMS2022' ? skippedIncludeNote(anchor.message) : null;
        if (undefinedName || skipped) {
          let summary = summaries.get(anchor.uri);
          if (!summary) {
            summary = { names: new Set(), includes: new Set(), first: target };
            summaries.set(anchor.uri, summary);
          }
          if (undefinedName) summary.names.add(undefinedName.symbol);
          if (skipped) summary.includes.add(skipped.include);
          continue;
        }
      }
      const key = [
        anchor.uri,
        target.line,
        target.character,
        code ?? '',
        severity,
        anchor.message,
      ].join('\u0000');
      const existing = entryKeys.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      const entry: ProblemEntry = {
        key,
        severity,
        message: presentDiagnostic({ code, message: anchor.message, severity }),
        position: `${target.line + 1}:${target.character + 1}`,
        location: t('message.format.file-line', { name: group.name, line: target.line + 1 }),
        target,
        count: 1,
      };
      entryKeys.set(key, entry);
      group.entries.push(entry);
    }
  }
  for (const [uri, summary] of summaries) {
    const group = groupFor(uri);
    group.entries.push({
      key: `${uri}\u0000summary`,
      severity: 'info',
      message: presentCompatibilitySummary({
        undefinedNames: [...summary.names].sort(),
        skippedIncludes: [...summary.includes].sort(),
      }),
      position: `${summary.first.line + 1}:${summary.first.character + 1}`,
      location: t('message.format.file-line', { name: group.name, line: summary.first.line + 1 }),
      target: summary.first,
      count: 1,
    });
  }
  const result = [...groups.values()].filter((group) => group.entries.length > 0);
  for (const group of result) {
    group.entries.sort(
      (left, right) =>
        left.target.line - right.target.line ||
        left.target.character - right.target.character ||
        severityRank[left.severity] - severityRank[right.severity] ||
        left.message.headline.localeCompare(right.message.headline),
    );
    for (const entry of group.entries) group.counts[entry.severity] += 1;
  }
  const worst = (group: ProblemFileGroup) =>
    group.counts.error > 0 ? 0 : group.counts.warning > 0 ? 1 : 2;
  return result.sort(
    (left, right) =>
      worst(left) - worst(right) ||
      Number(left.protected) - Number(right.protected) ||
      left.name.localeCompare(right.name) ||
      left.uri.localeCompare(right.uri),
  );
}

export function filterProblemGroups(
  groups: readonly ProblemFileGroup[],
  filter: SeverityFilter,
): ProblemFileGroup[] {
  if (severityFilterShowsAll(filter)) return [...groups];
  return groups
    .map((group) => ({
      ...group,
      entries: group.entries.filter((entry) => filter[entry.severity]),
    }))
    .filter((group) => group.entries.length > 0);
}

export function problemSeverityCounts(groups: readonly ProblemFileGroup[]): SeverityCounts {
  const counts = emptySeverityCounts();
  for (const group of groups) {
    for (const severity of Object.keys(counts) as OutputSeverity[]) {
      counts[severity] += group.counts[severity];
    }
  }
  return counts;
}

export function problemCount(groups: readonly ProblemFileGroup[]): number {
  const counts = problemSeverityCounts(groups);
  return counts.error + counts.warning;
}

export function isStandardGameSource(uri: string, readOnlyUris: ReadonlySet<string>): boolean {
  const key = readableSourcePath(uri).replaceAll('\\', '/').toLowerCase();
  if (readOnlyUris.has(key)) return true;
  return /\/resources\/_common\/drs\/|\/steamapps\/common\/aoe2de\/|\/mods\/subscribed\//u.test(
    `/${key}`,
  );
}

export function sourcePathKey(uri: string): string {
  return readableSourcePath(uri).replaceAll('\\', '/').toLowerCase();
}
