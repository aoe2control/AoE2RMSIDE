import { lstat, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopError } from '../shared/desktop-error';

export async function deploymentTargetFolderToOpen(profileRoot: string): Promise<string> {
  const root = await realpath(profileRoot);
  if (!(await stat(root)).isDirectory()) {
    throw new DesktopError('deploy.unsafe-target', 'the deployment profile is not a folder');
  }
  const mods = join(root, 'mods');
  for (const candidate of [join(mods, 'local'), mods]) {
    const metadata = await lstat(candidate).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (metadata === null) continue;
    if (metadata.isSymbolicLink()) {
      throw new DesktopError(
        'deploy.redirected',
        'the profile mods folder is a link to another place',
      );
    }
    if (!metadata.isDirectory()) {
      throw new DesktopError('deploy.unsafe-target', 'the profile mods folder is not a folder');
    }
    return candidate;
  }
  return root;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
