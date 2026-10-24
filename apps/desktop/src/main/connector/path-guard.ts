import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readFileBounded, FileTooLargeError } from '../bounded-file';
import { isReservedWindowsDeviceName } from '../windows-names';
import { ConnectorToolError } from './dispatcher';

export const connectorPathMaximumLength = 260;
export const connectorReadMaximumBytes = 1024 * 1024;

const readableExtensions = new Set([
  '.rms',
  '.rms2',
  '.inc',
  '.def',
  '.xs',
  '.rmstest',
  '.txt',
  '.md',
]);
const editableExtensions = new Set(['.rms', '.rms2', '.inc', '.def', '.xs', '.rmstest']);

export interface PathGuardWorkspace {
  root(): string | null;
  isProtected(path: string): boolean;
}

export interface GuardedPath {
  absolute: string;
  relative: string;
  root: string;
  stats: Stats | null;
  existingSegments: number;
  segments: readonly string[];
}

export type GuardTarget = 'file' | 'folder' | 'new-file';

function outside(message: string): ConnectorToolError {
  return new ConnectorToolError('outside_workspace', message, {
    hint: 'Use a path relative to the open folder, such as maps/oasis.rms, as list_files shows it.',
  });
}

export function connectorExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLocaleLowerCase('en-US');
}

export function isConnectorReadableName(name: string): boolean {
  return readableExtensions.has(connectorExtension(name));
}

export function isConnectorEditableName(name: string): boolean {
  return editableExtensions.has(connectorExtension(name));
}

