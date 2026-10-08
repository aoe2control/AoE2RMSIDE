import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConfigurationCatalog,
  DevelopmentFixtureDescriptor,
  LanguageServerNotificationMethod,
  LanguageServerRequestMethod,
  MapTestEvent,
  MapTestRunInput,
  MapTestRunResult,
  NativeProcessName,
  NativeProcessStatus,
  PreviewGenerationEvent,
  PreviewGenerationInput,
  PreviewGenerationResult,
} from '../shared/api';
import type { ExecutionProgressEvent } from '../shared/execution-cost';
import { DesktopError } from '../shared/desktop-error';
import type { PreviewCandidate } from '../shared/preview-candidate';
import { LanguageServerClient } from './language-server-client';
import { MapTestClient } from './map-test-client';
import { RmsdClient } from './protocol-client';
import type { LocalContentImportResult, LocalContentSource } from './local-content-service';
import type {
  GameArtNativeProgress,
  GameArtNativeResult,
  GameArtNativeSource,
} from './game-art-service';
import type { GameArtSpriteRequestObject } from '../shared/game-art';
import type { PresentationStringIdsResult } from './local-presentation-names';
import type {
  ControlPipeExchangeInput,
  ControlPipeExchangeResult,
  ControlPipeTransport,
} from './control-node-host';
import type { LanguageDocumentOverlay, MainSourceCatalog } from './source-catalog-service';
import { nativeSourceCatalogDiscovery } from './source-catalog-discovery';
import { sameXsEnvironment, type XsEnvironmentPayload } from './xs-environment';

export interface XsSyntaxCheckFile {
  uri: string;
  text: string;
}

export interface XsSyntaxCheckResult {
  uri: string;
  errors: Array<{ code: string; message: string; line: number; character: number }>;
}

export interface NativePaths {
  rmsd?: string;
  'rms-ls': string;
  'rms-test'?: string;
}

const maximumLanguageDocuments = 512;
const maximumLanguageDocumentUnits = 128 * 1024 * 1024;

export class NativeSupervisor {
  private readonly statuses = new Map<NativeProcessName, NativeProcessStatus>([
    ['rmsd', { name: 'rmsd', state: 'stopped' }],
    ['rms-ls', { name: 'rms-ls', state: 'stopped' }],
    ['rms-test', { name: 'rms-test', state: 'stopped' }],
    ['rms-test-lsp', { name: 'rms-test-lsp', state: 'stopped' }],
  ]);
  private rmsd: RmsdClient | undefined;
  private languageServer: LanguageServerClient | undefined;
  private mapTestLanguageServer: LanguageServerClient | undefined;
  private mapTest: MapTestClient | undefined;
  private languageSourceCatalog: MainSourceCatalog | undefined;
  private languageGeneration = 0;
  private languageDocumentRevision = 0;
  private languageMembershipRevision = 0;
  private languageEnvironmentRevision = 0;
  private languageAnalysisRevision = 0;
  private languageSetupRevision = 0;
  private modernEditorInventory = false;
  readonly sourceCatalogDiscovery = nativeSourceCatalogDiscovery(async (params) => {
    const server = this.languageServer;
    if (!server) {
      throw new DesktopError('native.unavailable', 'rms-ls is unavailable for source discovery', {
        name: 'rms-ls',
      });
    }
    const generation = this.languageGeneration;
    const result = await server.request('rms/sourceCatalogDiscovery', params);
    if (server !== this.languageServer || generation !== this.languageGeneration)
      throw new DesktopError(
        'source-catalog.changed',
        'native language process changed during source discovery',
      );
    return result;
  });

  languageIdentityEpoch(): string {
    return `${this.languageGeneration}:${this.languageDocumentRevision}:${this.languageSetupRevision}:${this.languageServer ? 'ready' : 'unavailable'}`;
  }
  languageProcessEpoch(): number {
    return this.languageGeneration;
  }
  languageAnalysisEpoch(): number {
    return this.languageAnalysisRevision;
  }
  languageEditorContextEpoch(): string {
    return `${this.languageGeneration}:${this.languageMembershipRevision}:${this.languageEnvironmentRevision}:${this.languageServer ? 'ready' : 'unavailable'}`;
  }

