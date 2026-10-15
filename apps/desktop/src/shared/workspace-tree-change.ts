export type WorkspaceTreeChange =
  { kind: 'paths'; root: string; paths: string[] } | { kind: 'all'; root: string };

export const maximumWorkspaceTreeChangePaths = 512;
const maximumPathLength = 32_768;

export function validateWorkspaceTreeChange(value: unknown): WorkspaceTreeChange | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isAbsolutePath(record.root)) return null;
  if (record.kind === 'all') return { kind: 'all', root: record.root };
  if (record.kind !== 'paths' || !Array.isArray(record.paths)) return null;
  const paths: unknown[] = record.paths;
  if (paths.length < 1 || paths.length > maximumWorkspaceTreeChangePaths) return null;
  if (!paths.every(isAbsolutePath)) return null;
  return { kind: 'paths', root: record.root, paths: [...paths] };
}

function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 2 &&
    value.length <= maximumPathLength &&
    !value.includes('\0') &&
    (/^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]{2}[^\\/]/u.test(value) || value.startsWith('/'))
  );
}
