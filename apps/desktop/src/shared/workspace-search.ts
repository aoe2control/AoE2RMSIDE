export interface WorkspaceSearchNameRange {
  start: number;
  end: number;
}

export function normalizeWorkspaceSearchQuery(query: string): string {
  return query.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

export function isWorkspacePathQuery(query: string): boolean {
  return /[\\/]/u.test(query);
}

export function workspaceSearchMatch(
  query: string,
  relativePath: string,
): WorkspaceSearchNameRange | null {
  const needle = normalizeWorkspaceSearchQuery(query);
  if (needle.length === 0) return null;
  const path = relativePath.replaceAll('\\', '/');
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!needle.includes('/')) {
    const index = name.toLocaleLowerCase('en-US').indexOf(needle);
    return index < 0 ? null : clampRange(index, index + needle.length, name.length);
  }
  const haystack = `/${path}`.toLocaleLowerCase('en-US');
  const index = haystack.indexOf(needle);
  if (index < 0) return null;
  const nameStart = haystack.length - name.length;
  return clampRange(index - nameStart, index + needle.length - nameStart, name.length);
}

function clampRange(start: number, end: number, length: number): WorkspaceSearchNameRange {
  const clampedStart = Math.min(Math.max(start, 0), length);
  return { start: clampedStart, end: Math.min(Math.max(end, clampedStart), length) };
}
