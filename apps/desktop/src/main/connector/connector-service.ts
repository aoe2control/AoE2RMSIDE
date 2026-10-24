import { randomUUID } from 'node:crypto';
import { GoodbyeReason } from '../../generated/rmside/connect/v1/connect_pb';
import type {
  ConnectorFailure,
  ConnectorOutputRow,
  ConnectorPairing,
  ConnectorPairingDecision,
  ConnectorPairingRequest,
  ConnectorRendererRequest,
  ConnectorSettingsPatch,
  ConnectorSetup,
  ConnectorState,
} from '../../shared/connector-api';
import { ConnectorCatalogError, type ConnectorCatalog } from './catalog';
import { ConnectorToolRegistry } from './dispatcher';
import { ConnectorKeyFile, createConnectorKey } from './key-file';
import { connectionOutputRow } from './output-rows';
import { ConnectorPairingStore } from './pairing-store';
import { ConnectorPipeServer, type ConnectorPipeConnection } from './pipe-server';
import { ConnectorRendererBridge } from './renderer-bridge';
import {
  ConnectorSettingsStore,
  defaultConnectorSettings,
  type ConnectorSettings,
} from './settings';

export type ConnectorStopReason = 'ide-closing' | 'ide-updating';

export interface ConnectorServiceOptions {
  userDataPath: string;
  ideVersion: string;
  catalog: () => ConnectorCatalog;
  publishState: (state: ConnectorState) => void;
  publishRow: (row: ConnectorOutputRow) => void;
  sendRequest: (request: ConnectorRendererRequest) => boolean;
  setup: () => ConnectorSetup;
  onPairingRequested?: () => void;
  registry?: ConnectorToolRegistry;
  log?: (message: string, error?: unknown) => void;
  now?: () => Date;
}

interface OpenPairingRequest {
  request: ConnectorPairingRequest;
  connections: Set<ConnectorPipeConnection>;
}

const maximumPairingRequests = 4;

