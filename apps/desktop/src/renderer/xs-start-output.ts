import type { LanguageServerDiagnostic } from '../shared/api';
import type { MessageId } from '../shared/i18n/translator';
import {
  engineSentence,
  outputNote,
  type OutputMessage,
  type OutputSeverity,
  type OutputText,
} from '../shared/output-message';
import type {
  XsStartChange,
  XsStartFinding,
  XsStartOutcome,
  XsStartPlace,
  XsStartReport,
  XsStartStop,
  XsUnansweredReason,
  XsUnconfirmedTopic,
} from '../shared/xs-start';
import { readableSourceName } from './problems-model';

export const maximumXsStartRows = 150;

export interface XsStartOutputOptions {
  objectName?: (objectId: number) => string | null;
  maximumRows?: number;
}

const findingTemplates: Readonly<Record<string, MessageId>> = {
  XS5001: 'output.xs-start.finding.xs5001',
  XS5002: 'output.xs-start.finding.xs5002',
  XS5003: 'output.xs-start.finding.xs5003',
  XS5004: 'output.xs-start.finding.xs5004',
  XS5005: 'output.xs-start.finding.xs5005',
  XS5006: 'output.xs-start.finding.xs5006',
  XS5007: 'output.xs-start.finding.xs5007',
  XS5008: 'output.xs-start.finding.xs5008',
  XS5010: 'output.xs-start.finding.xs5010',
  XS5011: 'output.xs-start.finding.xs5011',
  XS5020: 'output.xs-start.finding.xs5020',
  XS5021: 'output.xs-start.finding.xs5021',
};

const requiredArguments: Readonly<Record<string, readonly string[]>> = {
  XS5001: ['limit'],
  XS5002: ['depth'],
  XS5003: ['array', 'index', 'size'],
  XS5004: ['array', 'value'],
  XS5007: ['value'],
  XS5008: ['bound'],
  XS5010: ['call'],
  XS5020: ['rule'],
};

const reasonTexts: Readonly<Record<XsUnansweredReason, MessageId>> = {
  'lobby-setting': 'output.xs-start.reason.lobby-setting',
  'object-data': 'output.xs-start.reason.object-data',
  'technology-data': 'output.xs-start.reason.technology-data',
  'text-table': 'output.xs-start.reason.text-table',
  'game-runtime': 'output.xs-start.reason.game-runtime',
  'not-in-map-scripts': 'output.xs-start.reason.not-in-map-scripts',
  'unknown-call': 'output.xs-start.reason.unknown-call',
};

const topicTexts: Readonly<Record<XsUnconfirmedTopic, MessageId>> = {
  'integer-arithmetic': 'output.xs-start.topic.integer-arithmetic',
  'mixed-numbers': 'output.xs-start.topic.mixed-numbers',
  'number-text': 'output.xs-start.topic.number-text',
  'text-functions': 'output.xs-start.topic.text-functions',
  'array-defaults': 'output.xs-start.topic.array-defaults',
  'rule-order': 'output.xs-start.topic.rule-order',
  goto: 'output.xs-start.topic.goto',
  'start-defaults': 'output.xs-start.topic.start-defaults',
};

const resourceTexts: Readonly<Record<string, MessageId>> = {
  '0': 'output.xs-start.resource.food',
  '1': 'output.xs-start.resource.wood',
  '2': 'output.xs-start.resource.stone',
  '3': 'output.xs-start.resource.gold',
  cAttributeFood: 'output.xs-start.resource.food',
  cAttributeWood: 'output.xs-start.resource.wood',
  cAttributeStone: 'output.xs-start.resource.stone',
  cAttributeGold: 'output.xs-start.resource.gold',
};

function reasonFromArgument(value: string | undefined): XsUnansweredReason | null {
  if (!value) return null;
  const key = value
    .trim()
    .replace(/^XS_UNANSWERED_REASON_/u, '')
    .replace(/([a-z])([A-Z])/gu, '$1-$2')
    .replaceAll('_', '-')
    .toLowerCase();
  return (key in reasonTexts ? key : 'unknown-call') as XsUnansweredReason;
}

function integerArgument(value: string | undefined): number | string {
  if (value !== undefined && /^-?\d{1,15}$/u.test(value.trim())) return Number(value.trim());
  return value ?? '';
}

