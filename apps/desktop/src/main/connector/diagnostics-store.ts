import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageServerDiagnostic } from '../../shared/api';
import { englishTranslator, withTranslator } from '../../shared/i18n/translator';
import { presentDiagnostic } from '../../shared/message-catalog';
import { isRmsLintCode } from '../../shared/rms-lint-rules';
import type { XsStartOutcome } from '../../shared/xs-start';

const maximumSources = 512;
const maximumDiagnosticsPerSource = 2_000;
const maximumXsEntries = 64;
const maximumXsFindings = 50;
const messageCharacters = 200;

export type ProblemSeverity = 'error' | 'warning' | 'info';

export interface StoredDiagnostics {
  uri: string;
  version: number | undefined;
  diagnostics: readonly LanguageServerDiagnostic[];
}

export interface StoredXsFinding {
  severity: 'error' | 'warning';
  code: string;
  uri: string;
  line: number;
  column: number;
  message: string;
}

export interface StoredXsStart {
  errors: number;
  warnings: number;
  findings: readonly StoredXsFinding[];
}

export function sourceKey(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'file:') {
      const path = resolve(fileURLToPath(parsed));
      return `file:${process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path}`;
    }
  } catch {}
  return `uri:${uri}`;
}

export function sourcePath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'file:' ? resolve(fileURLToPath(parsed)) : null;
  } catch {
    return null;
  }
}

function isDiagnostic(value: unknown): value is LanguageServerDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const diagnostic = value as Partial<LanguageServerDiagnostic>;
  return (
    typeof diagnostic.message === 'string' &&
    typeof diagnostic.range?.start?.line === 'number' &&
    typeof diagnostic.range.start.character === 'number'
  );
}

interface Waiter {
  key: string;
  version: number;
  resolve(found: boolean): void;
}

export class ConnectorDiagnosticsStore {
  private readonly sources = new Map<string, StoredDiagnostics>();
  private readonly xs = new Map<string, StoredXsStart>();
  private readonly waiters = new Set<Waiter>();

