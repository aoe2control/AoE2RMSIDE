import type { OutputSeverity } from '../shared/output-message';

export interface SeverityFilter {
  error: boolean;
  warning: boolean;
  info: boolean;
}

export const outputSeverityFilterDefault: SeverityFilter = Object.freeze({
  error: true,
  warning: true,
  info: true,
});

export const problemsSeverityFilterDefault: SeverityFilter = Object.freeze({
  error: true,
  warning: true,
  info: false,
});

export const severities: readonly OutputSeverity[] = ['error', 'warning', 'info'];

export function severityShown(filter: SeverityFilter, severity: OutputSeverity): boolean {
  return filter[severity];
}

export function severityFilterShowsAll(filter: SeverityFilter): boolean {
  return filter.error && filter.warning && filter.info;
}

export function toggleSeverity(filter: SeverityFilter, severity: OutputSeverity): SeverityFilter {
  return { ...filter, [severity]: !filter[severity] };
}

export type SeverityCounts = Record<OutputSeverity, number>;

export function emptySeverityCounts(): SeverityCounts {
  return { error: 0, warning: 0, info: 0 };
}

export function validSeverityFilter(value: unknown, fallback: SeverityFilter): SeverityFilter {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Partial<Record<OutputSeverity, unknown>>;
  if (
    typeof candidate.error !== 'boolean' ||
    typeof candidate.warning !== 'boolean' ||
    typeof candidate.info !== 'boolean'
  ) {
    return fallback;
  }
  return { error: candidate.error, warning: candidate.warning, info: candidate.info };
}
