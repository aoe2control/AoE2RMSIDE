import { createHash } from 'node:crypto';
import {
  DiagnosticSeverity,
  XsStartChangeKind as ProtocolChangeKind,
  XsStartOperation as ProtocolOperation,
  XsStartStatus as ProtocolStatus,
  XsUnansweredReason as ProtocolReason,
  XsUnconfirmedTopic as ProtocolTopic,
  type SourceRange,
  type XsStartReport as ProtocolXsStartReport,
  type XsValue,
} from '../generated/rmside/v1/rmside_pb';
import {
  xsStartReportLimits,
  xsStartReportMajor,
  type XsStartChange,
  type XsStartChangeKind,
  type XsStartFinding,
  type XsStartOperation,
  type XsStartOutcome,
  type XsStartPlace,
  type XsStartReport,
  type XsStartStatus,
  type XsUnansweredReason,
  type XsUnconfirmedTopic,
} from '../shared/xs-start';

export const maximumXsGameConstantsBytes = 4 * 1024 * 1024;

export interface XsGameConstantsPayload {
  text: Uint8Array;
  sha256: Uint8Array;
}

let lastConstants: { text: string; payload: XsGameConstantsPayload | null } | null = null;

export function xsGameConstantsPayload(
  text: string | null | undefined,
): XsGameConstantsPayload | null {
  if (typeof text !== 'string') return null;
  if (lastConstants?.text === text) return lastConstants.payload;
  const bytes = Buffer.from(text, 'utf8');
  const payload =
    bytes.byteLength < 1 || bytes.byteLength > maximumXsGameConstantsBytes
      ? null
      : {
          text: new Uint8Array(bytes),
          sha256: new Uint8Array(createHash('sha256').update(bytes).digest()),
        };
  lastConstants = { text, payload };
  return payload;
}

export interface XsStartCheckRequest {
  constants: XsGameConstantsPayload | null;
}

export interface XsStartCheckConditions {
  capability: boolean;
  enabled: boolean;
  backend: 'exact' | 'synthetic';
  hasExternalXs: boolean;
}

export function xsStartCheckWanted(conditions: XsStartCheckConditions): boolean {
  return (
    conditions.capability &&
    conditions.enabled &&
    conditions.backend === 'exact' &&
    conditions.hasExternalXs
  );
}

export function xsStartCheckRequest(
  options: XsStartCheckConditions & { constantsText: string | null | undefined },
): XsStartCheckRequest | undefined {
  if (!xsStartCheckWanted(options)) return undefined;
  const constants = xsGameConstantsPayload(options.constantsText);
  return { constants };
}

export function xsStartRequestFields(
  capability: boolean,
  request: XsStartCheckRequest | undefined,
): { xsStartCheck?: true; xsConstants?: XsGameConstantsPayload } {
  if (!capability || !request?.constants) return {};
  return { xsStartCheck: true, xsConstants: request.constants };
}

export function mapTestXsConstantsField(
  capability: boolean,
  constantsText: string | null | undefined,
): { xsConstants?: XsGameConstantsPayload } {
  if (!capability) return {};
  const constants = xsGameConstantsPayload(constantsText);
  return constants ? { xsConstants: constants } : {};
}

let unknownMajorLogged = false;

export function resetXsStartReportLog(): void {
  unknownMajorLogged = false;
}

export function toXsStartOutcome(
  value: ProtocolXsStartReport | undefined,
  options: {
    request: XsStartCheckRequest | undefined;
    activeXsSourceIds: readonly string[];
    catalogSourceIds: ReadonlySet<string>;
    log?: (message: string) => void;
  },
): XsStartOutcome | undefined {
  if (!options.request) return undefined;
  if (value && options.request.constants) {
    const report = toXsStartReport(value, options.catalogSourceIds, options.log);
    return report ? { kind: 'report', report } : undefined;
  }
  if (!options.request.constants && options.activeXsSourceIds.length > 0) {
    return { kind: 'needs-game-folder' };
  }
  return undefined;
}

