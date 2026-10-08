import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export const gameExecutableNames = ['AoE2DE_s.exe', 'AoE2DE.exe'] as const;
export type GameExecutableName = (typeof gameExecutableNames)[number];

export function isGameExecutableName(value: unknown): value is GameExecutableName {
  return gameExecutableNames.some((name) => name === value);
}

export type LinkedGameProcessState = 'running' | 'not-running' | 'unknown';

const maximumCandidates = 32;

export interface ProcessQuery {
  processList(): Promise<string>;
  executablePaths(processIds: readonly number[]): Promise<string>;
}

export async function linkedGameProcessState(
  installationRoot: string,
  query: ProcessQuery = windowsProcessQuery,
  executableNames: readonly GameExecutableName[] = gameExecutableNames,
): Promise<LinkedGameProcessState> {
  const roots = new Set([resolve(installationRoot)]);
  try {
    roots.add(await realpath(installationRoot));
  } catch {}
  const expected = new Set(
    [...roots].flatMap((root) => executableNames.map((name) => pathKey(join(root, name)))),
  );
  let list: string;
  try {
    list = await query.processList();
  } catch {
    return 'unknown';
  }
  const ids = gameProcessIds(list, executableNames);
  if (ids.length === 0) return 'not-running';
  let output: string;
  try {
    output = await query.executablePaths(ids);
  } catch {
    return 'unknown';
  }
  const paths = parseExecutablePaths(output, ids);
  let unreadable = false;
  for (const id of ids) {
    const path = paths.get(id);
    if (path === undefined) continue;
    if (path === null) {
      unreadable = true;
      continue;
    }
    if (expected.has(pathKey(path))) return 'running';
  }
  return unreadable ? 'unknown' : 'not-running';
}

export function gameProcessIds(
  processList: string,
  executableNames: readonly GameExecutableName[] = gameExecutableNames,
): number[] {
  const names = new Set(executableNames.map((name) => name.toLocaleLowerCase('en-US')));
  const ids = new Set<number>();
  for (const line of processList.split(/\r?\n/u)) {
    const match = /^"([^"]*)","(\d{1,10})"/u.exec(line.trim());
    if (!match || !names.has(match[1]!.toLocaleLowerCase('en-US'))) continue;
    const id = Number(match[2]);
    if (id >= 1 && id <= 0xffff_ffff) ids.add(id);
    if (ids.size >= maximumCandidates) break;
  }
  return [...ids].sort((left, right) => left - right);
}

export function parseExecutablePaths(
  output: string,
  ids: readonly number[],
): Map<number, string | null> {
  const asked = new Set(ids);
  const paths = new Map<number, string | null>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\d{1,10})\t([A-Za-z0-9+/]*={0,2})$/u.exec(line.replace(/\r$/u, ''));
    if (!match) continue;
    const id = Number(match[1]);
    if (!asked.has(id)) continue;
    const path = match[2] ? Buffer.from(match[2], 'base64').toString('utf8') : '';
    paths.set(id, path.length > 0 && path.length <= 32_768 ? path : null);
  }
  return paths;
}

function pathKey(path: string): string {
  return resolve(path).replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

function systemFolder(): string {
  return join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32');
}

export const windowsProcessQuery: ProcessQuery = {
  async processList() {
    const { stdout } = await executeFile(
      join(systemFolder(), 'tasklist.exe'),
      ['/FO', 'CSV', '/NH'],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return stdout;
  },
  async executablePaths(processIds) {
    if (processIds.length === 0) return '';
    if (processIds.some((id) => !Number.isSafeInteger(id) || id < 1 || id > 0xffff_ffff)) {
      throw new Error('process id is invalid');
    }
    const filter = processIds.map((id) => `ProcessId=${id}`).join(' OR ');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Get-CimInstance -ClassName Win32_Process -Filter '${filter}' | ForEach-Object {`,
      '  $path = [string]$_.ExecutablePath',
      "  $encoded = if ($path) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path)) } else { '' }",
      '  [Console]::Out.WriteLine(([string]$_.ProcessId) + "`t" + $encoded)',
      '}',
    ].join('\n');
    const { stdout } = await executeFile(
      join(systemFolder(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    return stdout;
  },
};
