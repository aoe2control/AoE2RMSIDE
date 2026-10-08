export type RunMark =
  | 'schedule'
  | 'execute'
  | 'analysis-start'
  | 'analysis-synced'
  | 'analysis-end'
  | 'settle-wait'
  | 'generation-start'
  | 'invoke-start'
  | 'invoke-end'
  | 'analysis-joined'
  | 'stream-verified'
  | 'generation-end'
  | 'reuse'
  | 'rejected';

export type RendererStartupMark = 'script' | 'first-render';

export function runScheduled(_job: object): void {}

export function runMark(_job: object, _mark: RunMark): void {}

export function runRequest(_job: object, _clientRequestId: string): void {}

export function runCommitted(_job: object): void {}

export function sceneBuild(
  _phase: 'start' | 'end',
  _ticker?: { addOnce(listener: () => void, context?: unknown, priority?: number): unknown },
): void {}

export function candidateDrawn(_requestId: string, _drawMilliseconds: number): void {}

export function startupMark(_mark: RendererStartupMark): void {}
