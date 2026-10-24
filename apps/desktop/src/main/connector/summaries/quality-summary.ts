import type {
  MapTestQuality,
  MapTestQualityItem,
  MapTestQualityWorst,
  MapTestReport,
  MapTestRunResult,
} from '../../../shared/api';
import { appTeamsText } from '../../../shared/connector-run-api';
import { ConnectorToolError } from '../dispatcher';
import { fitToCap, pageToCap, round1, shorten } from './budget';
import { crashSummaries, roundedMeasurements } from './map-test-summary';

export const qualityCaps = Object.freeze({ summary: 4_000, details: 6_000 });

const worstListed = 3;

export interface QualitySettingRef {
  id: string;
  index: number;
  mapSize: string;
  width: number;
  height: number;
  players: { slot: number; team: number; civilizationId: number; color: number }[];
  label: string;
}

function usesBaseSettings(report: MapTestReport): boolean {
  if (!report.settingsVariants || report.settingsVariants.length === 0) return true;
  if (report.findings.some((finding) => finding.settingsIndex === undefined)) return true;
  return (report.quality?.items ?? []).some((item) =>
    item.worst.some((worst) => worst.settingsIndex === undefined),
  );
}

function settingLabel(setting: {
  mapSize: string;
  width: number;
  height: number;
  players: { team: number }[];
}): string {
  const count = setting.players.length;
  return `${setting.mapSize} ${setting.width}x${setting.height} · ${count} ${
    count === 1 ? 'player' : 'players'
  } · ${appTeamsText(setting.players.map((player) => player.team))}`;
}

export function qualitySettings(report: MapTestReport): QualitySettingRef[] {
  const refs: QualitySettingRef[] = [];
  if (usesBaseSettings(report)) {
    const base = report.settings;
    refs.push({
      id: 's1',
      index: -1,
      mapSize: base.mapSize,
      width: base.width,
      height: base.height,
      players: base.players,
      label: settingLabel(base),
    });
  }
  (report.settingsVariants ?? []).forEach((variant, index) => {
    refs.push({
      id: `s${refs.length + 1}`,
      index,
      mapSize: variant.mapSize,
      width: variant.width,
      height: variant.height,
      players: variant.players,
      label: settingLabel(variant),
    });
  });
  return refs;
}

function settingId(
  refs: readonly QualitySettingRef[],
  index: number | undefined,
): string | undefined {
  return refs.find((ref) => ref.index === (index ?? -1))?.id;
}

function seedRange(quality: MapTestQuality): string {
  if (quality.seedCount <= 1) return String(quality.seedStart);
  const last = (quality.seedStart + quality.seedCount - 1) % 0x1_0000_0000;
  return `${quality.seedStart}-${last}`;
}

function worstWhat(item: MapTestQualityItem, worst: MapTestQualityWorst): string | undefined {
  const parts: string[] = [];
  if (worst.value !== undefined) {
    parts.push(`${round1(worst.value)}${item.metric?.unit ? ` ${item.metric.unit}` : ''}`);
  }
  if (worst.players && worst.players.length > 0) {
    parts.push(`players ${worst.players.map((value) => round1(value)).join('/')}`);
  }
  if (worst.tile) parts.push(`at [${worst.tile[0]},${worst.tile[1]}]`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function itemSummary(
  item: MapTestQualityItem,
  refs: readonly QualitySettingRef[],
  worstLimit: number,
): Record<string, unknown> {
  return {
    case: item.case,
    code: item.code,
    maps: `${item.bad}/${item.of}`,
    msg: shorten(item.message, 200),
    worst: item.worst.slice(0, worstLimit).map((worst) => ({
      seed: worst.seed,
      set: refs.length > 1 ? settingId(refs, worst.settingsIndex) : undefined,
      what: worstWhat(item, worst),
    })),
    spread: item.metric
      ? `${item.metric.label}: p5 ${round1(item.metric.p5)}, p50 ${round1(item.metric.p50)}, p95 ${round1(item.metric.p95)}, max ${round1(item.metric.max)}${item.metric.unit ? ` ${item.metric.unit}` : ''}`
      : undefined,
  };
}

export function qualitySummary(run: string, result: MapTestRunResult): string {
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
            ? result.diagnostics.slice(0, 5).map((diagnostic) => ({
                msg: shorten(diagnostic.message, 200),
              }))
            : [{ msg: 'The quality check ended with an error.' }],
      },
      qualityCaps.summary,
      ['errors'],
      ['run', 'status'],
    );
  }
  const quality = report.quality;
  if (!quality) {
    throw new ConnectorToolError('internal', 'The quality check returned no quality results.', {
      hint: 'Try again; if it keeps failing, ask the user to look at the Output in AoE2RMSIDE.',
    });
  }
  const refs = qualitySettings(report);
  const failures = quality.items.filter((item) => item.level === 'failure');
  const warnings = quality.items.filter((item) => item.level === 'warning');
  const advice = quality.items.filter((item) => item.level === 'advice');
  const crashes = crashSummaries(report);
  const firstCase = failures[0] ?? warnings[0];
  const firstWorst = firstCase?.worst[0];
  const asks: string[] = [];
  if (firstCase) {
    asks.push(`get_details {id:'${run}', part:'findings', case:'${firstCase.case}'}`);
  }
  if (firstWorst) {
    const set = settingId(refs, firstWorst.settingsIndex);
    asks.push(
      `generate_map {from_run:{run:'${run}', seed:${firstWorst.seed}${set ? `, setting:'${set}'` : ''}}}`,
    );
  }
  if (quality.omittedItems > 0)
    asks.push(`${quality.omittedItems} more cases left out by the check`);
  const value: Record<string, unknown> = {
    run,
    status: report.status === 'cancelled' ? 'cancelled' : quality.result,
    maps: quality.samples,
    seeds: seedRange(quality),
    settings: refs.map((ref) => ({ id: ref.id, is: ref.label })),
    time_s: time,
    failed_maps: quality.failedSamples > 0 ? quality.failedSamples : undefined,
    failed: failures.map((item) => itemSummary(item, refs, worstListed)),
    warnings: warnings.map((item) => itemSummary(item, refs, worstListed)),
    advice: advice.map((item) => ({ case: item.case, msg: shorten(item.message, 200) })),
    crashes: crashes.map((crash) => ({
      id: crash.id,
      maps: crash.maps,
      seeds: [...crash.seeds].sort((a, b) => a - b).slice(0, 5),
    })),
    passed: quality.passed,
    off: quality.skipped
      .filter((entry) => entry.reason === 'not-selected')
      .map((entry) => entry.case),
    not_applicable: quality.skipped
      .filter((entry) => entry.reason !== 'not-selected')
      .map((entry) => entry.case),
    more: asks.length > 0 ? { ask: asks.join(' · ') } : undefined,
  };
  return fitToCap(
    value,
    qualityCaps.summary,
    ['advice', 'crashes', 'warnings', 'failed', 'settings'],
    ['run', 'status', 'maps', 'seeds'],
  );
}

