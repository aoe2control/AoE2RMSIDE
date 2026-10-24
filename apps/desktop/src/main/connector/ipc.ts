import { join, resolve, win32 } from 'node:path';
import {
  connectorIpcChannels,
  validateConnectorAppName,
  validateConnectorPairingAnswer,
  validateConnectorRendererReply,
  validateConnectorSettingsPatch,
  type ConnectorSetup,
} from '../../shared/connector-api';
import type { IpcRegistrar } from '../edition-ipc';
import type { ConnectorService } from './connector-service';

export function registerConnectorIpc(
  ipc: Pick<IpcRegistrar, 'handle'>,
  options: {
    service: () => ConnectorService | undefined;
    assertSender: (event: unknown) => void;
  },
): void {
  const service = () => {
    const current = options.service();
    if (!current) throw new Error('MCP is not available');
    return current;
  };
  ipc.handle(connectorIpcChannels.connectorState, (event) => {
    options.assertSender(event);
    return service().state();
  });
  ipc.handle(connectorIpcChannels.connectorSettingsSet, (event, patch: unknown) => {
    options.assertSender(event);
    return service().setSettings(validateConnectorSettingsPatch(patch));
  });
  ipc.handle(connectorIpcChannels.connectorAppRemove, async (event, name: unknown) => {
    options.assertSender(event);
    await service().removeApp(validateConnectorAppName(name));
  });
  ipc.handle(
    connectorIpcChannels.connectorPairingDecide,
    async (event, requestId: unknown, decision: unknown) => {
      options.assertSender(event);
      const answer = validateConnectorPairingAnswer(requestId, decision);
      await service().decidePairing(answer.requestId, answer.decision);
    },
  );
  ipc.handle(connectorIpcChannels.connectorSetup, (event) => {
    options.assertSender(event);
    return service().setup();
  });
  ipc.handle(connectorIpcChannels.connectorReply, (event, reply: unknown) => {
    options.assertSender(event);
    service().bridge.reply(validateConnectorRendererReply(reply));
  });
}

const defaultUserDataSegments = ['@rmside', 'desktop'] as const;

export function connectorSetupFor(paths: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  appDataPath: string;
  userDataPath: string;
}): ConnectorSetup {
  const nativeRoot = paths.packaged
    ? join(paths.resourcesPath, 'native')
    : resolve(paths.appPath, '..', '..', 'target', 'debug');
  const defaultUserData = win32.resolve(paths.appDataPath, ...defaultUserDataSegments);
  const userData = win32.resolve(paths.userDataPath);
  const isDefault = userData.toLowerCase() === defaultUserData.toLowerCase();
  return {
    program: join(nativeRoot, 'rms-connect.exe'),
    args: isDefault ? [] : ['--ide-data', userData],
  };
}