  enableEditorInventory(): void {
    this.modernEditorInventory = true;
  }
  usesMapTestLanguage(params: unknown): boolean {
    return this.languageIdForParams(params) === 'starlark';
  }

  async editorInventory(params: unknown): Promise<unknown> {
    const server = this.languageServer;
    const epoch = this.languageGeneration;
    if (!server) {
      throw new DesktopError('native.unavailable', 'rms-ls is unavailable for editor inventory', {
        name: 'rms-ls',
      });
    }
    const result = await server.request('rms/editorInventory', params);
    if (server !== this.languageServer || epoch !== this.languageGeneration)
      throw new DesktopError(
        'source-catalog.changed',
        'native language process changed during editor inventory',
      );
    return result;
  }

  editorInventoryChanged(editorContext: unknown): void {
    this.notifyRms('rms/editorInventoryChanged', { editorContext });
  }

  currentLanguageSourceCatalog(): MainSourceCatalog | undefined {
    return this.languageSourceCatalog;
  }

  invalidateLanguageSourceCatalog(expected: MainSourceCatalog | undefined): void {
    if (this.languageSourceCatalog !== expected) return;
    this.languageSourceCatalog = undefined;
    this.notifyRms('rms/sourceCatalogInvalidated', {
      contractVersion: { major: 1, minor: 0, patch: 0 },
      expectedCatalog: expected ? languageCatalogIdentity(expected) : null,
    });
  }
  private languagePreviewContext: unknown;
  private languageXsEnvironment: XsEnvironmentPayload | null = null;
  private languageLintDisabledRules: string[] = [];
  private readonly languageDocuments = new Map<
    string,
    { uri: string; languageId: string; version: number; text: string }
  >();

  constructor(
    private readonly paths: NativePaths,
    private readonly onStatus: (status: NativeProcessStatus) => void,
    private readonly onLanguageNotification: (
      method: string,
      params: unknown,
      nativeGeneration?: number,
    ) => void = () => {},
  ) {}

  async startAll(): Promise<void> {
    const starts = this.paths.rmsd
      ? [this.startRmsd(), this.startLanguageServer()]
      : [this.startLanguageServer()];
    if (this.paths['rms-test']) starts.push(this.startMapTestLanguageServer());
    await Promise.allSettled(starts);
  }

  getStatuses(): NativeProcessStatus[] {
    return [...this.statuses.values()].filter(({ name }) =>
      name === 'rmsd'
        ? this.paths.rmsd !== undefined
        : name === 'rms-ls' || this.paths['rms-test'] !== undefined,
    );
  }

  async restart(name: NativeProcessName): Promise<NativeProcessStatus> {
    if (name === 'rmsd') {
      await this.rmsd?.stop();
      this.rmsd = undefined;
      await this.startRmsd();
    } else if (name === 'rms-ls') {
      await this.stopLanguageServer();
      await this.startLanguageServer();
    } else if (name === 'rms-test-lsp') {
      await this.stopMapTestLanguageServer();
      await this.startMapTestLanguageServer();
    } else if (name === 'rms-test') {
      await this.forceTerminateMapTest();
      await this.ensureMapTest();
    } else {
      throw new Error('native process name is unsupported');
    }
    return this.statuses.get(name) ?? { name, state: 'failed', detail: 'missing status' };
  }

  async getConfigurationCatalog(): Promise<ConfigurationCatalog> {
    if (!this.rmsd) throw rmsdUnavailable();
    return this.rmsd.getConfigurationCatalog();
  }

  async readPresentationStringIds(datPath: string): Promise<PresentationStringIdsResult> {
    if (!this.rmsd) throw rmsdUnavailable();
    return this.rmsd.readPresentationStringIds(datPath);
  }

