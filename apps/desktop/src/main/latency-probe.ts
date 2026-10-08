import type { NativeProcessName } from '../shared/api';

export type MainStep =
  | 'validate'
  | 'lease'
  | 'source-graph'
  | 'request-build'
  | 'request-encode'
  | 'child-wait'
  | 'response-decode'
  | 'response-convert'
  | 'post-check'
  | 'settle'
  | 'sync-wait'
  | 'catalog'
  | 'language-server';

export type MainWithin = 'event-frames' | 'candidate-frames';

export type MainStartupMark = 'app-ready' | 'window-created' | 'renderer-loaded' | 'natives-ready';

export type MainRequestKind = 'generation' | 'language';

export function openRequest(_requestId: string, _kind: MainRequestKind): void {}

export function step(_requestId: string, _name: MainStep): void {}

export function stepUntil(_requestId: string, _name: MainStep, _time: number): void {}

export function within(_requestId: string, _name: MainWithin, _milliseconds: number): void {}

export function closeRequest(_requestId: string, _outcome: 'committed' | 'failed'): void {}

export function now(): number {
  return 0;
}

export function startup(_mark: MainStartupMark): void {}

export function fullTraceAllowed(): boolean {
  return false;
}

export function languageContext(_requestId: string | undefined): void {}

export function languageExchange(_id: number, _method: string, _phase: 'sent' | 'answered'): void {}

export function nativeDiagnostics(_process: NativeProcessName, chunk: string): string {
  return chunk;
}