export function xsStartFindingText(
  finding: Pick<XsStartFinding, 'code' | 'arguments'>,
  stop: XsStartStop | null = null,
): OutputText | null {
  const id = findingTemplates[finding.code];
  if (!id) return null;
  const args = finding.arguments;
  if (!(requiredArguments[finding.code] ?? []).every((name) => (args[name] ?? '') !== '')) {
    return null;
  }
  switch (finding.code) {
    case 'XS5001':
      return { id, args: { limit: integerArgument(args.limit) } };
    case 'XS5002':
      return { id, args: { depth: integerArgument(args.depth) } };
    case 'XS5003':
      return {
        id,
        args: {
          access: args.access === 'write' ? 'write' : 'read',
          array: args.array!,
          index: args.index!,
          size: integerArgument(args.size),
          value: args.value ?? '',
        },
      };
    case 'XS5004':
      return { id, args: { array: args.array!, value: args.value! } };
    case 'XS5007':
      return { id, args: { value: args.value! } };
    case 'XS5008':
      return { id, args: { bound: args.bound! } };
    case 'XS5010': {
      const reason =
        reasonFromArgument(args.reason) ??
        (stop?.code === 'XS5010' ? stop.reason : null) ??
        'unknown-call';
      return { id, args: { call: args.call!, reason: { id: reasonTexts[reason] } } };
    }
    case 'XS5011':
      return { id };
    case 'XS5020':
      return { id, args: { rule: args.rule! } };
    default:
      return { id };
  }
}

function placeText(place: XsStartPlace): OutputText {
  return {
    id: 'message.format.file-line',
    args: { name: readableSourceName(place.sourceId), line: place.line },
  };
}

function playerText(player: number): OutputText {
  return { id: 'output.xs-start.player', args: { player } };
}

function coordinate(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function objectText(change: XsStartChange, options: XsStartOutputOptions): string | OutputText {
  const name = options.objectName?.(change.targetId);
  return name ? name : { id: 'output.xs-start.object', args: { id: change.targetId } };
}

function technologyText(change: XsStartChange): string | OutputText {
  return change.targetConstant
    ? change.targetConstant
    : { id: 'output.xs-start.technology', args: { id: change.targetId } };
}

function resourceText(change: XsStartChange): string | OutputText {
  const id =
    resourceTexts[change.targetConstant] ??
    (change.targetConstant ? undefined : resourceTexts[String(change.targetId)]);
  if (id) return { id };
  return change.targetConstant
    ? change.targetConstant
    : { id: 'output.xs-start.resource.attribute', args: { id: change.targetId } };
}

function amountText(change: XsStartChange): OutputText {
  const resource = resourceText(change);
  const amount = Math.round(change.amount * 1000) / 1000;
  if (change.operation === 'set') {
    return { id: 'output.xs-start.amount.set', args: { resource, amount } };
  }
  if (change.operation === 'multiply') {
    return { id: 'output.xs-start.amount.multiply', args: { resource, amount } };
  }
  return { id: 'output.xs-start.amount.add', args: { resource, amount } };
}

function changeDetail(changes: readonly XsStartChange[]): string {
  return changes
    .map((change) => {
      const where = change.place
        ? `  ${readableSourceName(change.place.sourceId)}:${change.place.line}`
        : '';
      return `${change.call || '?'} ×${change.calls}${where}`;
    })
    .join('\n');
}

function changeText(change: XsStartChange, options: XsStartOutputOptions): OutputText {
  const player = playerText(change.player);
  const count = change.count;
  const position = change.position;
  switch (change.kind) {
    case 'technology':
      return {
        id: 'output.xs-start.change.technology',
        args: { player, technology: technologyText(change) },
      };
    case 'diplomacy':
      return {
        id: 'output.xs-start.change.diplomacy',
        args: { player, other: playerText(change.targetId), stance: change.valueId },
      };
    case 'player-name':
      return { id: 'output.xs-start.change.player-name', args: { player, text: change.text } };
    case 'civilization-name':
      return {
        id: 'output.xs-start.change.civilization-name',
        args: { player, text: change.text },
      };
    case 'player-color':
      return {
        id: 'output.xs-start.change.player-color',
        args: { player, value: change.valueId },
      };
    case 'color-mood':
      return { id: 'output.xs-start.change.color-mood', args: { value: change.valueId } };
    case 'units-created':
      return position
        ? {
            id: 'output.xs-start.change.units-created',
            args: {
              player,
              count,
              object: objectText(change, options),
              x: coordinate(position.x),
              y: coordinate(position.y),
            },
          }
        : {
            id: 'output.xs-start.change.units-created.no-position',
            args: { player, count, object: objectText(change, options) },
          };
    case 'units-removed':
      return {
        id: 'output.xs-start.change.units-removed',
        args: { player, count, object: objectText(change, options) },
      };
    case 'units-moved':
      return position
        ? {
            id: 'output.xs-start.change.units-moved',
            args: {
              player,
              count,
              object: objectText(change, options),
              x: coordinate(position.x),
              y: coordinate(position.y),
            },
          }
        : {
            id: 'output.xs-start.change.units-moved.no-position',
            args: { player, count, object: objectText(change, options) },
          };
    case 'units-owner-changed':
      return {
        id: 'output.xs-start.change.units-owner-changed',
        args: {
          player,
          count,
          object: objectText(change, options),
          previous: playerText(change.valueId),
        },
      };
    case 'unit-values':
      return {
        id: 'output.xs-start.change.unit-values',
        args: { player, count, object: objectText(change, options) },
      };
    case 'unit-text':
      return {
        id: 'output.xs-start.change.unit-text',
        args: { player, count, object: objectText(change, options) },
      };
    case 'object-data':
      return {
        id: 'output.xs-start.change.object-data',
        args: { player, object: objectText(change, options) },
      };
    case 'technology-data':
      return {
        id: 'output.xs-start.change.technology-data',
        args: { player, technology: technologyText(change) },
      };
    default:
      return {
        id: 'output.xs-start.change.other',
        args: { player, call: change.call || '?', calls: change.calls },
      };
  }
}

interface ChangeRow {
  text: OutputText;
  changes: XsStartChange[];
}

function changeRows(report: XsStartReport, options: XsStartOutputOptions): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const resources = new Map<number, ChangeRow>();
  for (const change of report.changes) {
    if (change.kind !== 'resource') {
      rows.push({ text: changeText(change, options), changes: [change] });
      continue;
    }
    let row = resources.get(change.player);
    if (!row) {
      row = {
        text: {
          id: 'output.xs-start.change.resources',
          args: { player: playerText(change.player), changes: [] },
        },
        changes: [],
      };
      resources.set(change.player, row);
      rows.push(row);
    }
    row.changes.push(change);
  }
  for (const row of resources.values()) {
    row.text = {
      id: 'output.xs-start.change.resources',
      args: {
        player: playerText(row.changes[0]!.player),
        changes: row.changes.slice(0, 32).map(amountText),
      },
    };
  }
  return rows;
}

