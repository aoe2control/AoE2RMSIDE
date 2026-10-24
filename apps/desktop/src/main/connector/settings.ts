import { join } from 'node:path';
import { readFileBounded, replaceFileAtomically } from '../bounded-file';
import { connectorFolder } from './key-file';

export const connectorSettingsFileName = 'connector-settings.json';
export const connectorSettingsSchemaVersion = '1.0.0';
const maximumSettingsBytes = 4 * 1024;

export interface ConnectorSettings {
  enabled: boolean;
  allowSaving: boolean;
}

export const defaultConnectorSettings: Readonly<ConnectorSettings> = Object.freeze({
  enabled: false,
  allowSaving: false,
});

export function parseConnectorSettings(value: unknown): ConnectorSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...defaultConnectorSettings };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.schemaVersion !== 'string' || !/^1\.\d+\.\d+$/u.test(record.schemaVersion)) {
    return { ...defaultConnectorSettings };
  }
  return {
    enabled: record.enabled === true,
    allowSaving: record.allowSaving === true,
  };
}

export class ConnectorSettingsStore {
  readonly path: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(userDataPath: string) {
    this.path = join(connectorFolder(userDataPath), connectorSettingsFileName);
  }

  read(): Promise<ConnectorSettings> {
    return this.serialize(() => this.readUnqueued());
  }

  update(change: Partial<ConnectorSettings>): Promise<ConnectorSettings> {
    return this.serialize(async () => {
      const next = { ...(await this.readUnqueued()), ...change };
      await replaceFileAtomically(
        this.path,
        JSON.stringify({
          schemaVersion: connectorSettingsSchemaVersion,
          enabled: next.enabled,
          allowSaving: next.allowSaving,
        }),
      );
      return next;
    });
  }

  private async readUnqueued(): Promise<ConnectorSettings> {
    try {
      const bytes = await readFileBounded(this.path, maximumSettingsBytes);
      return parseConnectorSettings(JSON.parse(bytes.toString('utf8')));
    } catch {
      return { ...defaultConnectorSettings };
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pending.catch(() => undefined).then(work);
    this.pending = run;
    return run;
  }
}