export function toXsStartReport(
  value: ProtocolXsStartReport,
  catalogSourceIds: ReadonlySet<string>,
  log: (message: string) => void = (message) => console.warn(message),
): XsStartReport | undefined {
  if (value.contractMajor !== xsStartReportMajor) {
    if (!unknownMajorLogged) {
      unknownMajorLogged = true;
      log(
        `XS start check report contract ${value.contractMajor}.${value.contractMinor} is not supported; it is not shown`,
      );
    }
    return undefined;
  }
  const status = statusOf(value.status);
  if (!status) return undefined;
  const limits = xsStartReportLimits;
  const place = (sourceId: string, range: SourceRange | undefined) =>
    toPlace(sourceId, range, catalogSourceIds);
  const cut = <T>(items: readonly T[], limit: number): { kept: T[]; extra: number } => ({
    kept: items.slice(0, limit),
    extra: Math.max(0, items.length - limit),
  });
  const sourceIds = value.sourceIds
    .filter((sourceId) => catalogSourceIds.has(sourceId))
    .slice(0, limits.sourceIds);
  const unanswerable = cut(value.unanswerableCalls, limits.unanswerableCalls);
  const findings = cut(value.findings, limits.findings);
  const chat = cut(value.chatLines, limits.chatLines);
  const changes = cut(value.changes, limits.changes);
  const recorded = cut(value.recordedCalls, limits.recordedCalls);
  const topics = [
    ...new Set(
      value.unconfirmedTopics
        .map(topicOf)
        .filter((topic): topic is XsUnconfirmedTopic => topic !== null),
    ),
  ];
  return {
    contractMinor: value.contractMinor,
    status,
    sourceIds,
    mainRan: value.mainRan,
    rulesRun: value.rulesRun,
    steps: safeNumber(value.steps),
    stepLimit: safeNumber(value.stepLimit),
    unanswerableCalls: unanswerable.kept.map((call) => boundedText(call, limits.valueText)),
    omittedUnanswerableCalls: value.omittedUnanswerableCalls + unanswerable.extra,
    unconfirmedTopics: topics,
    findings: findings.kept.map((finding): XsStartFinding => ({
      code: boundedText(finding.code, 16),
      severity: severityOf(finding.severity),
      message: boundedText(finding.message, 600),
      arguments: Object.fromEntries(
        finding.arguments
          .slice(0, limits.findingArguments)
          .filter((argument) => /^[a-z][A-Za-z0-9]{0,31}$/u.test(argument.name))
          .map((argument) => [argument.name, boundedText(argument.value, limits.valueText)]),
      ),
      place: place(finding.sourceId, finding.range),
    })),
    omittedFindings: value.omittedFindings + findings.extra,
    chatLines: chat.kept.map((line) => ({
      text: boundedText(line.text, limits.chatText),
      call: boundedText(line.call, limits.valueText),
      place: place(line.sourceId, line.range),
    })),
    omittedChatLines: value.omittedChatLines + chat.extra,
    changes: changes.kept.map((change): XsStartChange => ({
      player: Math.min(change.player, 16),
      kind: changeKindOf(change.kind),
      targetId: change.targetId,
      targetConstant: boundedText(change.targetConstant, limits.valueText),
      operation: operationOf(change.operation),
      amount: Number.isFinite(change.amount) ? change.amount : 0,
      count: change.count,
      position:
        change.position && Number.isFinite(change.position.x) && Number.isFinite(change.position.y)
          ? { x: change.position.x, y: change.position.y }
          : null,
      text: boundedText(change.text, limits.valueText),
      valueId: change.valueId,
      calls: change.calls,
      call: boundedText(change.call, limits.valueText),
      place: place(change.sourceId, change.range),
    })),
    omittedChanges: value.omittedChanges + changes.extra,
    recordedCalls: recorded.kept.map((call) => ({
      text: recordedCallText(call.name, call.arguments, call.result),
      place: place(call.sourceId, call.range),
    })),
    omittedRecordedCalls: value.omittedRecordedCalls + recorded.extra,
    stop:
      status === 'stopped' && value.stop
        ? {
            code: boundedText(value.stop.code, 16),
            place: place(value.stop.sourceId, value.stop.range),
            function: boundedText(value.stop.function, limits.valueText),
            inRule: value.stop.inRule,
            call: boundedText(value.stop.call, limits.valueText),
            reason: value.stop.code === 'XS5010' ? reasonOf(value.stop.reason) : null,
          }
        : null,
    compileErrors: value.compileErrors
      .filter((entry) => catalogSourceIds.has(entry.sourceId))
      .slice(0, limits.compileErrors)
      .map((entry) => ({ sourceId: entry.sourceId, errors: entry.errors })),
    randomDraws: value.randomDraws,
  };
}

function statusOf(status: ProtocolStatus): XsStartStatus | null {
  switch (status) {
    case ProtocolStatus.COMPLETED:
      return 'completed';
    case ProtocolStatus.STOPPED:
      return 'stopped';
    case ProtocolStatus.SKIPPED_COMPILE_ERRORS:
      return 'skipped-compile-errors';
    case ProtocolStatus.SKIPPED_NO_CONSTANTS:
      return 'skipped-no-constants';
    default:
      return null;
  }
}

function topicOf(topic: ProtocolTopic): XsUnconfirmedTopic | null {
  switch (topic) {
    case ProtocolTopic.INTEGER_ARITHMETIC:
      return 'integer-arithmetic';
    case ProtocolTopic.MIXED_NUMBERS:
      return 'mixed-numbers';
    case ProtocolTopic.NUMBER_TEXT:
      return 'number-text';
    case ProtocolTopic.TEXT_FUNCTIONS:
      return 'text-functions';
    case ProtocolTopic.ARRAY_DEFAULTS:
      return 'array-defaults';
    case ProtocolTopic.RULE_ORDER:
      return 'rule-order';
    case ProtocolTopic.GOTO:
      return 'goto';
    case ProtocolTopic.START_DEFAULTS:
      return 'start-defaults';
    default:
      return null;
  }
}

