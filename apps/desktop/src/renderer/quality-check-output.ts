import type {
  LanguageServerDiagnostic,
  MapTestFinding,
  MapTestQuality,
  MapTestQualityItem,
  MapTestQualityLevel,
  MapTestReport,
} from '../shared/api';
import type { MessageId } from '../shared/i18n/translator';
import {
  outputNote,
  type OutputMessage,
  type OutputSeverity,
  type OutputText,
} from '../shared/output-message';
import { isQualityCaseId, qualityScriptName, type QualityCaseId } from '../shared/quality-check';

const qualityCaseTitles: Readonly<Record<QualityCaseId, MessageId>> = {
  generation: 'quality.case.generation',
  'start-resources': 'quality.case.start-resources',
  'resource-distances': 'quality.case.resource-distances',
  'shared-resources': 'quality.case.shared-resources',
  wood: 'quality.case.wood',
  trapped: 'quality.case.trapped',
  paths: 'quality.case.paths',
  'building-space': 'quality.case.building-space',
  hills: 'quality.case.hills',
  water: 'quality.case.water',
  spacing: 'quality.case.spacing',
  chokepoints: 'quality.case.chokepoints',
  variation: 'quality.case.variation',
  looks: 'quality.case.looks',
};

export function qualityCaseTitle(caseId: string): OutputText | string {
  return isQualityCaseId(caseId) ? { id: qualityCaseTitles[caseId] } : caseId;
}

export function qualityCaseTitleId(caseId: QualityCaseId): MessageId {
  return qualityCaseTitles[caseId];
}

export const qualityOutputLineBudget = 40;

export function qualityLevelSeverity(level: MapTestQualityLevel): OutputSeverity {
  return level === 'failure' ? 'error' : level === 'warning' ? 'warning' : 'info';
}

export function isQualityReport(
  report: MapTestReport,
): report is MapTestReport & { quality: MapTestQuality } {
  return report.script.name === qualityScriptName && report.quality !== undefined;
}

function itemTexts(item: MapTestQualityItem): { headline: OutputText; cause: OutputText } {
  const seeds = item.worst.map((worst) => String(worst.seed));
  return {
    headline: {
      id: 'quality.item.headline',
      args: { case: qualityCaseTitle(item.case), message: item.message.trim() },
    },
    cause: {
      id: 'quality.item.cause',
      args: {
        bad: item.bad,
        of: item.of,
        metric: item.metric ? 'yes' : 'no',
        p50: item.metric?.p50 ?? 0,
        p95: item.metric?.p95 ?? 0,
        max: item.metric?.max ?? 0,
        unit: item.metric?.unit ?? '',
        worst: seeds.length > 0 ? 'yes' : 'no',
        count: seeds.length,
        seeds,
      },
    },
  };
}

function itemDetail(item: MapTestQualityItem): string {
  const lines = [`${item.case}/${item.code}: ${item.bad} of ${item.of}`];
  if (item.metric) {
    const { label, unit, p5, p50, p95, max } = item.metric;
    lines.push(`${label} (${unit}): p5 ${p5}, p50 ${p50}, p95 ${p95}, max ${max}`);
  }
  for (const worst of item.worst) {
    const parts = [`seed ${worst.seed}`];
    if (worst.settingsIndex !== undefined) parts.push(`setting ${worst.settingsIndex + 1}`);
    if (worst.value !== undefined) parts.push(`value ${worst.value}`);
    if (worst.players) parts.push(`players ${worst.players.join(', ')}`);
    if (worst.tile) parts.push(`tile ${worst.tile[0]}, ${worst.tile[1]}`);
    lines.push(parts.join(' · '));
  }
  return lines.join('\n');
}

export function qualityItemMessage(item: MapTestQualityItem): OutputMessage {
  const { headline, cause } = itemTexts(item);
  return outputNote('Quality check', `quality-check.${item.case}.${item.code}`, headline, {
    severity: qualityLevelSeverity(item.level),
    cause,
    detail: itemDetail(item),
  });
}

export function qualityCheckOutputMessages(quality: MapTestQuality): OutputMessage[] {
  const tail: OutputMessage[] = [];
  if (quality.passed.length > 0) {
    tail.push(
      outputNote('Quality check', 'quality-check.passed', {
        id: 'quality.passed',
        args: { cases: quality.passed.map(qualityCaseTitle) },
      }),
    );
  }
  const reserved = tail.length + 1;
  const room = Math.max(0, Math.floor((qualityOutputLineBudget - reserved) / 2));
  const shown = quality.items.slice(0, room);
  const omitted = quality.omittedItems + (quality.items.length - shown.length);
  const rows = shown.map(qualityItemMessage);
  rows.push(...tail);
  if (omitted > 0) {
    rows.push(
      outputNote('Quality check', 'quality-check.omitted', {
        id: 'quality.omitted',
        args: { count: omitted },
      }),
    );
  }
  return rows;
}

