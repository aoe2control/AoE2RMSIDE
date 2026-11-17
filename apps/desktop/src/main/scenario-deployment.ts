import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopError } from '../shared/desktop-error';
import { scenarioNameProblem } from '../shared/scenario-deployment';

export const scenarioFolderParts = ['resources', '_common', 'scenario'] as const;
export const scenarioExtension = '.aoe2scenario';

export function scenarioFileName(name: string): string {
  const problem = scenarioNameProblem(name);
  if (problem) throw new Error(`the scenario name is not usable (${problem})`);
  return `${name}${scenarioExtension}`;
}

export function scenarioFolder(profileRoot: string): string {
  return join(profileRoot, ...scenarioFolderParts);
}

function samePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isInside(child: string, root: string): boolean {
  const path = relative(root, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export async function inspectScenarioFolder(
  profileRoot: string,
): Promise<{ root: string; path: string; missing: string[] }> {
  const unsafe = () =>
    new DesktopError('deploy.unsafe-target', "the profile's scenario folder is not a plain folder");
  const root = await realpath(profileRoot);
  if (!(await lstat(root)).isDirectory()) throw unsafe();
  let current = root;
  for (const [index, part] of scenarioFolderParts.entries()) {
    const next = join(current, part);
    const metadata = await lstat(next).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (metadata === null) {
      return {
        root,
        path: join(next, ...scenarioFolderParts.slice(index + 1)),
        missing: scenarioFolderParts.slice(index),
      };
    }
    if (metadata.isSymbolicLink()) {
      throw new DesktopError(
        'deploy.redirected',
        "the profile's scenario folder is a link to another place",
      );
    }
    if (!metadata.isDirectory()) throw unsafe();
    const canonical = await realpath(next);
    if (!samePath(canonical, next) || !isInside(canonical, root)) throw unsafe();
    current = canonical;
  }
  return { root, path: current, missing: [] };
}

export async function scenarioFolderToOpen(profileRoot: string): Promise<string> {
  const folder = await inspectScenarioFolder(profileRoot);
  return folder.missing.length === 0
    ? folder.path
    : join(
        folder.root,
        ...scenarioFolderParts.slice(0, scenarioFolderParts.length - folder.missing.length),
      );
}

export type ScenarioWriteOutcome =
  { status: 'exists'; path: string } | { status: 'written'; path: string; replaced: boolean };

export async function writeScenarioFile(
  profileRoot: string,
  name: string,
  bytes: Uint8Array,
  replaceExisting: boolean,
): Promise<ScenarioWriteOutcome> {
  const fileName = scenarioFileName(name);
  const folder = await inspectScenarioFolder(profileRoot);
  const path = join(folder.path, fileName);
  let replaced = false;
  if (folder.missing.length === 0) {
    const existing = await lstat(path).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new DesktopError(
          'deploy.unsafe-target',
          'a scenario of that name is not a plain file',
        );
      }
      if (!replaceExisting) return { status: 'exists', path };
      replaced = true;
    }
  }
  let parent = join(
    folder.root,
    ...scenarioFolderParts.slice(0, scenarioFolderParts.length - folder.missing.length),
  );
  for (const part of folder.missing) {
    parent = join(parent, part);
    await mkdir(parent);
  }
  const temporary = join(folder.path, `.${randomUUID()}.rmside-tmp`);
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { status: 'written', path, replaced };
}