function reasonOf(reason: ProtocolReason): XsUnansweredReason {
  switch (reason) {
    case ProtocolReason.LOBBY_SETTING:
      return 'lobby-setting';
    case ProtocolReason.OBJECT_DATA:
      return 'object-data';
    case ProtocolReason.TECHNOLOGY_DATA:
      return 'technology-data';
    case ProtocolReason.TEXT_TABLE:
      return 'text-table';
    case ProtocolReason.GAME_RUNTIME:
      return 'game-runtime';
    case ProtocolReason.NOT_IN_MAP_SCRIPTS:
      return 'not-in-map-scripts';
    default:
      return 'unknown-call';
  }
}

function changeKindOf(kind: ProtocolChangeKind): XsStartChangeKind {
  switch (kind) {
    case ProtocolChangeKind.RESOURCE:
      return 'resource';
    case ProtocolChangeKind.TECHNOLOGY:
      return 'technology';
    case ProtocolChangeKind.DIPLOMACY:
      return 'diplomacy';
    case ProtocolChangeKind.PLAYER_NAME:
      return 'player-name';
    case ProtocolChangeKind.CIVILIZATION_NAME:
      return 'civilization-name';
    case ProtocolChangeKind.PLAYER_COLOR:
      return 'player-color';
    case ProtocolChangeKind.COLOR_MOOD:
      return 'color-mood';
    case ProtocolChangeKind.UNITS_CREATED:
      return 'units-created';
    case ProtocolChangeKind.UNITS_REMOVED:
      return 'units-removed';
    case ProtocolChangeKind.UNITS_MOVED:
      return 'units-moved';
    case ProtocolChangeKind.UNITS_OWNER_CHANGED:
      return 'units-owner-changed';
    case ProtocolChangeKind.UNIT_VALUES:
      return 'unit-values';
    case ProtocolChangeKind.UNIT_TEXT:
      return 'unit-text';
    case ProtocolChangeKind.OBJECT_DATA:
      return 'object-data';
    case ProtocolChangeKind.TECHNOLOGY_DATA:
      return 'technology-data';
    default:
      return 'other';
  }
}

function operationOf(operation: ProtocolOperation): XsStartOperation {
  switch (operation) {
    case ProtocolOperation.SET:
      return 'set';
    case ProtocolOperation.ADD:
      return 'add';
    case ProtocolOperation.MULTIPLY:
      return 'multiply';
    default:
      return 'other';
  }
}

function severityOf(severity: DiagnosticSeverity): XsStartFinding['severity'] {
  if (severity === DiagnosticSeverity.ERROR) return 'error';
  if (severity === DiagnosticSeverity.WARNING) return 'warning';
  return 'info';
}

function toPlace(
  sourceId: string,
  range: SourceRange | undefined,
  catalogSourceIds: ReadonlySet<string>,
): XsStartPlace | null {
  if (!sourceId || !catalogSourceIds.has(sourceId)) return null;
  const line = Math.max(1, range?.start?.line ?? 1);
  const column = Math.max(1, range?.start?.utf16Column ?? 1);
  const endLine = Math.max(line, range?.end?.line ?? line);
  const endColumn = Math.max(endLine === line ? column : 1, range?.end?.utf16Column ?? column);
  return { sourceId, line, column, endLine, endColumn };
}

function safeNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

export function boundedText(text: string, bytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= bytes) return text;
  let kept = '';
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > bytes) break;
    kept += character;
    used += size;
  }
  return kept;
}

function floatText(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const short = Number(Math.fround(value).toPrecision(7));
  const text = String(short);
  return /[.e]/u.test(text) ? text : `${text}.0`;
}

function valueText(value: XsValue | undefined): string {
  const kind = value?.kind;
  switch (kind?.case) {
    case 'intValue':
      return String(kind.value);
    case 'floatValue':
      return floatText(kind.value);
    case 'boolValue':
      return kind.value ? 'true' : 'false';
    case 'stringValue':
      return JSON.stringify(boundedText(kind.value, xsStartReportLimits.valueText));
    case 'vectorValue':
      return `vector(${floatText(kind.value.x)}, ${floatText(kind.value.y)}, ${floatText(kind.value.z)})`;
    default:
      return '?';
  }
}

function recordedCallText(
  name: string,
  argumentsList: readonly XsValue[],
  result: XsValue | undefined,
): string {
  const text = `${boundedText(name, xsStartReportLimits.valueText)}(${argumentsList
    .slice(0, 32)
    .map(valueText)
    .join(', ')})${result ? ` = ${valueText(result)}` : ''}`;
  return boundedText(text, 1_024);
}