function filesText(report: XsStartReport): string[] {
  const names = report.sourceIds.map(readableSourceName);
  return names.length > 0 ? names.slice(0, 32) : ['?'];
}

function summaryRow(report: XsStartReport): OutputMessage {
  const counts = { files: filesText(report), rules: report.rulesRun, steps: report.steps };
  const topics = report.unconfirmedTopics.map((topic) => ({ id: topicTexts[topic] }));
  const recorded = report.recordedCalls.map((call) => {
    const where = call.place
      ? `${readableSourceName(call.place.sourceId)}:${call.place.line}  `
      : '';
    return `${where}${call.text}`;
  });
  return outputNote(
    'XS',
    'xs-start.summary',
    {
      id: report.mainRan ? 'output.xs-start.summary' : 'output.xs-start.summary.no-main',
      args: counts,
    },
    {
      cause:
        topics.length > 0
          ? { id: 'output.xs-start.not-compared.uses', args: { topics } }
          : { id: 'output.xs-start.not-compared' },
      ...(recorded.length > 0 ? { detail: recorded.join('\n') } : {}),
    },
  );
}

const ownSeverityStopCodes: ReadonlySet<string> = new Set(['XS5010']);

function findingSeverity(finding: XsStartFinding, isStop: boolean): OutputSeverity {
  return isStop && !ownSeverityStopCodes.has(finding.code) ? 'error' : finding.severity;
}