  async generatePreview(
    input: PreviewGenerationInput,
    sourceCatalog: MainSourceCatalog,
    onGenerationEvent?: (event: PreviewGenerationEvent) => void,
    internalFixtureId?: DevelopmentFixtureDescriptor['id'],
    localProductVersion = '',
    onExecutionProgress?: (event: ExecutionProgressEvent) => void,
    localContent?: LocalContentSource,
    onPreviewCandidate?: (candidate: PreviewCandidate) => void,
  ): Promise<PreviewGenerationResult> {
    if (!this.rmsd) throw rmsdUnavailable();
    return this.rmsd.generatePreview(
      input,
      sourceCatalog,
      onGenerationEvent,
      internalFixtureId,
      localProductVersion,
      onExecutionProgress,
      localContent,
      onPreviewCandidate,
    );
  }

  async importLocalContent(source: LocalContentSource): Promise<LocalContentImportResult> {
    if (!this.rmsd) throw rmsdUnavailable();
    return this.rmsd.importLocalContent(source);
  }

  async prepareGameArt(
    requestId: string,
    source: GameArtNativeSource,
    onProgress: (progress: GameArtNativeProgress) => void,
  ): Promise<GameArtNativeResult> {
    if (!this.rmsd) throw rmsdUnavailable();
    return this.rmsd.prepareGameArt(requestId, source, onProgress);
  }

  async gameArtSprites(
    requestId: string,
    source: GameArtNativeSource,
    objects: readonly GameArtSpriteRequestObject[],
    onProgress: (progress: GameArtNativeProgress) => void,
  ): Promise<GameArtNativeResult> {
    if (!this.rmsd) throw rmsdUnavailable();
    return this.rmsd.gameArtSprites(requestId, source, objects, onProgress);
  }

  async cancelGameArt(requestId: string): Promise<boolean> {
    if (!this.rmsd) return false;
    return this.rmsd.cancelGeneration(requestId);
  }

  readonly controlPipeTransport: ControlPipeTransport = {
    exchange: (requestId, input) => this.controlPipeExchange(requestId, input),
    cancel: async (requestId) => (this.rmsd ? this.rmsd.cancelGeneration(requestId) : false),
  };

  private async controlPipeExchange(
    requestId: string,
    input: ControlPipeExchangeInput,
  ): Promise<ControlPipeExchangeResult> {
    if (!this.rmsd) throw new Error('rmsd is unavailable');
    return this.rmsd.controlPipeExchange(requestId, input);
  }

  async runMapTest(
    input: MapTestRunInput,
    sourceCatalogs: readonly MainSourceCatalog[],
    onEvent?: (event: MapTestEvent) => void,
    localContent?: LocalContentSource,
  ): Promise<MapTestRunResult> {
    await this.ensureMapTest();
    if (!this.mapTest) {
      throw new DesktopError('native.unavailable', 'rms-test is unavailable', { name: 'rms-test' });
    }
    return this.mapTest.run(input, sourceCatalogs, onEvent, localContent);
  }

  async cancelMapTest(requestId: string): Promise<boolean> {
    return this.mapTest?.cancel(requestId) ?? false;
  }

  async forceTerminateMapTest(): Promise<void> {
    const client = this.mapTest;
    this.mapTest = undefined;
    await client?.forceTerminate();
  }

  languageDocumentOverlays(): LanguageDocumentOverlay[] {
    return [...this.languageDocuments.values()].map(({ uri, version, text }) => ({
      uri,
      version,
      text,
    }));
  }

  languageDocument(uri: string): LanguageDocumentOverlay | undefined {
    const direct = this.languageDocuments.get(uri);
    const requestedKey = languageDocumentUriKey(uri);
    const document =
      direct ??
      [...this.languageDocuments.values()].find(
        (candidate) => languageDocumentUriKey(candidate.uri) === requestedKey,
      );
    return document
      ? { uri: document.uri, version: document.version, text: document.text }
      : undefined;
  }

  updateLanguageSourceCatalog(catalog: MainSourceCatalog): void {
    const current = this.languageSourceCatalog;
    this.languageSourceCatalog = catalog;
    if (
      current?.revision === catalog.revision &&
      Buffer.from(current.catalogHash).equals(Buffer.from(catalog.catalogHash))
    ) {
      return;
    }
    this.notifyRms('rms/sourceCatalog', languageSourceCatalogPayload(catalog));
  }