export function workspacePathSegments(value: string, allowEmpty = false): string[] {
  if (typeof value !== 'string') throw outside('The path is not text.');
  if (value.length === 0 && allowEmpty) return [];
  if (value.length < 1 || value.length > connectorPathMaximumLength) {
    throw outside(`The path must have 1 to ${connectorPathMaximumLength} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw outside('The path holds control characters.');
  if (/^[\\/]/u.test(value) || /^[A-Za-z]:/u.test(value)) {
    throw outside('The path must be relative to the open folder, not absolute.');
  }
  if (value.includes(':')) throw outside('The path must not hold a colon.');
  if (/[*?"<>|]/u.test(value)) throw outside('The path holds a character Windows does not allow.');
  const segments = value.split(/[\\/]/u);
  if (segments.length > 1 && segments.at(-1) === '') segments.pop();
  segments.forEach((segment, index) => {
    if (segment.length === 0) throw outside('The path has an empty part (two slashes in a row).');
    if (segment === '.' || segment === '..') {
      throw outside('The path must not use . or .. parts.');
    }
    if (/[. ]$/u.test(segment)) throw outside('A part of the path ends in a dot or a space.');
    if (isReservedWindowsDeviceName(segment)) {
      throw outside(`${segment} is a reserved Windows device name.`);
    }
    if (segment.startsWith('.') && index < segments.length - 1) {
      throw outside('Hidden folders (names starting with a dot) are not part of the workspace.');
    }
    if (segment.length > 255) throw outside('A part of the path is longer than 255 characters.');
  });
  return segments;
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function isInsideRoot(path: string, root: string): boolean {
  const result = relative(pathKey(root), pathKey(path));
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class WorkspacePathGuard {
  constructor(private readonly workspace: PathGuardWorkspace) {}

  async root(): Promise<string> {
    const root = this.workspace.root();
    if (!root) {
      throw new ConnectorToolError('no_folder_open', 'No folder is open in AoE2RMSIDE.', {
        hint: 'Ask the user to open their scripts folder in AoE2RMSIDE (File > Open Folder).',
      });
    }
    let canonical: string;
    try {
      canonical = resolve(await realpath(root));
    } catch {
      throw new ConnectorToolError('no_folder_open', 'The open folder is not available.', {
        hint: 'Ask the user to open their scripts folder in AoE2RMSIDE again.',
      });
    }
    if (this.workspace.isProtected(canonical)) {
      throw outside('The open folder belongs to the game or its mods, which AI apps cannot use.');
    }
    return canonical;
  }

  async resolve(
    value: string,
    target: GuardTarget,
    options: { editable?: boolean; maximumNewFolders?: number } = {},
  ): Promise<GuardedPath> {
    const segments = workspacePathSegments(value, target === 'folder');
    if (target === 'folder' && segments.at(-1)?.startsWith('.')) {
      throw outside('Hidden folders (names starting with a dot) are not part of the workspace.');
    }
    if (target !== 'folder') {
      const name = segments.at(-1) ?? '';
      const allowed = options.editable
        ? isConnectorEditableName(name)
        : isConnectorReadableName(name);
      if (!allowed) {
        throw new ConnectorToolError(
          'file_type_not_allowed',
          options.editable
            ? 'AI apps can edit and create only .rms, .rms2, .inc, .def, .xs and .rmstest files.'
            : 'AI apps can read only .rms, .rms2, .inc, .def, .xs, .rmstest, .txt and .md files.',
        );
      }
    }
    const root = await this.root();
    let current = root;
    let existingSegments = 0;
    let stats: Stats | null = null;
    for (const [index, segment] of segments.entries()) {
      const next = join(current, segment);
      let entry: Stats;
      try {
        entry = await lstat(next);
      } catch (error) {
        if (!isNotFound(error)) throw outside('A part of the path cannot be read.');
        current = next;
        for (const rest of segments.slice(index + 1)) current = join(current, rest);
        stats = null;
        break;
      }
      if (entry.isSymbolicLink()) {
        throw outside('The path goes through a link or junction, which AI apps cannot follow.');
      }
      let canonical: string;
      try {
        canonical = resolve(await realpath(next));
      } catch {
        throw outside('A part of the path cannot be read.');
      }
      if (pathKey(canonical) !== pathKey(next)) {
        throw outside(
          'The path goes through a link, junction or short name; use the full names as list_files shows them.',
        );
      }
      if (index < segments.length - 1 && !entry.isDirectory()) {
        throw new ConnectorToolError(
          'not_found',
          `${segments.slice(0, index + 1).join('/')} is not a folder.`,
        );
      }
      current = canonical;
      existingSegments = index + 1;
      stats = entry;
    }
    if (!isInsideRoot(current, root)) throw outside('The path leaves the open folder.');
    if (this.workspace.isProtected(current)) {
      throw outside('This path belongs to the game or its mods, which AI apps cannot use.');
    }
    const relativePath = segments.join('/');
    const shown = relativePath === '' ? '.' : relativePath;
    if (target === 'file') {
      if (!stats) {
        throw new ConnectorToolError('not_found', `${shown} does not exist.`, {
          hint: 'Call list_files to see the files in the open folder.',
        });
      }
      if (!stats.isFile()) throw new ConnectorToolError('not_found', `${shown} is not a file.`);
    } else if (target === 'folder') {
      if (!stats && segments.length > 0) {
        throw new ConnectorToolError('not_found', `${shown} does not exist.`, {
          hint: 'Call list_files to see the folders in the open folder.',
        });
      }
      if (stats && !stats.isDirectory()) {
        throw new ConnectorToolError('not_found', `${shown} is not a folder.`);
      }
    } else {
      if (stats || existingSegments === segments.length) {
        throw new ConnectorToolError('already_exists', `${shown} already exists.`, {
          hint: 'Use edit_file to change it, or choose another name.',
        });
      }
      const missingFolders = segments.length - 1 - existingSegments;
      if (missingFolders > (options.maximumNewFolders ?? 0)) {
        throw new ConnectorToolError(
          'not_found',
          `create_file makes at most ${options.maximumNewFolders ?? 0} new folders above a file.`,
        );
      }
    }
    return {
      absolute: current,
      relative: relativePath,
      root,
      stats,
      existingSegments,
      segments,
    };
  }

  async read(path: GuardedPath, maximumBytes = connectorReadMaximumBytes): Promise<Buffer> {
    const checked = path.stats;
    if (!checked) throw new ConnectorToolError('not_found', `${path.relative} does not exist.`);
    let bytes: Buffer;
    try {
      bytes = await readFileBounded(path.absolute, maximumBytes, async (opened) => {
        if (opened.dev !== checked.dev || opened.ino !== checked.ino) {
          throw new ConnectorToolError(
            'edit_conflict',
            `${path.relative} changed while it was read.`,
            {
              hint: 'Try again.',
            },
          );
        }
      });
    } catch (error) {
      if (error instanceof ConnectorToolError) throw error;
      if (error instanceof FileTooLargeError) {
        throw new ConnectorToolError(
          'too_large',
          `${path.relative} is larger than ${Math.round(maximumBytes / 1024)} KiB.`,
        );
      }
      if (isNotFound(error)) {
        throw new ConnectorToolError('not_found', `${path.relative} does not exist.`);
      }
      throw new ConnectorToolError('internal', `${path.relative} could not be read.`);
    }
    if (bytes.includes(0)) {
      throw new ConnectorToolError('binary_file', `${path.relative} holds binary data, not text.`);
    }
    return bytes;
  }
}
