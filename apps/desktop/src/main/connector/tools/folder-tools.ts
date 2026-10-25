import { resolve } from 'node:path';
import type { WorkspaceSwitchFolder } from '../../../shared/api';
import {
  connectorFolderIdPattern,
  validateConnectorSwitchFolderReply,
} from '../../../shared/connector-workspace';
import {
  ConnectorToolError,
  connectorJsonText,
  type ConnectorToolContext,
  type ConnectorToolRegistry,
  type ConnectorToolResult,
} from '../dispatcher';
import type { AppLane } from '../lane';
import type { ConnectorRendererBridge } from '../renderer-bridge';
import type { ConnectorToolArguments } from '../validator';
import { fitItems } from './workspace-tools';

export type FolderSwitchUserBusy = 'dialog' | 'opening' | null;

export interface FolderToolDependencies {
  folders(): Promise<readonly WorkspaceSwitchFolder[]>;
  root(): string | null;
  isProtected(path: string): boolean;
  lane: Pick<AppLane, 'admit'>;
  userBusy(): FolderSwitchUserBusy;
  bridge: Pick<ConnectorRendererBridge, 'request'>;
  switchTimeoutMs?: number;
}

const defaultSwitchTimeoutMs = 30_000;
const maximumNameChars = 120;

function shownName(name: string): string {
  return [...name].slice(0, maximumNameChars).join('');
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function goneError(): ConnectorToolError {
  return new ConnectorToolError(
    'not_found',
    'No recent folder has this id; the folder may be gone.',
    { hint: 'Call list_folders for the current folders and their ids.' },
  );
}

function userBusyError(busy: Exclude<FolderSwitchUserBusy, null>): ConnectorToolError {
  return new ConnectorToolError(
    'busy',
    busy === 'dialog'
      ? 'The user has a dialog open in AoE2RMSIDE.'
      : 'AoE2RMSIDE is opening another folder.',
    { hint: 'Try again in a moment, or ask the user.', retryAfterSeconds: 10 },
  );
}

export function registerFolderTools(
  registry: ConnectorToolRegistry,
  dependencies: FolderToolDependencies,
): () => void {
  const tools = new FolderTools(dependencies);
  const unregister = [
    registry.register('list_folders', (args, context) => tools.listFolders(args, context)),
    registry.register('open_folder', (args, context) => tools.openFolder(args, context)),
  ];
  return () => {
    for (const remove of unregister) remove();
  };
}

export class FolderTools {
  constructor(private readonly dependencies: FolderToolDependencies) {}

  private async offered(): Promise<WorkspaceSwitchFolder[]> {
    const folders = await this.dependencies.folders();
    return folders.filter((folder) => !this.dependencies.isProtected(folder.path));
  }

  async listFolders(
    _args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const folders = await this.offered();
    const root = this.dependencies.root();
    const openProtected = root !== null && this.dependencies.isProtected(root);
    const openListed = folders.some((folder) => folder.open);
    const items = folders.map((folder) => ({
      id: folder.id,
      name: shownName(folder.name),
      ...(folder.open ? { open: true as const } : {}),
    }));
    const note =
      folders.length === 0
        ? 'No recent folders. Ask the user to open their scripts folder in AoE2RMSIDE (File > Open Folder).'
        : root === null
          ? 'No folder is open; open_folder opens one of these.'
          : openProtected
            ? 'The open folder is a game or mod folder AI apps cannot use; open_folder opens one of these.'
            : openListed
              ? undefined
              : 'The open folder is not among the recent folders.';
    const { value, shown } = fitItems(items, context.tool.output.maxChars, (list, omitted) => ({
      folders: list,
      ...(note ? { note } : {}),
      ...(omitted > 0 ? { more: { folders: omitted } } : {}),
    }));
    return {
      content: [{ type: 'text', text: connectorJsonText(value) }],
      facts: { count: shown },
    };
  }

  async openFolder(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const id = args.id;
    if (typeof id !== 'string' || !connectorFolderIdPattern.test(id)) {
      throw new ConnectorToolError('invalid_arguments', 'The id is not a folder id.', {
        hint: 'Use an id as list_folders gives it.',
      });
    }
    const folder = (await this.offered()).find((candidate) => candidate.id === id);
    if (!folder) throw goneError();
    const name = shownName(folder.name);
    if (folder.open) {
      return {
        content: [
          { type: 'text', text: connectorJsonText({ folder: name, status: 'already_open' }) },
        ],
      };
    }
    const busyBefore = this.dependencies.userBusy();
    if (busyBefore) throw userBusyError(busyBefore);
    await this.dependencies.lane.admit(context.signal);
    const busyAfter = this.dependencies.userBusy();
    if (busyAfter) throw userBusyError(busyAfter);
    let reply;
    try {
      reply = validateConnectorSwitchFolderReply(
        await this.dependencies.bridge.request(
          'switchFolder',
          { id },
          {
            timeoutMilliseconds: this.dependencies.switchTimeoutMs ?? defaultSwitchTimeoutMs,
            signal: context.signal,
          },
        ),
      );
    } catch (error) {
      if (error instanceof ConnectorToolError) throw error;
      throw new ConnectorToolError('internal', 'The AoE2RMSIDE window gave an invalid answer.');
    }
    if (reply.outcome === 'gone') throw goneError();
    const root = this.dependencies.root();
    if (root === null || pathKey(root) !== pathKey(folder.path)) {
      throw new ConnectorToolError('internal', 'AoE2RMSIDE did not open the folder.', {
        hint: 'Call ide_status to see which folder is open.',
      });
    }
    return {
      content: [
        {
          type: 'text',
          text: connectorJsonText({
            folder: name,
            status: 'switched',
            note: 'Open tabs stay open. Paths now start in this folder.',
          }),
        },
      ],
      facts: { name },
    };
  }
}