  updateLanguageXsEnvironment(payload: XsEnvironmentPayload): void {
    if (sameXsEnvironment(this.languageXsEnvironment, payload)) return;
    this.languageXsEnvironment = structuredClone(payload);
    this.languageEnvironmentRevision += 1;
    this.languageSetupRevision += 1;
    this.notifyRms('rms/xsEnvironment', payload);
  }

  updateLanguageLintSettings(disabledRules: readonly string[]): void {
    const next = [...disabledRules].sort();
    if (
      this.languageLintDisabledRules.length === next.length &&
      this.languageLintDisabledRules.every((code, index) => code === next[index])
    ) {
      return;
    }
    this.languageLintDisabledRules = next;
    this.languageServer?.notify('rms/lintSettings', { disabledRules: next });
  }

  async checkXsSyntax(files: readonly XsSyntaxCheckFile[]): Promise<XsSyntaxCheckResult[]> {
    if (files.length === 0) return [];
    if (!this.languageServer) {
      throw new DesktopError(
        'native.unavailable',
        'the XS syntax check is unavailable because rms-ls is not running',
        { name: 'rms-ls' },
      );
    }
    const result = (await this.languageServer.request('rms/xsSyntaxCheck', {
      files: files.map(({ uri, text }) => ({ uri, text })),
    })) as { files?: unknown } | null;
    if (!result || !Array.isArray(result.files)) {
      throw new Error('rms-ls returned an invalid XS syntax check');
    }
    return result.files.map((entry) => {
      const value = entry as { uri?: unknown; errors?: unknown };
      if (typeof value.uri !== 'string' || !Array.isArray(value.errors)) {
        throw new Error('rms-ls returned an invalid XS syntax check');
      }
      return {
        uri: value.uri,
        errors: value.errors.map((error) => {
          const item = error as Record<string, unknown>;
          if (
            typeof item.code !== 'string' ||
            typeof item.message !== 'string' ||
            !Number.isInteger(item.line) ||
            !Number.isInteger(item.character)
          ) {
            throw new Error('rms-ls returned an invalid XS syntax check');
          }
          return {
            code: item.code,
            message: item.message,
            line: Number(item.line),
            character: Number(item.character),
          };
        }),
      };
    });
  }

  async cancelPreview(clientRequestId: string): Promise<boolean> {
    if (!this.rmsd) return false;
    return this.rmsd.cancelGeneration(clientRequestId);
  }

  requestLanguageServer(method: LanguageServerRequestMethod, params: unknown): Promise<unknown> {
    if (!languageServerRequestMethods.has(method)) {
      return Promise.reject(new Error('language-server request method is not allowed'));
    }
    const documentUri = (params as { textDocument?: { uri?: unknown } } | null)?.textDocument?.uri;
    if (typeof documentUri === 'string' && !this.languageDocuments.has(documentUri)) {
      return Promise.resolve(null);
    }
    const languageId = this.languageIdForParams(params);
    const server = languageId === 'starlark' ? this.mapTestLanguageServer : this.languageServer;
    if (!server) {
      return Promise.reject(
        languageId === 'starlark'
          ? new DesktopError('native.unavailable', 'rms-test LSP is unavailable', {
              name: 'rms-test-lsp',
            })
          : new DesktopError('native.unavailable', 'rms-ls is unavailable', { name: 'rms-ls' }),
      );
    }
    return server.request(method, params);
  }

  notifyLanguageServer(method: LanguageServerNotificationMethod, params: unknown): void {
    if (!languageServerNotificationMethods.has(method)) {
      throw new Error('language-server notification method is not allowed');
    }
    if (method === 'rms/previewContext') {
      this.languagePreviewContext = structuredClone(params);
      this.languageSetupRevision += 1;
    }
    const previousLanguageId = this.languageIdForParams(params);
    this.updateLanguageDocumentMirror(method, params);
    if (method === 'rms/previewContext') {
      this.notifyRms(method, params);
      return;
    }
    const languageId = previousLanguageId ?? this.languageIdForParams(params);
    if (languageId === 'starlark') this.mapTestLanguageServer?.notify(method, params);
    else this.notifyRms(method, params);
  }

