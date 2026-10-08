import type { PreviewTraceLevel } from '../shared/api';

export const fullTraceUnavailableMessage =
  'full trace collection is unavailable to preview requests; use the backend CLI';

export function admitPreviewTraceLevel(
  level: unknown,
  fullTraceAllowed: boolean,
): PreviewTraceLevel {
  if (level === 'off' || level === 'summary') return level;
  if (level === 'full') {
    if (fullTraceAllowed) return level;
    throw new Error(fullTraceUnavailableMessage);
  }
  throw new Error('generation input is invalid or exceeds its bounds');
}
