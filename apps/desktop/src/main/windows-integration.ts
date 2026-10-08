import { dirname, isAbsolute, join, resolve } from 'node:path';
import { t } from '../shared/i18n/translator';

export const registeredApplicationName = 'AoE2RMSIDE';

export const installationMarker = Object.freeze({
  fileName: 'rmside-installation.ini',
  section: 'Installation',
  schemaVersion: 1,
  kind: 'per-user',
  maximumBytes: 4096,
});

export type InstallationKind = 'development' | 'portable' | 'installed';

export interface InstallationMarker {
  schemaVersion: number;
  kind: string;
  directory: string;
}

export function parseInstallationMarker(text: string): InstallationMarker | null {
  if (typeof text !== 'string' || text.length > installationMarker.maximumBytes) return null;
  const lines = text.replace(/^﻿/u, '').split(/\r?\n/u);
  let section: string | null = null;
  const values = new Map<string, string>();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header) {
      if (section !== null) return null;
      section = header[1]!;
      continue;
    }
    if (section !== installationMarker.section) return null;
    const separator = line.indexOf('=');
    if (separator < 1) return null;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!['SchemaVersion', 'Kind', 'Directory'].includes(key) || values.has(key)) return null;
    values.set(key, value);
  }
  const schemaVersion = values.get('SchemaVersion');
  const kind = values.get('Kind');
  const directory = values.get('Directory');
  if (
    section !== installationMarker.section ||
    schemaVersion !== String(installationMarker.schemaVersion) ||
    kind !== installationMarker.kind ||
    !directory ||
    directory.length > 32_768 ||
    !isAbsolute(directory) ||
    /^[\\/](?![\\/])/u.test(directory)
  ) {
    return null;
  }
  return { schemaVersion: installationMarker.schemaVersion, kind, directory };
}

export interface InstallationProbe {
  isPackaged: boolean;
  executablePath: string;
  resourcesPath: string;
  readText(path: string, maximumBytes: number): Promise<string | null>;
  realpath(path: string): Promise<string>;
}

export async function detectInstallationKind(probe: InstallationProbe): Promise<InstallationKind> {
  if (!probe.isPackaged) return 'development';
  try {
    const text = await probe.readText(
      join(probe.resourcesPath, installationMarker.fileName),
      installationMarker.maximumBytes,
    );
    if (text === null) return 'portable';
    const marker = parseInstallationMarker(text);
    if (!marker) return 'portable';
    const [installed, running] = await Promise.all([
      probe.realpath(marker.directory),
      probe.realpath(dirname(probe.executablePath)),
    ]);
    return pathKey(installed) === pathKey(running) ? 'installed' : 'portable';
  } catch {
    return 'portable';
  }
}

function pathKey(path: string): string {
  return resolve(path)
    .replace(/[\\/]+$/u, '')
    .toLocaleLowerCase('en-US');
}

export const sessionEndQuitDelayMs = 300;

export function windowsBuildNumber(release: string): number | null {
  const match = /^\d+\.\d+\.(\d+)/u.exec(release);
  if (!match) return null;
  const build = Number(match[1]);
  return Number.isSafeInteger(build) ? build : null;
}

const firstWindows11Build = 22_000;

export function defaultAppsSettingsUri(build: number | null): string {
  return build !== null && build >= firstWindows11Build
    ? `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(registeredApplicationName)}`
    : 'ms-settings:defaultapps';
}

export const defaultAppsNotice = Object.freeze({
  code: 'files.default-apps-opened',
  get headline() {
    return t('app-menu.file.choose-default-app.notice.headline');
  },
  get cause() {
    return t('app-menu.file.choose-default-app.notice.cause');
  },
});