  accept(params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const value = params as { uri?: unknown; version?: unknown; diagnostics?: unknown };
    if (typeof value.uri !== 'string' || value.uri.length > 4096) return;
    if (!Array.isArray(value.diagnostics)) return;
    const key = sourceKey(value.uri);
    if (!key.startsWith('file:')) return;
    const version = Number.isSafeInteger(value.version) ? (value.version as number) : undefined;
    const diagnostics = value.diagnostics
      .filter(isDiagnostic)
      .slice(0, maximumDiagnosticsPerSource);
    this.sources.delete(key);
    if (diagnostics.length > 0 || version !== undefined) {
      if (this.sources.size >= maximumSources) {
        const oldest = this.sources.keys().next().value;
        if (oldest !== undefined) this.sources.delete(oldest);
      }
      this.sources.set(key, { uri: value.uri, version, diagnostics });
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.key === key && version !== undefined && version >= waiter.version) {
        this.waiters.delete(waiter);
        waiter.resolve(true);
      }
    }
  }

  latest(uri: string): StoredDiagnostics | undefined {
    return this.sources.get(sourceKey(uri));
  }

  all(): StoredDiagnostics[] {
    return [...this.sources.values()];
  }

  waitForVersion(
    uri: string,
    version: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const key = sourceKey(uri);
    const current = this.sources.get(key);
    if (current?.version !== undefined && current.version >= version) return Promise.resolve(true);
    if (signal?.aborted || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolvePromise) => {
      const finish = (found: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        this.waiters.delete(waiter);
        resolvePromise(found);
      };
      const aborted = () => finish(false);
      const waiter: Waiter = { key, version, resolve: finish };
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener('abort', aborted, { once: true });
      this.waiters.add(waiter);
    });
  }

  recordXsStart(entryUri: string, outcome: XsStartOutcome | undefined): void {
    const key = sourceKey(entryUri);
    this.xs.delete(key);
    if (outcome?.kind !== 'report') return;
    const report = outcome.report;
    const findings: StoredXsFinding[] = [];
    let errors = 0;
    let warnings = 0;
    const stop = report.status === 'stopped' ? report.stop : null;
    report.findings.forEach((finding, index) => {
      const isStop =
        stop !== null && index === report.findings.length - 1 && finding.code === stop.code;
      const severity = isStop ? 'error' : finding.severity;
      if (severity === 'info') return;
      if (severity === 'error') errors += 1;
      else warnings += 1;
      if (finding.place && findings.length < maximumXsFindings) {
        findings.push({
          severity,
          code: finding.code,
          uri: finding.place.sourceId,
          line: finding.place.line,
          column: finding.place.column,
          message: finding.message || finding.code,
        });
      }
    });
    if (stop && report.findings.at(-1)?.code !== stop.code) {
      errors += 1;
      if (stop.place && findings.length < maximumXsFindings) {
        findings.push({
          severity: 'error',
          code: stop.code,
          uri: stop.place.sourceId,
          line: stop.place.line,
          column: stop.place.column,
          message: stop.code,
        });
      }
    }
    for (const compile of report.compileErrors) errors += compile.errors;
    if (this.xs.size >= maximumXsEntries) {
      const oldest = this.xs.keys().next().value;
      if (oldest !== undefined) this.xs.delete(oldest);
    }
    this.xs.set(key, { errors, warnings, findings });
  }

  xsStart(entryUri: string): StoredXsStart | undefined {
    return this.xs.get(sourceKey(entryUri));
  }

  xsFindingsIn(uri: string): StoredXsFinding[] {
    const key = sourceKey(uri);
    const seen = new Set<string>();
    const result: StoredXsFinding[] = [];
    for (const entry of this.xs.values()) {
      for (const finding of entry.findings) {
        if (sourceKey(finding.uri) !== key) continue;
        const id = `${finding.code}\u0000${finding.line}\u0000${finding.column}\u0000${finding.message}`;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(finding);
      }
    }
    return result;
  }

  clear(): void {
    this.sources.clear();
    this.xs.clear();
    for (const waiter of [...this.waiters]) waiter.resolve(false);
    this.waiters.clear();
  }
}

export interface ProblemItem {
  sev: ProblemSeverity;
  code: string;
  line: number;
  col: number;
  msg: string;
  fix?: string;
}

export interface ProblemSummary {
  counts: { errors: number; warnings: number; info: number };
  items: ProblemItem[];
  includes: { uri: string; errors: number }[];
}

export interface ProblemSummaryInput {
  uri: string;
  sources: readonly StoredDiagnostics[];
  xsFindings?: readonly StoredXsFinding[];
  severity: 'errors' | 'warnings' | 'all';
  code?: string;
}

function clip(text: string, maximum = messageCharacters): string {
  const plain = text.replace(/\s+/gu, ' ').trim();
  const characters = [...plain];
  return characters.length <= maximum ? plain : `${characters.slice(0, maximum - 1).join('')}…`;
}

function severityOf(diagnostic: LanguageServerDiagnostic): ProblemSeverity | null {
  if (diagnostic.severity === 4) return null;
  if (diagnostic.severity === 1) return 'error';
  if (diagnostic.severity === 2 || diagnostic.severity === undefined) return 'warning';
  return 'info';
}

function position(value: unknown): { line: number; character: number } | null {
  if (!value || typeof value !== 'object') return null;
  const { line, character } = value as Record<string, unknown>;
  return Number.isSafeInteger(line) &&
    Number.isSafeInteger(character) &&
    (line as number) >= 0 &&
    (character as number) >= 0
    ? { line: line as number, character: character as number }
    : null;
}

function anchorOf(
  publishedUri: string,
  diagnostic: LanguageServerDiagnostic,
): { uri: string; line: number; character: number; message: string } {
  const start = position(diagnostic.range.start) ?? { line: 0, character: 0 };
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
          ? position((rmsSourceRange as Record<string, unknown>).start)
          : null;
      const fallback = rmsSourceUri === publishedUri ? start : { line: 0, character: 0 };
      return { uri: rmsSourceUri, ...(anchored ?? fallback), message: diagnostic.message };
    }
  }
  const suffix = / in ((?:file|rmside-[a-z-]+):\/\/\S+?)\.?$/u.exec(diagnostic.message);
  if (suffix && suffix[1] !== publishedUri) {
    return {
      uri: suffix[1]!,
      line: 0,
      character: 0,
      message: diagnostic.message.slice(0, suffix.index),
    };
  }
  return { uri: publishedUri, ...start, message: diagnostic.message };
}