export function qualityCheckResult(quality: MapTestQuality): {
  result: 'passed' | 'test-warnings' | 'test-failed';
  label: MessageId;
} {
  switch (quality.result) {
    case 'passed':
      return { result: 'passed', label: 'run-menu.result.passed' };
    case 'warnings':
      return { result: 'test-warnings', label: 'run-menu.result.warnings' };
    default:
      return { result: 'test-failed', label: 'run-menu.result.failed' };
  }
}

export function mapTestOutcome(
  status: 'passed' | 'failed',
  quality: MapTestQuality | undefined,
): ReturnType<typeof qualityCheckResult> {
  if (status === 'failed') return { result: 'test-failed', label: 'run-menu.result.failed' };
  return quality && quality.result !== 'passed'
    ? qualityCheckResult(quality)
    : { result: 'passed', label: 'run-menu.result.passed' };
}

export function qualityProblemDiagnostics(quality: MapTestQuality): LanguageServerDiagnostic[] {
  return quality.items
    .filter((item) => item.level !== 'advice')
    .map((item) => ({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: item.level === 'failure' ? 1 : 2,
      code: `${item.case}/${item.code}`,
      message: item.message,
      data: { qualityItem: structuredClone(item) },
    }));
}

export function qualityProblemMessage(
  diagnostic: LanguageServerDiagnostic,
  severity: OutputSeverity,
): OutputMessage | null {
  const data = diagnostic.data;
  if (!data || typeof data !== 'object' || !('qualityItem' in data)) return null;
  const item = (data as { qualityItem?: unknown }).qualityItem;
  if (!isQualityItemShape(item)) return null;
  return { ...qualityItemMessage(item), severity };
}

function isQualityItemShape(value: unknown): value is MapTestQualityItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<MapTestQualityItem>;
  return (
    typeof item.case === 'string' &&
    typeof item.code === 'string' &&
    typeof item.message === 'string' &&
    (item.level === 'failure' || item.level === 'warning' || item.level === 'advice') &&
    Number.isSafeInteger(item.bad) &&
    Number.isSafeInteger(item.of) &&
    Array.isArray(item.worst) &&
    item.worst.every(
      (worst) => !!worst && typeof worst === 'object' && Number.isSafeInteger(worst.seed),
    ) &&
    (item.metric === undefined || (typeof item.metric === 'object' && item.metric !== null))
  );
}

export interface QualityWorstSeed {
  key: string;
  seed: number;
  settingsIndex: number | undefined;
  findingId: string | null;
}

export interface QualityItemEntry {
  key: string;
  message: OutputMessage;
  seeds: QualityWorstSeed[];
}

export interface QualityCaseGroup {
  key: string;
  caseId: string;
  title: OutputText | string;
  severity: OutputSeverity;
  entries: QualityItemEntry[];
}

export interface QualityResultsModel {
  result: MapTestQuality['result'];
  mapName: string;
  maps: number;
  failures: number;
  warnings: number;
  items: number;
  groups: QualityCaseGroup[];
}

const severityRank: Record<OutputSeverity, number> = { error: 0, warning: 1, info: 2 };

function worstFinding(
  findings: readonly MapTestFinding[],
  item: MapTestQualityItem,
  seed: number,
  settingsIndex: number | undefined,
): MapTestFinding | undefined {
  const code = `${item.case}/${item.code}`;
  return findings.find(
    (finding) =>
      finding.code === code && finding.seed === seed && finding.settingsIndex === settingsIndex,
  );
}

export function qualityResultsModel(
  report: MapTestReport & { quality: MapTestQuality },
  mapUri?: string | null,
): QualityResultsModel {
  const { quality } = report;
  const order = new Map(quality.cases.map((caseId, index) => [caseId, index]));
  const groups = new Map<string, QualityCaseGroup>();
  for (const item of quality.items) {
    let group = groups.get(item.case);
    if (!group) {
      group = {
        key: item.case,
        caseId: item.case,
        title: qualityCaseTitle(item.case),
        severity: 'info',
        entries: [],
      };
      groups.set(item.case, group);
    }
    const severity = qualityLevelSeverity(item.level);
    if (severityRank[severity] < severityRank[group.severity]) group.severity = severity;
    group.entries.push({
      key: `${item.case}/${item.code}`,
      message: qualityItemMessage(item),
      seeds: item.worst.map((worst, index) => ({
        key: `${index}:${worst.seed}:${worst.settingsIndex ?? ''}`,
        seed: worst.seed,
        settingsIndex: worst.settingsIndex,
        findingId:
          worstFinding(report.findings, item, worst.seed, worst.settingsIndex)?.findingId ?? null,
      })),
    });
  }
  const sorted = [...groups.values()].sort(
    (left, right) =>
      (order.get(left.caseId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.caseId) ?? Number.MAX_SAFE_INTEGER),
  );
  const mapPath = mapUri ? decodeUriPath(mapUri) : report.findings[0]?.sourcePath;
  return {
    result: quality.result,
    mapName: mapPath ? readableName(mapPath) : qualityScriptName,
    maps: quality.samples,
    failures: quality.counts.failures,
    warnings: quality.counts.warnings,
    items: quality.items.length,
    groups: sorted,
  };
}

function decodeUriPath(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
  }
}

function readableName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}