function findingRow(
  finding: XsStartFinding,
  stop: XsStartStop | null,
  isStop: boolean,
): OutputMessage {
  const text = xsStartFindingText(finding, stop);
  const place = finding.place ?? (isStop ? (stop?.place ?? null) : null);
  const cause: OutputText | undefined = isStop
    ? place
      ? { id: 'output.xs-start.stop.place', args: { place: placeText(place) } }
      : { id: 'output.xs-start.stop.no-place' }
    : place
      ? placeText(place)
      : undefined;
  const severity = findingSeverity(finding, isStop);
  const headline =
    text ?? (finding.message.trim() ? engineSentence(finding.message) : finding.code);
  return outputNote('XS', finding.code, headline, {
    severity,
    ...(cause ? { cause } : {}),
    ...(finding.message ? { detail: finding.message } : {}),
  });
}

function stopFinding(report: XsStartReport, stop: XsStartStop): XsStartFinding {
  const args: Record<string, string> = {};
  if (stop.code === 'XS5001') args.limit = String(report.stepLimit);
  if (stop.code === 'XS5010') {
    args.call = stop.call;
    if (stop.reason) args.reason = stop.reason;
  }
  return {
    code: stop.code,
    severity: ownSeverityStopCodes.has(stop.code) ? 'info' : 'error',
    message: '',
    arguments: args,
    place: stop.place,
  };
}

function omittedRow(counts: {
  findings: number;
  chatLines: number;
  changes: number;
  recordedCalls: number;
}): OutputMessage | null {
  const items: OutputText[] = [];
  if (counts.findings > 0) {
    items.push({ id: 'output.xs-start.omitted.findings', args: { count: counts.findings } });
  }
  if (counts.chatLines > 0) {
    items.push({ id: 'output.xs-start.omitted.chat-lines', args: { count: counts.chatLines } });
  }
  if (counts.changes > 0) {
    items.push({ id: 'output.xs-start.omitted.changes', args: { count: counts.changes } });
  }
  if (counts.recordedCalls > 0) {
    items.push({
      id: 'output.xs-start.omitted.recorded-calls',
      args: { count: counts.recordedCalls },
    });
  }
  if (items.length === 0) return null;
  return outputNote(
    'XS',
    'xs-start.omitted',
    { id: 'output.xs-start.omitted' },
    { cause: { id: 'output.xs-start.omitted.cause', args: { items } } },
  );
}

export function xsStartOutputMessages(
  outcome: XsStartOutcome | undefined,
  options: XsStartOutputOptions = {},
): OutputMessage[] {
  if (!outcome) return [];
  if (outcome.kind === 'needs-game-folder') {
    return [
      outputNote('XS', 'xs-start.needs-game-folder', { id: 'output.xs-start.needs-game-folder' }),
    ];
  }
  const report = outcome.report;
  if (report.status === 'skipped-no-constants') {
    return [
      outputNote('XS', 'xs-start.needs-game-folder', { id: 'output.xs-start.needs-game-folder' }),
    ];
  }
  if (report.status === 'skipped-compile-errors') {
    const files =
      report.compileErrors.length > 0
        ? report.compileErrors
        : report.sourceIds.map((sourceId) => ({ sourceId, errors: 0 }));
    return files.slice(0, Math.max(1, options.maximumRows ?? maximumXsStartRows)).map((entry) =>
      outputNote('XS', 'xs-start.skipped', {
        id: 'output.xs-start.skipped',
        args: { file: readableSourceName(entry.sourceId), count: entry.errors },
      }),
    );
  }
  const maximumRows = Math.max(3, options.maximumRows ?? maximumXsStartRows);
  const stop = report.status === 'stopped' ? report.stop : null;
  const lastFinding = report.findings.at(-1);
  const stopFromFindings = stop !== null && lastFinding?.code === stop.code;
  const findings = stopFromFindings ? report.findings.slice(0, -1) : report.findings;
  const stopRow = stop
    ? findingRow(stopFromFindings ? lastFinding! : stopFinding(report, stop), stop, true)
    : null;
  let budget = maximumRows - 1 - (stopRow ? 1 : 0) - 1;
  const take = <T>(items: readonly T[]): { kept: T[]; left: number } => {
    const kept = items.slice(0, Math.max(0, budget));
    budget -= kept.length;
    return { kept, left: items.length - kept.length };
  };
  const serious = take(findings.filter((finding) => finding.severity !== 'info'));
  const chat = take(report.chatLines);
  const allChangeRows = changeRows(report, options);
  const changes = take(allChangeRows);
  const notes = take(findings.filter((finding) => finding.severity === 'info'));
  const keptFindings = new Set([...serious.kept, ...notes.kept]);
  const rows: OutputMessage[] = [summaryRow(report)];
  for (const line of chat.kept) {
    rows.push({
      ...outputNote(
        'XS',
        'xs-start.chat',
        { id: 'output.xs-start.chat', args: { text: line.text } },
        line.place ? { cause: placeText(line.place) } : {},
      ),
      monospace: true,
    });
  }
  for (const row of changes.kept) {
    const place = row.changes[0]!.place;
    rows.push(
      outputNote('XS', 'xs-start.change', row.text, {
        ...(place ? { cause: placeText(place) } : {}),
        detail: changeDetail(row.changes),
      }),
    );
  }
  for (const finding of findings) {
    if (keptFindings.has(finding)) rows.push(findingRow(finding, stop, false));
  }
  if (stopRow) rows.push(stopRow);
  const omitted = omittedRow({
    findings: report.omittedFindings + serious.left + notes.left,
    chatLines: report.omittedChatLines + chat.left,
    changes:
      report.omittedChanges +
      allChangeRows.slice(changes.kept.length).reduce((sum, row) => sum + row.changes.length, 0),
    recordedCalls: report.omittedRecordedCalls,
  });
  if (omitted) rows.push(omitted);
  return rows;
}

