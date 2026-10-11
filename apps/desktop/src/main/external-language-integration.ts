import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import type { MenuItemConstructorOptions } from 'electron';
import type { OutputMessage } from '../shared/output-message';
import type { ExternalLanguage } from './external-language-compatibility';
import {
  externalServerCandidates,
  nodeDetectionEnvironment,
  type ExternalDetectionEnvironment,
  type ExternalServerCandidate,
} from './external-language-detection';
import { ExternalLanguageServers } from './external-language-servers';
import {
  externalLanguageMenu,
  ExternalLanguageSettingsStore,
  type ExternalLanguageSettings,
} from './external-language-settings';
import { decodeSourceBytes } from './source-codec';

export const maximumExternalDiskTextBytes = 16 * 1024 * 1024;

export interface ExternalLanguageIntegrationOptions {
  userDataPath: string;
  workspaceRoot: () => string | null;
  overrides: Partial<Record<ExternalLanguage, string>>;
  underTestHarness: boolean;
  clientVersion: string;
  publishOutput(message: OutputMessage): void;
  publishDiagnostics(params: unknown): void;
  onAvailabilityChanged(): void;
}

export function createExternalLanguageServers(
  options: ExternalLanguageIntegrationOptions,
): ExternalLanguageServers {
  const store = new ExternalLanguageSettingsStore(options.userDataPath);
  return new ExternalLanguageServers({
    settings: store,
    detect: (language) =>
      detectExternalServers(
        language,
        nodeDetectionEnvironment(
          [options.workspaceRoot()].filter((root): root is string => !!root),
          options.overrides,
        ),
        options.underTestHarness,
      ),
    publishOutput: options.publishOutput,
    publishDiagnostics: options.publishDiagnostics,
    onAvailabilityChanged: options.onAvailabilityChanged,
    fileExists: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    readDiskText,
    clientVersion: options.clientVersion,
  });
}

export async function detectExternalServers(
  language: ExternalLanguage,
  environment: ExternalDetectionEnvironment,
  underTestHarness: boolean,
): Promise<ExternalServerCandidate[]> {
  const candidates = await externalServerCandidates(language, environment);
  return underTestHarness
    ? candidates.filter((candidate) => candidate.origin === 'override')
    : candidates;
}

export function readDiskText(path: string): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const size = fstatSync(descriptor).size;
    if (size > maximumExternalDiskTextBytes) return null;
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(descriptor, bytes, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return decodeSourceBytes(bytes.subarray(0, offset)).content;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function externalLanguageMenuItems(
  servers: Pick<ExternalLanguageServers, 'availableServers' | 'setUse' | 'setFillGaps'> & {
    menuSettings(): ExternalLanguageSettings;
  },
  actions: {
    blocked: () => boolean;
    refresh: () => void;
    onError: (error: unknown) => void;
  },
): MenuItemConstructorOptions[] {
  const menu = externalLanguageMenu(servers.availableServers(), servers.menuSettings());
  if (!menu) return [];
  return [
    {
      id: 'view.external-language-servers',
      label: menu.label,
      submenu: menu.entries.map((entry): MenuItemConstructorOptions => {
        if (entry.kind === 'separator') return { type: 'separator' };
        if (entry.kind === 'heading') {
          return {
            id: `view.external-language.${entry.language}`,
            label: entry.label,
            enabled: false,
          };
        }
        return {
          id: `view.external-language.${entry.language}.${entry.kind}`,
          label: entry.label,
          type: 'checkbox',
          checked: entry.checked,
          enabled: entry.enabled,
          click: () => {
            if (actions.blocked()) {
              actions.refresh();
              return;
            }
            const change =
              entry.kind === 'use'
                ? servers.setUse(entry.language, !entry.checked)
                : servers.setFillGaps(entry.language, !entry.checked);
            void change.catch(actions.onError);
          },
        };
      }),
    },
  ];
}
