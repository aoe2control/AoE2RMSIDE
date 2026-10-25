import { useEffect, useRef } from 'react';
import type { ConnectorRendererReply, ConnectorRendererRequest } from '../shared/connector-api';
import {
  validateConnectorSwitchFolderRequest,
  type ConnectorSwitchFolderOutcome,
  type ConnectorSwitchFolderReply,
} from '../shared/connector-workspace';
import { editionCapabilities } from '../shared/edition';

export type AppFolderSwitch = (id: string) => Promise<ConnectorSwitchFolderOutcome>;

export async function answerAppFolderSwitch(
  request: Pick<ConnectorRendererRequest, 'requestId' | 'kind' | 'payload'>,
  switchFolder: AppFolderSwitch,
): Promise<ConnectorRendererReply | null> {
  if (request.kind !== 'switchFolder') return null;
  let id: string;
  try {
    id = validateConnectorSwitchFolderRequest(request.payload).id;
  } catch {
    return {
      requestId: request.requestId,
      ok: false,
      error: { code: 'invalid_arguments', message: 'The folder request was not valid.' },
    };
  }
  try {
    const payload: ConnectorSwitchFolderReply = { outcome: await switchFolder(id) };
    return { requestId: request.requestId, ok: true, payload };
  } catch {
    return {
      requestId: request.requestId,
      ok: false,
      error: { code: 'internal', message: 'AoE2RMSIDE could not open the folder.' },
    };
  }
}

export function useAppFolderSwitchBridge(switchFolder: AppFolderSwitch): void {
  const current = useRef(switchFolder);
  current.current = switchFolder;
  useEffect(() => {
    if (!editionCapabilities.mcp) return undefined;
    return window.rmside.onConnectorRequest((request) => {
      if (request.kind !== 'switchFolder') return;
      void answerAppFolderSwitch(request, (id) => current.current(id))
        .then((reply) => (reply ? window.rmside.replyToConnectorRequest(reply) : undefined))
        .catch(() => undefined);
    });
  }, []);
}