  mirrorLanguageServerNotification(
    method: LanguageServerNotificationMethod,
    params: unknown,
  ): void {
    if (!languageServerNotificationMethods.has(method)) {
      throw new Error('language-server notification method is not allowed');
    }
    this.updateLanguageDocumentMirror(method, params);
  }

  synchronizeLanguageDocument(uri: string): void {
    const document = this.languageDocuments.get(uri);
    if (!document) return;
    const server =
      document.languageId === 'starlark' ? this.mapTestLanguageServer : this.languageServer;
    if (!server) return;
    if (server === this.languageServer) this.languageAnalysisRevision += 1;
    server.notify('textDocument/didChange', {
      textDocument: { uri: document.uri, version: document.version },
      contentChanges: [{ text: document.text }],
    });
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([
      this.rmsd?.stop(),
      this.mapTest?.stop(),
      this.stopLanguageServer(),
      this.stopMapTestLanguageServer(),
    ]);
    this.rmsd = undefined;
    this.mapTest = undefined;
  }

  killAll(): void {
    for (const client of [
      this.rmsd,
      this.mapTest,
      this.languageServer,
      this.mapTestLanguageServer,
    ]) {
      client?.kill();
    }
  }

  private async startRmsd(): Promise<void> {
    this.assertExecutable('rmsd');
    const client = new RmsdClient(this.paths.rmsd!, (status) => this.updateStatus(status));
    this.rmsd = client;
    try {
      await client.start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.updateStatus({ name: 'rmsd', state: 'failed', detail });
      throw error;
    }
  }

  private async startLanguageServer(): Promise<void> {
    this.languageGeneration += 1;
    const generation = this.languageGeneration;
    this.languageAnalysisRevision = 0;
    if (this.modernEditorInventory) this.languageSourceCatalog = undefined;
    this.assertExecutable('rms-ls');
    const client = new LanguageServerClient(
      this.paths['rms-ls'],
      (status) => {
        if (
          (status.state === 'failed' || status.state === 'stopped') &&
          this.languageServer === client
        ) {
          this.languageServer = undefined;
        }
        this.updateStatus(status);
      },
      (method, params) => this.onLanguageNotification(method, params, generation),
    );
    try {
      await client.start();
      this.languageServer = client;
      if (this.modernEditorInventory) {
        await client.request('rms/editorInventory', {
          contractVersion: { major: 1, minor: 0, patch: 0 },
          action: 'invalidate',
          contextId: `native-start-${generation}`,
        });
      } else if (this.languageSourceCatalog) {
        this.notifyRms(
          'rms/sourceCatalog',
          languageSourceCatalogPayload(this.languageSourceCatalog),
        );
      }
      if (this.languagePreviewContext !== undefined) {
        this.notifyRms('rms/previewContext', this.languagePreviewContext);
      }
      if (this.languageXsEnvironment) {
        this.notifyRms('rms/xsEnvironment', this.languageXsEnvironment);
      }
      if (this.languageLintDisabledRules.length > 0) {
        client.notify('rms/lintSettings', { disabledRules: this.languageLintDisabledRules });
      }
      for (const document of this.languageDocuments.values()) {
        if (document.languageId !== 'starlark') {
          this.notifyRms('textDocument/didOpen', { textDocument: document });
        }
      }
    } catch (error) {
      this.languageServer = undefined;
      throw error;
    }
  }

  async forceTerminateRmsdAndRestart(): Promise<void> {
    const client = this.rmsd;
    this.rmsd = undefined;
    await client?.forceTerminate();
    await this.startRmsd();
  }

  async forceTerminateRmsd(): Promise<void> {
    const client = this.rmsd;
    this.rmsd = undefined;
    await client?.forceTerminate();
  }