function knownCrashOf(data: unknown): unknown {
  return data && typeof data === 'object'
    ? (data as Record<string, unknown>).rmsKnownCrash
    : undefined;
}

const severityRank: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

interface RankedItem extends ProblemItem {
  weight: number;
}

export function summarizeProblems(input: ProblemSummaryInput): ProblemSummary {
  const target = sourceKey(input.uri);
  const counts = { errors: 0, warnings: 0, info: 0 };
  const items: RankedItem[] = [];
  const seen = new Set<string>();
  const includes = new Map<string, { uri: string; errors: number }>();
  const count = (severity: ProblemSeverity) => {
    if (severity === 'error') counts.errors += 1;
    else if (severity === 'warning') counts.warnings += 1;
    else counts.info += 1;
  };
  for (const source of input.sources) {
    const publishedKey = sourceKey(source.uri);
    for (const diagnostic of source.diagnostics) {
      const severity = severityOf(diagnostic);
      if (!severity) continue;
      const anchor = anchorOf(source.uri, diagnostic);
      const anchorKey = sourceKey(anchor.uri);
      const code = diagnostic.code === undefined ? 'RMS' : String(diagnostic.code);
      if (anchorKey !== target) {
        if (publishedKey === target && severity === 'error') {
          const include = includes.get(anchorKey) ?? { uri: anchor.uri, errors: 0 };
          include.errors += 1;
          includes.set(anchorKey, include);
        }
        continue;
      }
      const id = [anchor.line, anchor.character, code, severity, anchor.message].join('\u0000');
      if (seen.has(id)) continue;
      seen.add(id);
      count(severity);
      if (input.code !== undefined && code.toLowerCase() !== input.code.toLowerCase()) continue;
      const knownCrash = knownCrashOf(diagnostic.data);
      const presented = withTranslator(englishTranslator, () =>
        presentDiagnostic({ code, message: anchor.message, severity, knownCrash }),
      );
      items.push({
        sev: severity,
        code,
        line: anchor.line + 1,
        col: anchor.character + 1,
        msg: clip(presented.headline || anchor.message),
        ...(presented.action?.label ? { fix: clip(presented.action.label) } : {}),
        weight: knownCrash !== undefined ? 0 : isRmsLintCode(code) ? 2 : 1,
      });
    }
  }
  for (const finding of input.xsFindings ?? []) {
    const id = [
      finding.line - 1,
      finding.column - 1,
      finding.code,
      finding.severity,
      finding.message,
    ].join('\u0000');
    if (seen.has(id)) continue;
    seen.add(id);
    count(finding.severity);
    if (input.code !== undefined && finding.code.toLowerCase() !== input.code.toLowerCase())
      continue;
    items.push({
      sev: finding.severity,
      code: finding.code,
      line: finding.line,
      col: finding.column,
      msg: clip(`${finding.message} (XS start check, last generation)`),
      weight: 1,
    });
  }
  const shown = items
    .filter((item) =>
      input.severity === 'all'
        ? true
        : input.severity === 'warnings'
          ? item.sev !== 'info'
          : item.sev === 'error',
    )
    .sort(
      (left, right) =>
        severityRank[left.sev] - severityRank[right.sev] ||
        left.weight - right.weight ||
        left.line - right.line ||
        left.col - right.col ||
        left.code.localeCompare(right.code) ||
        left.msg.localeCompare(right.msg),
    )
    .map(({ weight: _weight, ...item }) => item);
  return {
    counts,
    items: shown,
    includes: [...includes.values()].sort(
      (left, right) => right.errors - left.errors || left.uri.localeCompare(right.uri),
    ),
  };
}
