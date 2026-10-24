import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileBounded, replaceFileAtomically } from '../bounded-file';
import { connectorKeyBytes } from './handshake';

export const connectorFolderName = 'mcp';
export const connectorKeyFileName = 'connector-key';

export function connectorFolder(userDataPath: string): string {
  return join(userDataPath, connectorFolderName);
}

export function connectorKeyPath(userDataPath: string): string {
  return join(connectorFolder(userDataPath), connectorKeyFileName);
}

export function createConnectorKey(): Uint8Array {
  return new Uint8Array(randomBytes(connectorKeyBytes));
}

export class ConnectorKeyFile {
  readonly path: string;

  constructor(userDataPath: string) {
    this.path = connectorKeyPath(userDataPath);
  }

  async write(key: Uint8Array): Promise<void> {
    if (key.byteLength !== connectorKeyBytes) throw new Error('the connector key must be 32 bytes');
    await replaceFileAtomically(this.path, key);
  }

  async read(): Promise<Uint8Array> {
    const bytes = await readFileBounded(this.path, connectorKeyBytes);
    if (bytes.byteLength !== connectorKeyBytes)
      throw new Error('the connector key file is damaged');
    return new Uint8Array(bytes);
  }

  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
