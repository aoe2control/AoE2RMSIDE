import type { MapTestFinding, MapTestReport, MapTestRunResult } from '../../../shared/api';
import { qualityCaseIds } from '../../../shared/quality-check';
import { ConnectorToolError } from '../dispatcher';
import { fitToCap, pageToCap, round1, shorten } from './budget';

export const mapTestCaps = Object.freeze({ summary: 3_000, details: 6_000 });

const qualityItemsListed = 6;

function isQualityFinding(report: MapTestReport, finding: MapTestFinding): boolean {
  if (!report.quality || !finding.code) return false;
  const slash = finding.code.indexOf('/');
  return slash > 0 && (qualityCaseIds as readonly string[]).includes(finding.code.slice(0, slash));
}

export function scriptFindingsReport(report: MapTestReport): MapTestReport {
  if (!report.quality) return report;
  return { ...report, findings: report.findings.filter((f) => !isQualityFinding(report, f)) };
}

const seedsListed = 5;
const measurementsListed = 8;

export interface AssertionGroup {
  id: string;
  key: string;
  line: number;
  code: string | null;
  msg: string;
  seeds: number[];
  maps: number;
  findings: number;
}

export function checkKey(finding: MapTestFinding): string {
  const what =
    finding.code !== null ? `code:${finding.code}` : `msg:${messageTemplate(finding.message)}`;
  return `${finding.scriptLine}:${finding.scriptColumn}:${what}`;
}

function messageTemplate(message: string): string {
  return message
    .replace(/\d+(?:[.,]\d+)*/gu, '#')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function assertionGroups(report: MapTestReport): AssertionGroup[] {
  const groups = new Map<
    string,
    AssertionGroup & { column: number; first: number; mapKeys: Set<string> }
  >();
  report.findings.forEach((finding, index) => {
    const key = checkKey(finding);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: '',
        key,
        line: finding.scriptLine,
        column: finding.scriptColumn,
        code: finding.code,
        msg: finding.message,
        seeds: [],
        maps: 0,
        findings: 0,
        first: index,
        mapKeys: new Set(),
      };
      groups.set(key, group);
    }
    group.findings += 1;
    if (!group.seeds.includes(finding.seed)) group.seeds.push(finding.seed);
    group.mapKeys.add(`${finding.seed}:${finding.settingsIndex ?? ''}`);
  });
  return [...groups.values()]
    .map((group) => ({ ...group, maps: group.mapKeys.size }))
    .sort(
      (a, b) =>
        b.maps - a.maps ||
        b.findings - a.findings ||
        a.line - b.line ||
        a.column - b.column ||
        a.first - b.first,
    )
    .map((group, index) => ({
      id: `a${index + 1}`,
      key: group.key,
      line: group.line,
      code: group.code,
      msg: group.msg,
      seeds: sortedSeeds(group.seeds),
      maps: group.maps,
      findings: group.findings,
    }));
}

export interface CrashSummary {
  id: string;
  maps: number;
  seeds: number[];
}

export function crashSummaries(report: MapTestReport): CrashSummary[] {
  const crashes = new Map<string, CrashSummary>();
  for (const source of report.gameCrashes?.sources ?? []) {
    for (const crash of source.crashes) {
      const entry = crashes.get(crash.crashId) ?? { id: crash.crashId, maps: 0, seeds: [] };
      entry.maps += crash.maps;
      for (const seed of crash.seeds) if (!entry.seeds.includes(seed)) entry.seeds.push(seed);
      crashes.set(crash.crashId, entry);
    }
  }
  return [...crashes.values()];
}

function sortedSeeds(seeds: readonly number[]): number[] {
  return [...seeds].sort((a, b) => a - b);
}

function diagnosticsErrors(result: MapTestRunResult): Record<string, unknown>[] {
  return result.diagnostics.slice(0, 5).map((diagnostic) => ({
    line: diagnostic.range.start.line + 1,
    msg: shorten(diagnostic.message, 200),
  }));
}

