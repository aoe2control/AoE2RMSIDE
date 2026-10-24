import { isAbsolute, relative, sep } from 'node:path';
import { ConnectorToolError } from './dispatcher';
import { WorkspacePathGuard, type PathGuardWorkspace } from './path-guard';
import type { ResolvedScript } from './tools/run-tools';

const mapExtensions = /\.(rms|rms2)$/iu;
const mapTestExtension = /\.rmstest$/iu;

export function workspaceRelativePath(root: string | null, absolute: string): string | null {
  if (!root) return null;
  const between = relative(root, absolute);
  if (between === '' || between.startsWith('..') || isAbsolute(between)) return null;
  return between.split(sep).join('/');
}

export async function resolveRunScript(
  workspace: PathGuardWorkspace,
  path: string,
  kind: 'map' | 'map-test',
): Promise<ResolvedScript> {
  const guarded = await new WorkspacePathGuard(workspace).resolve(path, 'file');
  const pattern = kind === 'map' ? mapExtensions : mapTestExtension;
  if (!pattern.test(guarded.relative)) {
    throw new ConnectorToolError(
      'file_type_not_allowed',
      kind === 'map'
        ? 'This tool runs .rms and .rms2 maps.'
        : 'run_map_test runs .rmstest map tests.',
    );
  }
  return { absolute: guarded.absolute, relative: guarded.relative };
}
