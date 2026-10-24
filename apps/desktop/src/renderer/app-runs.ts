import { useEffect, useRef } from 'react';
import type { ConnectorErrorCode, ConnectorRendererRequest } from '../shared/connector-api';
import {
  appTeamsText,
  validateAppRunContextRequest,
  validateAppRunRequest,
  type AppRunContext,
  type AppRunReply,
  type AppRunRequest,
  type AppRunSettings,
} from '../shared/connector-run-api';
import type { MessageId } from '../shared/i18n/translator';
import { isMapTestScriptName } from '../shared/map-test-contract';
import type { OutputText } from '../shared/output-message';
import {
  civilizationIdForKey,
  civilizationName,
  type PackedCivilizationOption,
} from './packed-game-options';
import { isPreviewScriptName } from './preview-execution';
import {
  runGameModeOptions,
  runStartingAgeOptions,
  runStartingResourceOptions,
  withMapSize,
  withPlayerCount,
  withSeed,
  type RunConfiguration,
} from './run-configuration';

export class AppRunRefusal extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppRunRefusal';
  }
}

export interface AppRunDocument {
  id: string;
  uri: string;
  path: string | null;
  name: string;
  content: string;
}

export interface AppRunHost {
  run(request: AppRunRequest, document: AppRunDocument): Promise<AppRunReply>;
  context(document: AppRunDocument | null): AppRunContext;
}

export interface AppRunWorkspace {
  documents(): readonly AppRunDocument[];
  activeDocument(): AppRunDocument;
  latest(id: string): AppRunDocument | undefined;
  openInBackground(path: string): Promise<AppRunDocument | null>;
  attached(uri: string): boolean;
}

const attachWaitMilliseconds = 5_000;
const attachPollMilliseconds = 25;