  private async startMapTestLanguageServer(): Promise<void> {
    this.assertExecutable('rms-test');
    const executablePath = this.paths['rms-test'];
    if (!executablePath) throw new Error('rms-test executable is unavailable');
    const client = new LanguageServerClient(
      executablePath,
      (status) => {
        if (
          (status.state === 'failed' || status.state === 'stopped') &&
          this.mapTestLanguageServer === client
        ) {
          this.mapTestLanguageServer = undefined;
        }
        this.updateStatus(status);
      },
      this.onLanguageNotification,
      'rms-test-lsp',
      ['lsp'],
    );
    try {
      await client.start();
      this.mapTestLanguageServer = client;
      for (const document of this.languageDocuments.values()) {
        if (document.languageId === 'starlark') {
          client.notify('textDocument/didOpen', { textDocument: document });
        }
      }
    } catch (error) {
      this.mapTestLanguageServer = undefined;
      throw error;
    }
  }

  private async ensureMapTest(): Promise<void> {
    if (this.mapTest) return;
    this.assertExecutable('rms-test');
    const executablePath = this.paths['rms-test'];
    if (!executablePath) throw new Error('rms-test executable is unavailable');
    const client = new MapTestClient(executablePath, (status) => {
      if ((status.state === 'failed' || status.state === 'stopped') && this.mapTest === client) {
        this.mapTest = undefined;
      }
      this.updateStatus(status);
    });
    this.mapTest = client;
    try {
      await client.start();
    } catch (error) {
      if (this.mapTest === client) this.mapTest = undefined;
      throw error;
    }
  }

  private async stopLanguageServer(): Promise<void> {
    const client = this.languageServer;
    if (!client) return;
    this.languageServer = undefined;
    await client.stop();
  }

  private async stopMapTestLanguageServer(): Promise<void> {
    const client = this.mapTestLanguageServer;
    if (!client) return;
    this.mapTestLanguageServer = undefined;
    await client.stop();
  }

  private assertExecutable(name: keyof NativePaths): void {
    const path = this.paths[name];
    if (!path) throw new Error(`no program file is set for ${name}`);
    if (!existsSync(path)) {
      const status = {
        name,
        state: 'failed' as const,
        detail: `a program file of AoE2RMSIDE is missing: ${path}`,
      };
      this.updateStatus(status);
      throw new Error(status.detail);
    }
  }

  private updateStatus(status: NativeProcessStatus): void {
    this.statuses.set(status.name, status);
    this.onStatus(status);
  }

  private notifyRms(method: string, params: unknown): void {
    if (!this.languageServer) return;
    if (
      [
        'textDocument/didOpen',
        'textDocument/didChange',
        'textDocument/didClose',
        'rms/xsEnvironment',
        'rms/previewContext',
      ].includes(method)
    )
      this.languageAnalysisRevision += 1;
    this.languageServer.notify(method, params);
  }

  private updateLanguageDocumentMirror(
    method: LanguageServerNotificationMethod,
    params: unknown,
  ): void {
    const value = params as {
      textDocument?: { uri?: unknown; languageId?: unknown; version?: unknown; text?: unknown };
      contentChanges?: Array<{ text?: unknown }>;
    };
    const uri = value?.textDocument?.uri;
    if (typeof uri !== 'string') return;
    if (method === 'textDocument/didClose') {
      if (this.languageDocuments.delete(uri)) {
        this.languageDocumentRevision += 1;
        this.languageMembershipRevision += 1;
      }
      return;
    }
    if (method === 'textDocument/didOpen') {
      const { languageId, version, text } = value.textDocument ?? {};
      if (
        typeof languageId === 'string' &&
        typeof version === 'number' &&
        typeof text === 'string'
      ) {
        this.assertLanguageDocumentBudget(uri, text);
        this.languageDocuments.set(uri, { uri, languageId, version, text });
        this.languageDocumentRevision += 1;
        this.languageMembershipRevision += 1;
      }
      return;
    }
    if (method === 'textDocument/didChange') {
      const current = this.languageDocuments.get(uri);
      const version = value.textDocument?.version;
      const text = value.contentChanges?.at(-1)?.text;
      if (
        current &&
        typeof version === 'number' &&
        version > current.version &&
        typeof text === 'string'
      ) {
        this.assertLanguageDocumentBudget(uri, text);
        this.languageDocuments.set(uri, { ...current, version, text });
        this.languageDocumentRevision += 1;
      }
    }
  }

