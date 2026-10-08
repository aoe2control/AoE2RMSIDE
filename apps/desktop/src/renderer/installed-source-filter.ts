import type { InstalledSourceOriginFilter, InstalledSourceOwnership } from '../shared/api';

export const installedSourceOrigins: readonly InstalledSourceOwnership[] = Object.freeze([
  'built-in',
  'local',
  'subscribed',
]);

export const installedSourceOriginFilterDefault: Readonly<InstalledSourceOriginFilter> =
  Object.freeze({ 'built-in': true, local: true, subscribed: true });

export type InstalledSourceOriginCounts = Readonly<Record<InstalledSourceOwnership, number>>;

export type InstalledSourceEmptyState =
  'none-installed' | 'no-origin' | 'no-search-match' | 'no-filter-match';

interface FilterableSource {
  relativePath: string;
  ownership: InstalledSourceOwnership;
}

export function toggleInstalledSourceOrigin(
  filter: Readonly<InstalledSourceOriginFilter>,
  origin: InstalledSourceOwnership,
): InstalledSourceOriginFilter {
  return { ...filter, [origin]: !filter[origin] };
}

export function noInstalledSourceOrigin(filter: Readonly<InstalledSourceOriginFilter>): boolean {
  return installedSourceOrigins.every((origin) => !filter[origin]);
}

export function installedSourceMatchesSearch(source: FilterableSource, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase('en-US');
  return (
    normalized.length === 0 || source.relativePath.toLocaleLowerCase('en-US').includes(normalized)
  );
}

export function filterInstalledSources<Source extends FilterableSource>(
  entries: readonly Source[],
  query: string,
  filter: Readonly<InstalledSourceOriginFilter>,
): Source[] {
  return entries.filter(
    (source) => filter[source.ownership] && installedSourceMatchesSearch(source, query),
  );
}

export function installedSourceOriginCounts(
  entries: readonly FilterableSource[],
  query: string,
): InstalledSourceOriginCounts {
  const counts: Record<InstalledSourceOwnership, number> = {
    'built-in': 0,
    local: 0,
    subscribed: 0,
  };
  for (const source of entries) {
    if (installedSourceMatchesSearch(source, query)) counts[source.ownership] += 1;
  }
  return counts;
}

export function installedSourceEmptyState(
  entries: readonly FilterableSource[],
  query: string,
  filter: Readonly<InstalledSourceOriginFilter>,
): InstalledSourceEmptyState | null {
  if (entries.length === 0) return 'none-installed';
  if (noInstalledSourceOrigin(filter)) return 'no-origin';
  if (filterInstalledSources(entries, query, filter).length > 0) return null;
  const counts = installedSourceOriginCounts(entries, query);
  return installedSourceOrigins.some((origin) => counts[origin] > 0)
    ? 'no-filter-match'
    : 'no-search-match';
}
