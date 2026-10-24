import { join } from 'node:path';
import { readFileBounded, replaceFileAtomically } from '../bounded-file';
import { connectorBridgeLimits, isConnectorDisplayText } from '../../shared/connector-api';
import { connectorFolder } from './key-file';

export const allowedAppsFileName = 'allowed-apps.json';
export const allowedAppsSchemaVersion = '1.0.0';
export const maximumAllowedApps = connectorBridgeLimits.allowedApps;
const maximumAllowedAppsBytes = 64 * 1024;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export interface AllowedAppRecord {
  name: string;
  title: string;
  firstAllowed: string;
  lastUsed: string;
}

export type PairingDecision = 'approved' | 'denied' | 'unknown';

type ParsedAllowedApps =
  { kind: 'apps'; apps: AllowedAppRecord[] } | { kind: 'other-major' } | { kind: 'damaged' };

export function parseAllowedApps(value: unknown): ParsedAllowedApps {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'damaged' };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.schemaVersion !== 'string') return { kind: 'damaged' };
  const major = /^(0|[1-9]\d*)\.\d+\.\d+$/u.exec(record.schemaVersion)?.[1];
  if (major === undefined) return { kind: 'damaged' };
  if (major !== '1') return { kind: 'other-major' };
  if (!Array.isArray(record.apps) || record.apps.length > maximumAllowedApps) {
    return { kind: 'damaged' };
  }
  const apps: AllowedAppRecord[] = [];
  const names = new Set<string>();
  for (const entry of record.apps as unknown[]) {
    if (entry === null || typeof entry !== 'object') return { kind: 'damaged' };
    const app = entry as Record<string, unknown>;
    if (
      !isConnectorDisplayText(app.name, 1, connectorBridgeLimits.appName) ||
      !isConnectorDisplayText(app.title, 0, connectorBridgeLimits.appTitle) ||
      typeof app.firstAllowed !== 'string' ||
      !timestampPattern.test(app.firstAllowed) ||
      typeof app.lastUsed !== 'string' ||
      !timestampPattern.test(app.lastUsed) ||
      names.has(app.name as string)
    ) {
      return { kind: 'damaged' };
    }
    names.add(app.name as string);
    apps.push({
      name: app.name as string,
      title: app.title as string,
      firstAllowed: app.firstAllowed,
      lastUsed: app.lastUsed,
    });
  }
  return { kind: 'apps', apps };
}

export class ConnectorPairingStore {
  readonly path: string;
  private apps: AllowedAppRecord[] = [];
  private readonly deniedForSession = new Set<string>();
  private writable = true;
  private loaded: Promise<void> | undefined;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    userDataPath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(connectorFolder(userDataPath), allowedAppsFileName);
  }

  load(): Promise<void> {
    this.loaded ??= this.readFile();
    return this.loaded;
  }

  decide(name: string): PairingDecision {
    if (this.deniedForSession.has(name)) return 'denied';
    return this.apps.some((app) => app.name === name) ? 'approved' : 'unknown';
  }

  list(): readonly AllowedAppRecord[] {
    return this.apps.map((app) => ({ ...app }));
  }

  async allow(name: string, title: string): Promise<void> {
    await this.load();
    this.deniedForSession.delete(name);
    const stamp = this.now().toISOString();
    const existing = this.apps.find((app) => app.name === name);
    if (existing) {
      existing.title = title;
      existing.lastUsed = stamp;
    } else {
      this.apps.push({ name, title, firstAllowed: stamp, lastUsed: stamp });
      if (this.apps.length > maximumAllowedApps) {
        const leastRecent = [...this.apps].sort((left, right) =>
          left.lastUsed.localeCompare(right.lastUsed),
        )[0]!;
        this.apps = this.apps.filter((app) => app !== leastRecent);
      }
    }
    await this.persist();
  }

  denyForSession(name: string): void {
    this.deniedForSession.add(name);
  }

  async touch(name: string): Promise<void> {
    await this.load();
    const app = this.apps.find((entry) => entry.name === name);
    if (!app) return;
    app.lastUsed = this.now().toISOString();
    await this.persist();
  }

  async remove(name: string): Promise<boolean> {
    await this.load();
    const before = this.apps.length;
    this.apps = this.apps.filter((app) => app.name !== name);
    if (this.apps.length === before) return false;
    await this.persist();
    return true;
  }

  private async readFile(): Promise<void> {
    let parsed: ParsedAllowedApps;
    try {
      const bytes = await readFileBounded(this.path, maximumAllowedAppsBytes);
      parsed = parseAllowedApps(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      parsed =
        (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
          ? { kind: 'apps', apps: [] }
          : { kind: 'damaged' };
    }
    if (parsed.kind === 'apps') {
      this.apps = parsed.apps;
    } else {
      this.apps = [];
      this.writable = parsed.kind === 'damaged';
    }
  }

  private persist(): Promise<void> {
    if (!this.writable) return Promise.resolve();
    const snapshot = JSON.stringify({ schemaVersion: allowedAppsSchemaVersion, apps: this.apps });
    const run = this.pending
      .catch(() => undefined)
      .then(() => replaceFileAtomically(this.path, snapshot));
    this.pending = run;
    return run;
  }
}