  private assertLanguageDocumentBudget(uri: string, text: string): void {
    const existing = this.languageDocuments.get(uri);
    if (!existing && this.languageDocuments.size >= maximumLanguageDocuments) {
      throw new Error('too many open language documents');
    }
    let total = text.length;
    for (const document of this.languageDocuments.values()) {
      if (document.uri !== uri) total += document.text.length;
    }
    if (total > maximumLanguageDocumentUnits) {
      throw new Error('open language documents exceed their bounded size');
    }
  }

  private languageIdForParams(params: unknown): string | undefined {
    const value = params as { textDocument?: { uri?: unknown; languageId?: unknown } } | null;
    const explicit = value?.textDocument?.languageId;
    if (typeof explicit === 'string') return explicit;
    const uri = value?.textDocument?.uri;
    if (typeof uri !== 'string') return undefined;
    return this.languageDocuments.get(uri)?.languageId;
  }
}

function rmsdUnavailable(): DesktopError {
  return new DesktopError('native.unavailable', 'rmsd is unavailable', { name: 'rmsd' });
}

function languageDocumentUriKey(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return `uri:${uri}`;
    const path = resolve(fileURLToPath(parsed));
    return `file:${process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path}`;
  } catch {
    return `uri:${uri}`;
  }
}

function languageSourceCatalogPayload(catalog: MainSourceCatalog): unknown {
  return {
    contractVersion: catalog.contractVersion,
    revision: catalog.revision,
    entryPath: catalog.entryPath,
    sources: catalog.sources.map((source) => ({
      normalizedPath: source.normalizedPath,
      sourceId: source.sourceId,
      rawHash: Buffer.from(source.rawHash).toString('hex'),
      sourceBase64: Buffer.from(source.source).toString('base64'),
      origin: source.origin,
      role: source.role,
      ...(source.bufferRevision === undefined ? {} : { bufferRevision: source.bufferRevision }),
    })),
    roots: catalog.roots,
    caseSensitive: catalog.caseSensitive,
    profileId: catalog.profileId,
    contentIdentity: catalog.contentIdentity,
    implicitDefinitions: catalog.implicitDefinitions,
    implicitEnvironmentHash: Buffer.from(catalog.implicitEnvironmentHash).toString('hex'),
    catalogHash: Buffer.from(catalog.catalogHash).toString('hex'),
    rmsGraphHash: Buffer.from(catalog.rmsGraphHash).toString('hex'),
    externalAssetHash: Buffer.from(catalog.externalAssetHash).toString('hex'),
  };
}

export function languageCatalogIdentity(catalog: MainSourceCatalog): Record<string, unknown> {
  return {
    revision: catalog.revision,
    entryPath: catalog.entryPath,
    catalogHash: Buffer.from(catalog.catalogHash).toString('hex'),
    rmsGraphHash: Buffer.from(catalog.rmsGraphHash).toString('hex'),
    externalAssetHash: Buffer.from(catalog.externalAssetHash).toString('hex'),
  };
}

const languageServerRequestMethods = new Set<LanguageServerRequestMethod>([
  'textDocument/completion',
  'textDocument/signatureHelp',
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/documentLink',
  'textDocument/references',
  'textDocument/documentHighlight',
  'textDocument/documentSymbol',
  'textDocument/foldingRange',
  'textDocument/semanticTokens/full',
  'workspace/symbol',
  'textDocument/formatting',
  'textDocument/prepareRename',
  'textDocument/rename',
  'textDocument/codeAction',
  'textDocument/inlayHint',
  'completionItem/resolve',
  'rms/semanticIdentity',
]);

const languageServerNotificationMethods = new Set<LanguageServerNotificationMethod>([
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
  'workspace/didChangeWatchedFiles',
  'rms/previewContext',
]);