export function xsStartProblemDiagnostics(
  outcome: XsStartOutcome | undefined,
): Map<string, LanguageServerDiagnostic[]> {
  const byUri = new Map<string, LanguageServerDiagnostic[]>();
  if (outcome?.kind !== 'report') return byUri;
  const report = outcome.report;
  const stop = report.status === 'stopped' ? report.stop : null;
  for (const finding of report.findings) {
    const isStop =
      stop !== null && finding === report.findings.at(-1) && finding.code === stop.code;
    const severity = findingSeverity(finding, isStop);
    if (severity === 'info' || !finding.place) continue;
    const { place } = finding;
    const args =
      isStop && stop.reason && !finding.arguments.reason
        ? { ...finding.arguments, reason: stop.reason }
        : { ...finding.arguments };
    const diagnostics = byUri.get(place.sourceId) ?? [];
    diagnostics.push({
      range: {
        start: { line: place.line - 1, character: place.column - 1 },
        end: { line: place.endLine - 1, character: place.endColumn - 1 },
      },
      severity: severity === 'error' ? 1 : 2,
      code: finding.code,
      message: finding.message || finding.code,
      data: { xsStartFinding: { arguments: args } },
    });
    byUri.set(place.sourceId, diagnostics);
  }
  const finding =
    stop && report.findings.at(-1)?.code !== stop.code ? stopFinding(report, stop) : null;
  if (stop?.place && finding && finding.severity !== 'info') {
    const diagnostics = byUri.get(stop.place.sourceId) ?? [];
    diagnostics.push({
      range: {
        start: { line: stop.place.line - 1, character: stop.place.column - 1 },
        end: { line: stop.place.endLine - 1, character: stop.place.endColumn - 1 },
      },
      severity: 1,
      code: stop.code,
      message: stop.code,
      data: { xsStartFinding: { arguments: finding.arguments } },
    });
    byUri.set(stop.place.sourceId, diagnostics);
  }
  return byUri;
}

export function xsStartProblemMessage(
  diagnostic: LanguageServerDiagnostic,
  severity: OutputSeverity,
): OutputMessage | null {
  const data = diagnostic.data;
  if (!data || typeof data !== 'object' || !('xsStartFinding' in data)) return null;
  const finding = (data as { xsStartFinding?: unknown }).xsStartFinding;
  if (!finding || typeof finding !== 'object') return null;
  const rawArguments = (finding as { arguments?: unknown }).arguments;
  const args: Record<string, string> = {};
  if (rawArguments && typeof rawArguments === 'object') {
    for (const [name, value] of Object.entries(rawArguments)) {
      if (typeof value === 'string') args[name] = value;
    }
  }
  const code = String(diagnostic.code ?? '');
  const text = xsStartFindingText({ code, arguments: args });
  const message = diagnostic.message.trim();
  const headline = text ?? (message && message !== code ? engineSentence(message) : code);
  return outputNote('XS', code || 'XS5', headline, {
    severity,
    ...(message && message !== code ? { detail: diagnostic.message } : {}),
  });
}

export function xsStartChangesListed(outcome: XsStartOutcome | undefined): boolean {
  return (
    outcome?.kind === 'report' &&
    (outcome.report.status === 'completed' || outcome.report.status === 'stopped')
  );
}