function pathKey(path: string): string {
  return path.replace(/\//gu, '\\').toLowerCase();
}

function scriptKindAllows(kind: AppRunRequest['kind'], name: string): boolean {
  return kind === 'map-test' ? isMapTestScriptName(name) : isPreviewScriptName(name);
}

export async function resolveAppRunDocument(
  workspace: AppRunWorkspace,
  path: string | null,
  kind: AppRunRequest['kind'],
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<AppRunDocument> {
  let document: AppRunDocument | null | undefined;
  if (path === null) {
    document = workspace.activeDocument();
    if (!scriptKindAllows(kind, document.name)) {
      throw new AppRunRefusal(
        'file_type_not_allowed',
        kind === 'map-test'
          ? 'The active tab is not a map test; give path.'
          : 'The active tab is not a map script; give path.',
      );
    }
  } else {
    if (!scriptKindAllows(kind, path)) {
      throw new AppRunRefusal('file_type_not_allowed', 'This file cannot run this way.');
    }
    const key = pathKey(path);
    document =
      workspace
        .documents()
        .find((candidate) => candidate.path && pathKey(candidate.path) === key) ??
      (await workspace.openInBackground(path));
    if (!document) {
      throw new AppRunRefusal('not_found', 'AoE2RMSIDE could not open the file.');
    }
  }
  if (kind !== 'map-test') {
    let waited = 0;
    while (!workspace.attached(document.uri)) {
      if (waited >= attachWaitMilliseconds) {
        throw new AppRunRefusal('internal', 'The editor did not load the file in time.');
      }
      await wait(attachPollMilliseconds);
      waited += attachPollMilliseconds;
    }
  }
  return workspace.latest(document.id) ?? document;
}

export interface AppliedAppSettings {
  configuration: RunConfiguration;
  changed: string[];
  words: (string | OutputText)[];
}

function optionValue<T extends string>(
  options: readonly { value: T }[],
  value: string,
  field: string,
): T {
  const match = options.find((option) => option.value === value);
  if (!match) {
    throw new AppRunRefusal(
      'invalid_arguments',
      `settings.${field} is one of ${options.map((option) => option.value).join(', ')}.`,
    );
  }
  return match.value;
}

export function applyAppRunSettings(
  base: RunConfiguration,
  seed: number | undefined,
  settings: AppRunSettings | undefined,
  civilizations: readonly PackedCivilizationOption[],
): AppliedAppSettings {
  let configuration = base;
  const changed: string[] = [];
  const words: (string | OutputText)[] = [];
  if (seed !== undefined) {
    configuration = withSeed(configuration, seed);
    if (seed !== base.seed) {
      changed.push('seed');
      words.push({ id: 'output.run.seed', args: { seed } });
    }
  }
  if (settings?.mapSize !== undefined) {
    configuration = withMapSize(configuration, settings.mapSize);
    if (configuration.mapSize !== base.mapSize) {
      changed.push('map_size');
      words.push({ id: `game-options.map-size.${settings.mapSize}` as MessageId });
    }
  }
  if (settings?.players !== undefined) {
    configuration = withPlayerCount(configuration, settings.players);
    if (configuration.playerCount !== base.playerCount) {
      changed.push('players');
      words.push({ id: 'output.run.players', args: { count: configuration.playerCount } });
    }
  }
  if (settings?.teams !== undefined) {
    const count = configuration.playerCount;
    const teams =
      settings.teams === 'ffa'
        ? Array.from({ length: count }, () => 0)
        : settings.teams.slice(0, count);
    if (teams.length !== count) {
      throw new AppRunRefusal('invalid_arguments', 'settings.teams does not match the players.');
    }
    const teamIds = configuration.teamIds.map((team, index) =>
      index < count ? teams[index]! : team,
    );
    if (teamIds.some((team, index) => team !== base.teamIds[index])) {
      changed.push('teams');
      words.push(appTeamsText(teams));
    }
    configuration = { ...configuration, teamIds };
  }
  if (settings?.civs !== undefined) {
    const available = new Set(civilizations.map((option) => option.id));
    const ids = settings.civs.map((key) => {
      const id = civilizationIdForKey(key);
      if (id === undefined) {
        throw new AppRunRefusal(
          'invalid_arguments',
          `settings.civs has the unknown civilization ${key}; use names such as franks or random.`,
        );
      }
      if (civilizations.length > 1 && !available.has(id)) {
        throw new AppRunRefusal(
          'invalid_arguments',
          `${key} is not in the game version the Run menu uses.`,
        );
      }
      return id;
    });
    if (ids.length > configuration.playerCount) {
      throw new AppRunRefusal(
        'invalid_arguments',
        'settings.civs names more civilizations than players.',
      );
    }
    const civilizationIds = configuration.civilizationIds.map((id, index) =>
      index < ids.length ? ids[index]! : id,
    );
    if (civilizationIds.some((id, index) => id !== base.civilizationIds[index])) {
      changed.push('civs');
      words.push(...ids.map((id) => civilizationName(id)));
    }
    configuration = { ...configuration, civilizationIds };
  }
  if (settings?.gameMode !== undefined) {
    const modeContext = optionValue(runGameModeOptions, settings.gameMode, 'game_mode');
    configuration = { ...configuration, modeContext };
    if (modeContext !== base.modeContext) {
      changed.push('game_mode');
      words.push({ id: `game-options.game-mode.${modeContext}` as MessageId });
    }
  }
  if (settings?.age !== undefined) {
    const startingAge = optionValue(runStartingAgeOptions, settings.age, 'age');
    configuration = { ...configuration, startingAge };
    if (startingAge !== base.startingAge) {
      changed.push('age');
      words.push({ id: `game-options.age.${startingAge}` as MessageId });
    }
  }
  if (settings?.resources !== undefined) {
    const startingResources = optionValue(
      runStartingResourceOptions,
      settings.resources,
      'resources',
    );
    configuration = { ...configuration, startingResources };
    if (startingResources !== base.startingResources) {
      changed.push('resources');
      words.push({ id: `game-options.resources.${startingResources}` as MessageId });
    }
  }
  return { configuration, changed, words };
}

export function appSettingsLabel(configuration: RunConfiguration): string {
  const count = configuration.playerCount;
  const teams = appTeamsText(configuration.teamIds.slice(0, count));
  return [
    `${configuration.mapSize} ${configuration.width}x${configuration.height}`,
    `${count} ${count === 1 ? 'player' : 'players'}`,
    teams,
    configuration.modeContext,
    ...(configuration.startingAge === 'dark-age' || configuration.startingAge === 'standard'
      ? []
      : [configuration.startingAge]),
    ...(configuration.startingResources === 'standard' ? [] : [configuration.startingResources]),
  ].join(' · ');
}

function refusalReply(error: unknown): { code: ConnectorErrorCode; message: string } {
  if (error instanceof AppRunRefusal) return { code: error.code, message: error.message };
  return { code: 'internal', message: 'The run could not start in AoE2RMSIDE.' };
}

export function useAppRunBridge(
  host: { readonly current: AppRunHost | null },
  workspace: { readonly current: AppRunWorkspace },
): void {
  const busy = useRef(false);
  useEffect(() => {
    const answer = (request: ConnectorRendererRequest) => {
      if (request.kind !== 'run' && request.kind !== 'resolveRunContext') return;
      void (async () => {
        try {
          let payload: unknown;
          if (request.kind === 'resolveRunContext') {
            const { path } = validateAppRunContextRequest(request.payload);
            const target =
              path === null && !isPreviewScriptName(workspace.current.activeDocument().name)
                ? null
                : await resolveAppRunDocument(workspace.current, path, 'quality-check');
            if (!host.current) throw new AppRunRefusal('internal', 'The Run menu is not ready.');
            payload = host.current.context(target);
          } else {
            const run = validateAppRunRequest(request.payload);
            if (busy.current || !host.current) {
              payload = { outcome: 'busy' } satisfies AppRunReply;
            } else {
              busy.current = true;
              try {
                const document = await resolveAppRunDocument(workspace.current, run.path, run.kind);
                payload = await host.current.run(run, document);
              } finally {
                busy.current = false;
              }
            }
          }
          await window.rmside.replyToConnectorRequest({
            requestId: request.requestId,
            ok: true,
            payload,
          });
        } catch (error) {
          await window.rmside
            .replyToConnectorRequest({
              requestId: request.requestId,
              ok: false,
              error: refusalReply(error),
            })
            .catch(() => undefined);
        }
      })();
    };
    return window.rmside.onConnectorRequest(answer);
  }, [host, workspace]);
}