export function qualityDetails(
  run: string,
  result: MapTestRunResult,
  request: {
    part: string;
    case?: string;
    seed?: number;
    setting?: string;
    cursor?: unknown;
    limit: number;
  },
): string {
  const report = result.report;
  const quality = report?.quality;
  if (!report || !quality) {
    throw new ConnectorToolError(
      'not_found',
      `${run} has no quality results; it ended with an error.`,
    );
  }
  const refs = qualitySettings(report);
  let setting: QualitySettingRef | undefined;
  if (request.setting !== undefined) {
    setting = refs.find((ref) => ref.id === request.setting);
    if (!setting) {
      throw new ConnectorToolError(
        'not_found',
        `${run} has the settings ${refs.map((ref) => ref.id).join(', ')}, not ${request.setting}.`,
      );
    }
  }
  let items: readonly unknown[];
  const scope = `${run}:${request.part}:${request.case ?? ''}:${request.seed ?? ''}:${request.setting ?? ''}`;
  switch (request.part) {
    case 'findings':
      items = report.findings
        .filter((finding) => {
          const caseId = (finding.code ?? '').split('/')[0];
          return (
            (request.case === undefined || caseId === request.case) &&
            (request.seed === undefined || finding.seed === request.seed) &&
            (setting === undefined || (finding.settingsIndex ?? -1) === setting.index)
          );
        })
        .map((finding) => ({
          case: (finding.code ?? '').split('/')[0] || undefined,
          code: finding.code ?? undefined,
          seed: finding.seed,
          set: refs.length > 1 ? settingId(refs, finding.settingsIndex) : undefined,
          msg: shorten(finding.message, 200),
          values: roundedMeasurements(finding.measurements),
        }));
      break;
    case 'case': {
      if (request.case === undefined) {
        throw new ConnectorToolError('invalid_arguments', 'The part case needs case.', {
          hint: `Pass case, for example get_details {id:'${run}', part:'case', case:'trapped'}.`,
        });
      }
      const caseItems = quality.items.filter((item) => item.case === request.case);
      const state = quality.passed.includes(request.case)
        ? 'passed'
        : quality.skipped.find((entry) => entry.case === request.case)?.reason;
      items = caseItems.map((item) => ({
        ...itemSummary(item, refs, item.worst.length),
        level: item.level,
        worst: item.worst
          .filter((worst) => setting === undefined || (worst.settingsIndex ?? -1) === setting.index)
          .map((worst) => ({
            seed: worst.seed,
            set: refs.length > 1 ? settingId(refs, worst.settingsIndex) : undefined,
            value: worst.value === undefined ? undefined : round1(worst.value),
            players: worst.players,
            tile: worst.tile,
          })),
      }));
      if (caseItems.length === 0)
        items = [{ case: request.case, status: state ?? 'not in this check' }];
      break;
    }
    case 'crashes':
      items = crashSummaries(report).map((crash) => ({
        id: crash.id,
        maps: crash.maps,
        seeds: [...crash.seeds].sort((a, b) => a - b),
      }));
      break;
    default:
      throw new ConnectorToolError(
        'invalid_arguments',
        `A quality check has the parts findings, case and crashes, not ${request.part}.`,
      );
  }
  return pageToCap({ id: run, part: request.part }, items, {
    cap: qualityCaps.details,
    limit: request.limit,
    cursor: request.cursor,
    scope,
  });
}