export function mapTestSummary(
  run: string,
  result: MapTestRunResult,
  options: { note?: string } = {},
): string {
  const time = round1(result.elapsedMilliseconds / 1000);
  const report = result.report;
  if (result.status === 'error' || !report) {
    return fitToCap(
      {
        run,
        status: 'error',
        time_s: time,
        errors:
          result.diagnostics.length > 0
            ? diagnosticsErrors(result)
            : [{ msg: 'The map test ended with an error.' }],
        note: options.note,
      },
      mapTestCaps.summary,
      ['errors'],
      ['run', 'status'],
    );
  }
  const own = scriptFindingsReport(report);
  const groups = assertionGroups(own);
  const crashes = crashSummaries(report);
  const quality = report.quality;
  const value: Record<string, unknown> = {
    run,
    status: report.status,
    maps: report.generatedMaps,
    assertions: report.assertionCount,
    time_s: time,
    failed: groups.map((group) => ({
      id: group.id,
      line: group.line,
      ...(group.code ? { code: group.code } : {}),
      msg: shorten(group.msg, 200),
      maps: group.maps,
      seeds: group.seeds.slice(0, seedsListed),
    })),
    crashes: crashes.map((crash) => ({
      id: crash.id,
      maps: crash.maps,
      seeds: sortedSeeds(crash.seeds).slice(0, seedsListed),
    })),
    passed: Math.max(
      0,
      report.assertionCount -
        own.findings.length -
        (quality ? quality.counts.failures + quality.counts.warnings + quality.counts.advice : 0),
    ),
    quality: quality
      ? {
          result: quality.result,
          failures: quality.counts.failures,
          warnings: quality.counts.warnings,
          advice: quality.counts.advice,
          items: quality.items.slice(0, qualityItemsListed).map((item) => ({
            case: item.case,
            code: item.code,
            level: item.level,
            maps: `${item.bad}/${item.of}`,
            msg: shorten(item.message, 160),
          })),
        }
      : undefined,
    print_lines: report.output.length > 0 ? report.output.length : undefined,
    note: options.note,
  };
  const asks: string[] = [];
  if (groups.length > 0) {
    asks.push(`get_details {id:'${run}', part:'findings', assertion:'${groups[0]!.id}'}`);
  }
  if (crashes.length > 0) asks.push(`get_details {id:'${run}', part:'crashes'}`);
  if (report.output.length > 0) asks.push(`get_details {id:'${run}', part:'output'}`);
  if (asks.length > 0) value.more = { ask: asks.join(' · ') };
  return fitToCap(
    value,
    mapTestCaps.summary,
    ['failed', 'crashes'],
    ['run', 'status', 'maps', 'assertions', 'passed'],
  );
}

export function roundedMeasurements(
  measurements: MapTestFinding['measurements'],
): Record<string, boolean | number | string | null> {
  const entries = Object.entries(measurements).slice(0, measurementsListed);
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      typeof value === 'number'
        ? round1(value)
        : typeof value === 'string'
          ? shorten(value, 80)
          : value,
    ]),
  );
}

export function mapTestDetails(
  run: string,
  result: MapTestRunResult,
  request: { part: string; assertion?: string; seed?: number; cursor?: unknown; limit: number },
): string {
  const report = result.report;
  if (!report) {
    throw new ConnectorToolError('not_found', `${run} has no report; it ended with an error.`);
  }
  let items: readonly unknown[];
  let scope = `${run}:${request.part}`;
  switch (request.part) {
    case 'findings': {
      const own = scriptFindingsReport(report);
      const groups = assertionGroups(own);
      const byKey = new Map(groups.map((group, index) => [group.key, { group, index }]));
      let key: string | undefined;
      if (request.assertion !== undefined) {
        key = groups.find((group) => group.id === request.assertion)?.key;
        if (!key) {
          throw new ConnectorToolError(
            'not_found',
            `${run} has no assertion ${request.assertion}; it has ${groups.length === 0 ? 'no failed assertions' : groups.map((group) => group.id).join(', ')}.`,
          );
        }
      }
      items = own.findings
        .map((finding) => ({ finding, entry: byKey.get(checkKey(finding))! }))
        .filter(
          ({ finding, entry }) =>
            (key === undefined || entry.group.key === key) &&
            (request.seed === undefined || finding.seed === request.seed),
        )
        .sort(
          (a, b) =>
            a.entry.index - b.entry.index ||
            a.finding.seed - b.finding.seed ||
            (a.finding.settingsIndex ?? -1) - (b.finding.settingsIndex ?? -1),
        )
        .map(({ finding, entry: { group } }) => ({
          assertion: group.id,
          seed: finding.seed,
          ...(finding.message === group.msg ? {} : { msg: shorten(finding.message, 200) }),
          values: roundedMeasurements(finding.measurements),
        }));
      scope += `:${request.assertion ?? ''}:${request.seed ?? ''}`;
      break;
    }
    case 'output':
      items = report.output.map((line) => shorten(line, 300));
      break;
    case 'crashes':
      items = crashSummaries(report).map((crash) => ({
        id: crash.id,
        maps: crash.maps,
        seeds: sortedSeeds(crash.seeds),
      }));
      break;
    default:
      throw new ConnectorToolError(
        'invalid_arguments',
        `A map test has the parts findings, output and crashes, not ${request.part}.`,
      );
  }
  return pageToCap({ id: run, part: request.part }, items, {
    cap: mapTestCaps.details,
    limit: request.part === 'output' ? Math.min(request.limit, 50) : request.limit,
    cursor: request.cursor,
    scope,
  });
}
