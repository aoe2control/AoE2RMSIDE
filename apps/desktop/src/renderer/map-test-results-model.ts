import type { LanguageServerDiagnostic, MapTestFinding, MapTestReport } from '../shared/api';
import {
  mapTestErrorLocation,
  presentMapTestFinding,
  presentMessage,
} from '../shared/message-catalog';
import { t, type MessageId } from '../shared/i18n/translator';
import type { OutputMessage } from '../shared/output-message';

export interface MapTestFindingEntry {
  key: string;
  findingId: string;
  seed: number;
  mapName: string;
  mapPath: string;
  message: OutputMessage;
  count: number;
}

export interface MapTestCheckGroup {
  key: string;
  line: number;
  column: number;
  position: string;
  location: string;
  headline: string;
  messageShown: boolean;
  findings: number;
  seeds: number;
  entries: MapTestFindingEntry[];
}

export interface MapTestResultsSummary {
  status: MapTestReport['status'];
  statusLabel: string;
  scriptName: string;
  testedMap: string | null;
  facts: string;
  maps: number;
  assertions: number;
  findings: number;
  seeds: number;
}

export interface MapTestResultsModel {
  summary: MapTestResultsSummary;
  groups: MapTestCheckGroup[];
}

export const mapTestRowsPerPage = 100;

const statusLabels: Record<MapTestReport['status'], MessageId> = {
  passed: 'test-results.results.status.passed',
  failed: 'test-results.results.status.failed',
  error: 'test-results.results.status.error',
  cancelled: 'test-results.results.status.stopped',
};

export function readablePathName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export function findingCountsText(findings: number, seeds: number): string {
  return seeds > 0 && seeds < findings
    ? t('test-results.results.findings-on-seeds', { findings, seeds })
    : t('test-results.results.findings', { findings });
}

export function mapTestResultsModel(report: MapTestReport): MapTestResultsModel {
  const scriptName = readablePathName(report.script.name);
  const sites = new Map<string, MapTestFinding[]>();
  for (const finding of report.findings) {
    const key = `${finding.scriptLine}:${finding.scriptColumn}`;
    const site = sites.get(key);
    if (site) site.push(finding);
    else sites.set(key, [finding]);
  }
  const groups = [...sites.entries()].map(([key, findings]): MapTestCheckGroup => {
    const first = findings[0]!;
    const messageShown = findings.every((finding) => finding.message === first.message);
    const entries: MapTestFindingEntry[] = [];
    const folded = new Map<string, MapTestFindingEntry>();
    for (const finding of findings) {
      const identity = [
        finding.seed,
        finding.sourcePath,
        finding.code ?? '',
        finding.message,
        JSON.stringify(finding.measurements),
      ].join('\u0000');
      const existing = folded.get(identity);
      if (existing) {
        existing.count += 1;
        continue;
      }
      const entry: MapTestFindingEntry = {
        key: finding.findingId,
        findingId: finding.findingId,
        seed: finding.seed,
        mapName: readablePathName(finding.sourcePath),
        mapPath: finding.sourcePath,
        message: presentMapTestFinding({
          message: finding.message,
          code: finding.code,
          measurements: finding.measurements,
          seed: finding.seed,
          sourcePath: finding.sourcePath,
          scriptName,
          scriptLine: finding.scriptLine,
          scriptColumn: finding.scriptColumn,
          mapHash: finding.mapHash,
          requestHash: finding.requestHash,
          messageShown,
        }),
        count: 1,
      };
      folded.set(identity, entry);
      entries.push(entry);
    }
    const message = first.message.replace(/\s+/gu, ' ').trim();
    return {
      key,
      line: first.scriptLine,
      column: first.scriptColumn,
      position: `${first.scriptLine}:${first.scriptColumn}`,
      location: t('test-results.results.check-location', {
        script: scriptName,
        line: first.scriptLine,
      }),
      headline:
        messageShown && message
          ? message
          : t('test-results.results.check-headline', { line: first.scriptLine }),
      messageShown: messageShown && Boolean(message),
      findings: findings.length,
      seeds: new Set(findings.map((finding) => finding.seed)).size,
      entries,
    };
  });
  groups.sort((left, right) => left.line - right.line || left.column - right.column);
  const seeds = new Set(report.findings.map((finding) => finding.seed)).size;
  const maps = new Set(report.findings.map((finding) => finding.sourcePath));
  const testedMap = maps.size === 1 ? readablePathName([...maps][0]!) : null;
  const facts = t('test-results.results.facts', {
    maps: report.generatedMaps,
    assertions: report.assertionCount,
    findings: findingCountsText(report.findings.length, seeds),
  });
  return {
    summary: {
      status: report.status,
      statusLabel: t(statusLabels[report.status]),
      scriptName,
      testedMap,
      facts,
      maps: report.generatedMaps,
      assertions: report.assertionCount,
      findings: report.findings.length,
      seeds,
    },
    groups,
  };
}

export function mapTestNoFindingsText(summary: MapTestResultsSummary): string {
  return summary.assertions > 0
    ? t('test-results.results.no-findings.passed', { maps: summary.maps })
    : t('test-results.results.no-findings.unchecked', { maps: summary.maps });
}

export type MapTestResultsOrigin = 'current' | 'running' | 'after-error' | 'after-stop';

export function mapTestResultsNotice(options: {
  origin: MapTestResultsOrigin;
  imported: boolean;
  scriptName: string;
  progress?: { completed: number; requested: number };
}): OutputMessage | null {
  const code =
    options.origin === 'running'
      ? 'map-test.results-running'
      : options.origin === 'after-error'
        ? 'map-test.results-after-error'
        : options.origin === 'after-stop'
          ? 'map-test.results-after-stop'
          : options.imported
            ? 'map-test.results-imported'
            : null;
  if (!code) return null;
  const counts =
    options.origin === 'running' && options.progress
      ? { completed: options.progress.completed, requested: options.progress.requested }
      : {};
  return presentMessage({
    source: 'Map test',
    code,
    params: { script: options.scriptName, ...counts },
  });
}

export function anchorMapTestRunDiagnostics(
  diagnostics: readonly LanguageServerDiagnostic[],
  scriptName: string,
): LanguageServerDiagnostic[] {
  const name = readablePathName(scriptName).toLowerCase();
  return diagnostics.map((diagnostic) => {
    const { start } = diagnostic.range;
    if (start.line !== 0 || start.character !== 0) return diagnostic;
    const location = mapTestErrorLocation(diagnostic.message);
    if (!location || readablePathName(location.file).toLowerCase() !== name) return diagnostic;
    const line = Math.max(0, location.line - 1);
    const character = Math.max(0, (location.column ?? 1) - 1);
    return {
      ...diagnostic,
      range: { start: { line, character }, end: { line, character: character + 1 } },
    };
  });
}