export class ConnectorService {
  readonly registry: ConnectorToolRegistry;
  readonly bridge: ConnectorRendererBridge;
  private readonly settingsStore: ConnectorSettingsStore;
  private readonly pairingStore: ConnectorPairingStore;
  private readonly keyFile: ConnectorKeyFile;
  private settings: ConnectorSettings = { ...defaultConnectorSettings };
  private server: ConnectorPipeServer | undefined;
  private failure: ConnectorFailure | null = null;
  private readonly requests = new Map<string, OpenPairingRequest>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: ConnectorServiceOptions) {
    this.registry = options.registry ?? new ConnectorToolRegistry();
    this.bridge = new ConnectorRendererBridge(options.sendRequest);
    this.settingsStore = new ConnectorSettingsStore(options.userDataPath);
    this.pairingStore = new ConnectorPairingStore(options.userDataPath, options.now);
    this.keyFile = new ConnectorKeyFile(options.userDataPath);
  }

  initialize(): Promise<void> {
    return this.serialize(async () => {
      this.settings = await this.settingsStore.read();
      await this.pairingStore.load();
      if (this.settings.enabled) await this.startServer();
      else await this.keyFile.remove().catch(() => undefined);
      this.publish();
    });
  }

  currentSettings(): Readonly<ConnectorSettings> {
    return this.settings;
  }

  state(): ConnectorState {
    const sessions = this.server?.sessionList() ?? [];
    const connectedNames = new Set(
      sessions
        .filter((session) => session.pairing === 'approved')
        .map((session) => session.app.name),
    );
    return {
      enabled: this.settings.enabled,
      allowSaving: this.settings.allowSaving,
      server: {
        status: this.failure ? 'failed' : this.server ? 'running' : 'off',
        failure: this.failure,
      },
      connections: sessions.map((session) => ({
        id: session.id,
        name: session.app.name,
        displayName: [...session.app.displayName].slice(0, 128).join(''),
        pairing: session.pairing,
        working: session.working,
      })),
      allowedApps: this.pairingStore.list().map((app) => ({
        ...app,
        connected: connectedNames.has(app.name),
      })),
      pairingRequests: [...this.requests.values()].map((open) => ({ ...open.request })),
    };
  }

  setSettings(patch: ConnectorSettingsPatch): Promise<ConnectorState> {
    return this.serialize(async () => {
      const wasEnabled = this.settings.enabled;
      this.settings = await this.settingsStore.update(patch);
      if (!this.stopped) {
        if (this.settings.enabled && !wasEnabled) await this.startServer();
        else if (!this.settings.enabled && wasEnabled) {
          await this.stopServer(GoodbyeReason.MCP_TURNED_OFF);
        } else if (this.settings.enabled && this.failure) await this.startServer();
      }
      this.publish();
      return this.state();
    });
  }

  removeApp(name: string): Promise<void> {
    return this.serialize(async () => {
      await this.pairingStore.remove(name);
      for (const session of this.server?.sessionList() ?? []) {
        if (session.app.name === name) session.goodbye(GoodbyeReason.APP_REMOVED);
      }
      this.publish();
    });
  }

  decidePairing(requestId: string, decision: ConnectorPairingDecision): Promise<void> {
    return this.serialize(async () => {
      const open = [...this.requests.values()].find((entry) => entry.request.id === requestId);
      if (!open) return;
      this.closeRequest(open);
      const { name, title, displayName } = open.request;
      if (decision === 'allow') {
        await this.pairingStore
          .allow(name, title)
          .catch((error: unknown) => this.options.log?.('the allowed apps were not saved', error));
        for (const connection of open.connections) this.approve(connection);
      } else {
        this.pairingStore.denyForSession(name);
        for (const connection of open.connections) connection.setPairing('denied');
        this.options.publishRow(connectionOutputRow('denied', displayName));
      }
      this.publish();
    });
  }

  setup(): ConnectorSetup {
    return this.options.setup();
  }

  stop(reason: ConnectorStopReason): Promise<void> {
    this.stopped = true;
    return this.serialize(() =>
      this.stopServer(
        reason === 'ide-updating' ? GoodbyeReason.IDE_UPDATING : GoodbyeReason.IDE_CLOSING,
      ),
    );
  }

  rendererReset(): void {
    this.bridge.rendererReset();
  }

  private async startServer(): Promise<void> {
    if (this.server) await this.stopServer(GoodbyeReason.MCP_TURNED_OFF);
    this.failure = null;
    let catalog: ConnectorCatalog;
    try {
      catalog = this.options.catalog();
    } catch (error) {
      this.options.log?.('the connector catalog cannot be used', error);
      this.failure = error instanceof ConnectorCatalogError ? 'catalog' : 'internal';
      return;
    }
    const key = createConnectorKey();
    let server: ConnectorPipeServer;
    try {
      server = await ConnectorPipeServer.listen({
        key,
        catalog,
        ideVersion: this.options.ideVersion,
        registry: this.registry,
        settings: () => this.settings,
        pairingFor: (connection) => this.pairingFor(connection),
        onSessionOpened: () => this.publish(),
        onSessionClosed: (connection) => this.sessionClosed(connection),
        onRow: (row) => this.options.publishRow(row),
        onChange: () => this.publish(),
        ...(this.options.log ? { log: this.options.log } : {}),
      });
    } catch (error) {
      this.options.log?.('the connector pipe could not be opened', error);
      this.failure =
        (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE' ? 'pipe-in-use' : 'internal';
      return;
    }
    try {
      await this.keyFile.write(key);
    } catch (error) {
      this.options.log?.('the connector key file could not be written', error);
      await server.close(GoodbyeReason.MCP_TURNED_OFF);
      this.failure = 'key-file';
      return;
    }
    this.server = server;
  }

  private async stopServer(reason: GoodbyeReason): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.failure = null;
    for (const open of [...this.requests.values()]) this.closeRequest(open);
    await server?.close(reason);
    await this.keyFile
      .remove()
      .catch((error: unknown) =>
        this.options.log?.('the connector key file was not removed', error),
      );
    this.publish();
  }

  private pairingFor(connection: ConnectorPipeConnection): ConnectorPairing {
    const app = connection.app;
    const decision = this.pairingStore.decide(app.name);
    if (decision === 'approved') {
      this.options.publishRow(connectionOutputRow('connected', app.displayName));
      void this.pairingStore
        .touch(app.name)
        .catch((error: unknown) => this.options.log?.('the allowed apps were not saved', error));
      return 'approved';
    }
    if (decision === 'denied') {
      this.options.publishRow(connectionOutputRow('denied', app.displayName));
      return 'denied';
    }
    let open = this.requests.get(app.name);
    if (!open) {
      this.makeRoomForRequest();
      open = {
        request: {
          id: randomUUID(),
          name: app.name,
          displayName: [...app.displayName].slice(0, 128).join(''),
          title: app.title,
          version: app.version,
          launcherImage: app.launcherImage,
        },
        connections: new Set(),
      };
      this.requests.set(app.name, open);
      this.options.onPairingRequested?.();
    }
    open.connections.add(connection);
    return 'pending';
  }

  private makeRoomForRequest(): void {
    if (this.requests.size < maximumPairingRequests) return;
    const open = [...this.requests.values()];
    const oldest = open.find((entry) => entry.connections.size === 0) ?? open[0]!;
    this.closeRequest(oldest);
  }

  private approve(connection: ConnectorPipeConnection): void {
    if (!connection.ready || connection.pairing === 'approved') return;
    connection.setPairing('approved');
    this.options.publishRow(connectionOutputRow('connected', connection.app.displayName));
  }

  private sessionClosed(connection: ConnectorPipeConnection): void {
    this.requests.get(connection.app.name)?.connections.delete(connection);
    if (connection.pairing === 'approved') {
      this.options.publishRow(connectionOutputRow('disconnected', connection.app.displayName));
    }
    this.publish();
  }

  private closeRequest(open: OpenPairingRequest): void {
    if (this.requests.get(open.request.name) === open) this.requests.delete(open.request.name);
  }

  private publish(): void {
    this.options.publishState(this.state());
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(work);
    this.queue = run;
    return run;
  }
}
