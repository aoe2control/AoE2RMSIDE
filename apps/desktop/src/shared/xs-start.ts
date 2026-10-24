export const xsStartReportMajor = 1;

export const xsStartReportLimits = {
  sourceIds: 64,
  unanswerableCalls: 64,
  findings: 200,
  chatLines: 1_000,
  changes: 1_000,
  recordedCalls: 5_000,
  compileErrors: 64,
  chatText: 2_048,
  valueText: 256,
  findingArguments: 8,
} as const;

export type XsStartStatus =
  'completed' | 'stopped' | 'skipped-compile-errors' | 'skipped-no-constants';

export const xsUnconfirmedTopics = [
  'integer-arithmetic',
  'mixed-numbers',
  'number-text',
  'text-functions',
  'array-defaults',
  'rule-order',
  'goto',
  'start-defaults',
] as const;
export type XsUnconfirmedTopic = (typeof xsUnconfirmedTopics)[number];

export const xsUnansweredReasons = [
  'lobby-setting',
  'object-data',
  'technology-data',
  'text-table',
  'game-runtime',
  'not-in-map-scripts',
  'unknown-call',
] as const;
export type XsUnansweredReason = (typeof xsUnansweredReasons)[number];

export const xsStartChangeKinds = [
  'resource',
  'technology',
  'diplomacy',
  'player-name',
  'civilization-name',
  'player-color',
  'color-mood',
  'units-created',
  'units-removed',
  'units-moved',
  'units-owner-changed',
  'unit-values',
  'unit-text',
  'object-data',
  'technology-data',
  'other',
] as const;
export type XsStartChangeKind = (typeof xsStartChangeKinds)[number];

export type XsStartOperation = 'set' | 'add' | 'multiply' | 'other';

export interface XsStartPlace {
  sourceId: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface XsStartFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  arguments: Readonly<Record<string, string>>;
  place: XsStartPlace | null;
}

export interface XsStartChatLine {
  text: string;
  call: string;
  place: XsStartPlace | null;
}

export interface XsStartChange {
  player: number;
  kind: XsStartChangeKind;
  targetId: number;
  targetConstant: string;
  operation: XsStartOperation;
  amount: number;
  count: number;
  position: { x: number; y: number } | null;
  text: string;
  valueId: number;
  calls: number;
  call: string;
  place: XsStartPlace | null;
}

export interface XsStartRecordedCall {
  text: string;
  place: XsStartPlace | null;
}

export interface XsStartStop {
  code: string;
  place: XsStartPlace | null;
  function: string;
  inRule: boolean;
  call: string;
  reason: XsUnansweredReason | null;
}

export interface XsStartReport {
  contractMinor: number;
  status: XsStartStatus;
  sourceIds: string[];
  mainRan: boolean;
  rulesRun: number;
  steps: number;
  stepLimit: number;
  unanswerableCalls: string[];
  omittedUnanswerableCalls: number;
  unconfirmedTopics: XsUnconfirmedTopic[];
  findings: XsStartFinding[];
  omittedFindings: number;
  chatLines: XsStartChatLine[];
  omittedChatLines: number;
  changes: XsStartChange[];
  omittedChanges: number;
  recordedCalls: XsStartRecordedCall[];
  omittedRecordedCalls: number;
  stop: XsStartStop | null;
  compileErrors: { sourceId: string; errors: number }[];
  randomDraws: number;
}

export type XsStartOutcome =
  { kind: 'report'; report: XsStartReport } | { kind: 'needs-game-folder' };
