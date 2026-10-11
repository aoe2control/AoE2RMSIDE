import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageId } from '../shared/i18n/translator';
import { outputNote, type OutputMessage } from '../shared/output-message';
import {
  compatibilityProfile,
  externalLanguageNames,
  externalLanguages,
  untestedVersion,
  versionLabel,
  type CompatibilityProfile,
  type ExternalLanguage,
  type ExternalServerIdentity,
} from './external-language-compatibility';
import type { ExternalServerCandidate } from './external-language-detection';
import {
  attributeExternalDiagnostics,
  externalRoute,
  isEmptyAnswer,
  isExternalRoutedMethod,
  mergeCompletion,
  mergeDiagnostics,
  normalizeExternalCompletion,
  normalizeExternalHover,
  normalizeExternalLocations,
  normalizeExternalSignatureHelp,
  serverSupports,
  type ExternalDiagnostic,
  type MergeDiagnostic,
} from './external-language-merge';
import {
  asciiSubstitute,
  DocumentLines,
  isLspPosition,
  isPositionEncoding,
  offeredPositionEncodings,
  positionToServer,
  rangeFromServer,
  type LspRange,
  type PositionEncoding,
} from './external-language-position';
import type {
  ExternalLanguageSetting,
  ExternalLanguageSettings,
} from './external-language-settings';
import { LanguageServerClient, type LanguageServerRequestBudget } from './language-server-client';

export interface ExternalLanguageServersOptions {
  settings: {
    read(): Promise<ExternalLanguageSettings>;
    update(
      language: ExternalLanguage,
      change: Partial<ExternalLanguageSetting>,
    ): Promise<ExternalLanguageSettings>;
  };
  detect(language: ExternalLanguage): Promise<ExternalServerCandidate[]>;
  launch?: (candidate: ExternalServerCandidate) => { command: string; args: string[] };
  publishOutput(message: OutputMessage): void;
  publishDiagnostics(params: unknown): void;
  onAvailabilityChanged(): void;
  fileExists(path: string): boolean;
  readDiskText(path: string): string | null;
  clientVersion?: string;
  budget?: LanguageServerRequestBudget;
  changeDelayMilliseconds?: number;
  interactiveWaitMilliseconds?: number;
  restartDelaysMilliseconds?: readonly number[];
  restartWindowMilliseconds?: number;
  now?: () => number;
}

export const externalRequestBudget: LanguageServerRequestBudget = Object.freeze({
  idleMilliseconds: 5_000,
  maximumMilliseconds: 15_000,
});
export const externalInteractiveWaitMilliseconds = 2_000;
export const externalMaximumMessageBytes = 4 * 1024 * 1024;
const maximumStderrTail = 4_000;
const consecutiveTimeoutLimit = 3;
const maximumConfigurationFolders = 32;
const defaultRestartDelays = [1_000, 4_000, 16_000] as const;

export type ExternalFailureReason =
  'start' | 'handshake' | 'capabilities' | 'exit' | 'timeout' | 'protocol';

const reasonMessages: Readonly<Record<ExternalFailureReason, MessageId>> = {
  start: 'external-language-server.reason.start',
  handshake: 'external-language-server.reason.handshake',
  capabilities: 'external-language-server.reason.capabilities',
  exit: 'external-language-server.reason.exit',
  timeout: 'external-language-server.reason.timeout',
  protocol: 'external-language-server.reason.protocol',
};

interface MirroredDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  lines?: DocumentLines;
}

interface Connection {
  epoch: number;
  language: ExternalLanguage;
  candidate: ExternalServerCandidate;
  client: LanguageServerClient<string>;
  identity: ExternalServerIdentity;
  profile: CompatibilityProfile;
  capabilities: Record<string, unknown>;
  encoding: PositionEncoding;
  opened: Map<string, number>;
  pendingChanges: Map<string, ReturnType<typeof setTimeout>>;
  consecutiveTimeouts: number;
  configurationKey: string;
  stderr: string;
  failed: boolean;
}

interface LanguageState {
  detected: { candidate: ExternalServerCandidate; displayName: string } | null;
  connection: Connection | null;
  restarts: number[];
  restartTimer: ReturnType<typeof setTimeout> | null;
  exhausted: boolean;
  external: Map<string, ExternalDiagnostic[]>;
}

type ExternalDocumentLanguage = ExternalLanguage | null;

export class ExternalLanguageServers {
  private readonly documents = new Map<string, MirroredDocument>();
  private readonly builtInDiagnostics = new Map<string, Record<string, unknown>>();
  private readonly states: Record<ExternalLanguage, LanguageState> = {
    rms: emptyState(),
    xs: emptyState(),
  };
  private settings: ExternalLanguageSettings | undefined;
  private readonly clients = new Set<LanguageServerClient<string>>();
  private nextEpoch = 1;
  private disposed = false;
  private readonly restartDelays: readonly number[];
  private readonly now: () => number;

  constructor(private readonly options: ExternalLanguageServersOptions) {
    this.restartDelays = options.restartDelaysMilliseconds ?? defaultRestartDelays;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.settings = await this.options.settings.read();
    await Promise.all(externalLanguages.map((language) => this.detectAndStart(language)));
  }

  availableServers(): Array<{ language: ExternalLanguage; displayName: string }> {
    return externalLanguages.flatMap((language) => {
      const detected = this.states[language].detected;
      return detected ? [{ language, displayName: detected.displayName }] : [];
    });
  }

  menuSettings(): ExternalLanguageSettings {
    const shown = {} as Record<ExternalLanguage, ExternalLanguageSetting>;
    for (const language of externalLanguages) {
      const setting = this.setting(language);
      shown[language] = { ...setting, use: setting.use && !this.states[language].exhausted };
    }
    return shown;
  }

  active(language: ExternalLanguage): boolean {
    return !!this.states[language].connection && this.setting(language).use;
  }

  async setUse(language: ExternalLanguage, use: boolean): Promise<void> {
    this.settings = await this.options.settings.update(language, { use });
    const state = this.states[language];
    if (use) {
      state.restarts = [];
      state.exhausted = false;
      if (!state.connection && state.detected)
        await this.connect(language, state.detected.candidate);
    } else {
      this.clearRestart(state);
      await this.disconnect(language);
    }
    this.republish(language);
    this.options.onAvailabilityChanged();
  }

  async setFillGaps(language: ExternalLanguage, fillGaps: boolean): Promise<void> {
    this.settings = await this.options.settings.update(language, { fillGaps });
    this.republish(language);
    this.options.onAvailabilityChanged();
  }

  didOpen(params: unknown): void {
    const document = (params as { textDocument?: Record<string, unknown> } | null)?.textDocument;
    if (
      !document ||
      typeof document.uri !== 'string' ||
      typeof document.languageId !== 'string' ||
      typeof document.version !== 'number' ||
      typeof document.text !== 'string'
    )
      return;
    const mirrored: MirroredDocument = {
      uri: document.uri,
      languageId: document.languageId,
      version: document.version,
      text: document.text,
    };
    this.documents.set(mirrored.uri, mirrored);
    const language = languageOf(mirrored.languageId);
    if (!language) return;
    const connection = this.states[language].connection;
    if (connection) {
      this.openInServer(connection, mirrored);
      this.updateConfiguration(connection);
    }
  }

  didChange(params: unknown): void {
    const value = params as {
      textDocument?: { uri?: unknown; version?: unknown };
      contentChanges?: Array<{ text?: unknown }>;
    } | null;
    const uri = value?.textDocument?.uri;
    const version = value?.textDocument?.version;
    const text = value?.contentChanges?.at(-1)?.text;
    if (typeof uri !== 'string' || typeof version !== 'number' || typeof text !== 'string') return;
    const document = this.documents.get(uri);
    if (!document || version <= document.version) return;
    document.version = version;
    document.text = text;
    document.lines = undefined;
    const language = languageOf(document.languageId);
    const connection = language ? this.states[language].connection : null;
    if (connection) this.scheduleChange(connection, uri);
  }

  didClose(params: unknown): void {
    const uri = (params as { textDocument?: { uri?: unknown } } | null)?.textDocument?.uri;
    if (typeof uri !== 'string') return;
    const document = this.documents.get(uri);
    this.documents.delete(uri);
    this.builtInDiagnostics.delete(uri);
    if (!document) return;
    const language = languageOf(document.languageId);
    if (!language) return;
    const state = this.states[language];
    state.external.delete(uri);
    const connection = state.connection;
    if (connection) {
      this.closeInServer(connection, document);
      this.updateConfiguration(connection);
    }
  }

  acceptBuiltInDiagnostics(params: unknown): unknown {
    const value = params as { uri?: unknown; diagnostics?: unknown } | null;
    if (!value || typeof value.uri !== 'string' || !Array.isArray(value.diagnostics)) return params;
    const language = this.documentLanguage(value.uri);
    if (!language) return params;
    this.builtInDiagnostics.set(value.uri, value as Record<string, unknown>);
    return this.covers(language, value.uri) ? this.merged(value.uri, language) : params;
  }

  async request(
    method: string,
    params: unknown,
    builtIn: () => Promise<unknown>,
    beforeExternal: () => void = () => {},
  ): Promise<unknown> {
    if (!isExternalRoutedMethod(method)) return builtIn();
    const uri = (params as { textDocument?: { uri?: unknown } } | null)?.textDocument?.uri;
    const document = typeof uri === 'string' ? this.documents.get(uri) : undefined;
    const language = document ? languageOf(document.languageId) : null;
    if (!document || !language || !this.active(language)) return builtIn();
    const connection = this.states[language].connection!;
    const setting = this.setting(language);
    const route = externalRoute(
      method,
      serverSupports(method, connection.capabilities),
      setting.fillGaps,
    );
    if (route === 'built-in') return builtIn();
    if (route === 'none') return null;
    if (!connection.opened.has(document.uri)) return builtIn();
    this.flushChanges(connection);
    const position = (params as { position?: unknown }).position;
    if (!isLspPosition(position)) return builtIn();
    const context = (params as { context?: unknown }).context;
    const externalParams = {
      textDocument: { uri: document.uri },
      position: positionToServer(linesOf(document), position, connection.encoding),
      ...(method === 'textDocument/completion' && isCompletionContext(context) ? { context } : {}),
    };
    const builtInAnswer = route === 'merge' ? builtIn().then(fulfilled, rejected) : undefined;
    if (!builtInAnswer) beforeExternal();
    let raw: unknown;
    try {
      raw = await withinWait(
        connection.client.request(method, externalParams),
        this.options.interactiveWaitMilliseconds ?? externalInteractiveWaitMilliseconds,
      );
      connection.consecutiveTimeouts = 0;
    } catch (error) {
      this.requestFailed(connection, error);
      return builtInAnswer ? unwrapSettled(await builtInAnswer) : builtIn();
    }
    if (this.states[language].connection !== connection) {
      return builtInAnswer ? unwrapSettled(await builtInAnswer) : builtIn();
    }
    const normalized = this.normalizeAnswer(connection, method, raw, document);
    if (route === 'external-only') return isEmptyAnswer(normalized) ? null : normalized;
    if (route === 'external-first') return isEmptyAnswer(normalized) ? builtIn() : normalized;
    const external = (normalized as ReturnType<typeof normalizeExternalCompletion>) ?? {
      isIncomplete: false,
      items: [],
    };
    const builtInResult = await builtInAnswer!;
    if (!builtInResult.ok) {
      if (external.items.length > 0) return external;
      throw builtInResult.error;
    }
    return mergeCompletion(external, builtInResult.value);
  }

  async stop(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(externalLanguages.map((language) => this.disconnect(language)));
    for (const language of externalLanguages) this.clearRestart(this.states[language]);
  }

  kill(): void {
    this.disposed = true;
    for (const language of externalLanguages) this.clearRestart(this.states[language]);
    for (const client of this.clients) client.kill();
    this.clients.clear();
  }

  private setting(language: ExternalLanguage): ExternalLanguageSetting {
    return this.settings?.[language] ?? { use: true, fillGaps: true };
  }

  private documentLanguage(uri: string): ExternalDocumentLanguage {
    const document = this.documents.get(uri);
    if (document) return languageOf(document.languageId);
    return null;
  }

  private async detectAndStart(language: ExternalLanguage): Promise<void> {
    let candidates: ExternalServerCandidate[];
    try {
      candidates = await this.options.detect(language);
    } catch {
      candidates = [];
    }
    const rejections: Array<{
      candidate: ExternalServerCandidate;
      reason: ExternalFailureReason;
      detail: string;
    }> = [];
    for (const candidate of candidates) {
      if (this.disposed) return;
      const outcome = await this.connect(language, candidate, { probe: true });
      if (outcome.ok) {
        this.options.onAvailabilityChanged();
        return;
      }
      rejections.push({ candidate, reason: outcome.reason, detail: outcome.detail });
    }
    if (this.disposed) return;
    for (const rejection of rejections) {
      this.options.publishOutput(
        outputNote(
          'App',
          'external-language.rejected',
          {
            id: 'external-language-server.rejected.headline',
            args: { program: rejection.candidate.path },
          },
          {
            severity: 'warning',
            cause: { id: reasonMessages[rejection.reason] },
            action: {
              text: {
                id: 'external-language-server.action.not-used',
                args: { language: externalLanguageNames[language] },
              },
            },
            ...(rejection.detail ? { detail: rejection.detail } : {}),
          },
        ),
      );
    }
  }

  private async connect(
    language: ExternalLanguage,
    candidate: ExternalServerCandidate,
    { probe = false }: { probe?: boolean } = {},
  ): Promise<{ ok: true } | { ok: false; reason: ExternalFailureReason; detail: string }> {
    const state = this.states[language];
    const epoch = this.nextEpoch++;
    const launch = this.options.launch?.(candidate) ?? { command: candidate.path, args: [] };
    let connection: Connection | undefined;
    let stderr = '';
    const client: LanguageServerClient<string> = new LanguageServerClient<string>(
      launch.command,
      (status) => {
        if (status.state === 'failed' && connection)
          this.connectionFailed(connection, status.detail ?? '');
      },
      (method, params) => {
        if (connection) this.acceptNotification(connection, method, params);
      },
      `external ${externalLanguageNames[language]} language server`,
      launch.args,
      this.options.budget ?? externalRequestBudget,
      {
        maximumMessageBytes: externalMaximumMessageBytes,
        initializeParams: this.initializeParams(),
        onServerRequest: (method, params): unknown =>
          this.answerServerRequest(
            connection?.profile ?? this.handshakeProfile(language, candidate, client),
            language,
            method,
            params,
          ),
        onStderr: (chunk) => {
          stderr = (stderr + chunk).slice(-maximumStderrTail);
          if (connection) connection.stderr = stderr;
        },
        cancelOnTimeout: true,
        omitVoidParams: true,
      },
    );
    this.clients.add(client);
    let result: unknown;
    try {
      result = await client.start();
    } catch (error) {
      this.clients.delete(client);
      await client.closed(250);
      client.kill();
      const reason: ExternalFailureReason = isSpawnError(error) ? 'start' : 'handshake';
      const written = client.unreadOutput;
      const detail = detailText(
        error,
        [written && `stdout: ${written}`, stderr].filter(Boolean).join('\n'),
      );
      if (!probe) this.reportFailure(language, candidate, reason, detail);
      return { ok: false, reason, detail };
    }
    const validated = validateHandshake(result);
    if (!validated || this.disposed) {
      this.clients.delete(client);
      await client.stop().catch(() => undefined);
      const detail = detailText(new Error('the handshake answer was refused'), stderr);
      if (!validated && !probe) this.reportFailure(language, candidate, 'capabilities', detail);
      return { ok: false, reason: 'capabilities', detail };
    }
    const identity: ExternalServerIdentity = {
      name: validated.serverName,
      version: validated.serverVersion,
      programPath: candidate.path,
      bundleVersion: candidate.bundleVersion,
    };
    const profile = compatibilityProfile(language, identity);
    connection = {
      epoch,
      language,
      candidate,
      client,
      identity,
      profile,
      capabilities: validated.capabilities,
      encoding: profile.positionEncoding ?? validated.encoding,
      opened: new Map(),
      pendingChanges: new Map(),
      consecutiveTimeouts: 0,
      configurationKey: '',
      stderr,
      failed: false,
    };
    if (state.connection) await this.disconnect(language);
    state.connection = connection;
    state.detected = { candidate, displayName: profile.displayName };
    if (!this.setting(language).use) {
      await this.disconnect(language);
      return { ok: true };
    }
    connection.configurationKey = configurationKey(this.configurationFolders(language));
    for (const document of this.documents.values()) {
      if (languageOf(document.languageId) === language) this.openInServer(connection, document);
    }
    const version = versionLabel(identity);
    this.options.publishOutput(
      outputNote(
        'App',
        'external-language.started',
        {
          id: 'external-language-server.started.headline',
          args: { server: profile.displayName, language: externalLanguageNames[language] },
        },
        untestedVersion(profile, identity)
          ? {
              cause: {
                id: 'external-language-server.untested.cause',
                args: { version: version ?? '?' },
              },
            }
          : {},
      ),
    );
    this.republish(language);
    return { ok: true };
  }

  private initializeParams(): Record<string, unknown> {
    const documentation = ['markdown', 'plaintext'];
    return {
      processId: process.pid,
      clientInfo: { name: 'AoE2RMSIDE', version: this.options.clientVersion ?? '0.0.0' },
      rootUri: null,
      workspaceFolders: null,
      capabilities: {
        general: { positionEncodings: [...offeredPositionEncodings] },
        workspace: { configuration: true, workspaceFolders: false },
        window: { workDoneProgress: false },
        textDocument: {
          synchronization: { didSave: false, willSave: false, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false, versionSupport: true },
          hover: { contentFormat: documentation },
          completion: {
            contextSupport: true,
            completionItem: { snippetSupport: true, documentationFormat: documentation },
          },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: documentation,
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          definition: { linkSupport: true },
        },
      },
    };
  }

  private handshakeProfile(
    language: ExternalLanguage,
    candidate: ExternalServerCandidate,
    client: LanguageServerClient<string>,
  ): CompatibilityProfile {
    const validated = validateHandshake(client.initializeResult);
    return compatibilityProfile(language, {
      name: validated?.serverName ?? null,
      version: validated?.serverVersion ?? null,
      programPath: candidate.path,
      bundleVersion: candidate.bundleVersion,
    });
  }

  private answerServerRequest(
    profile: CompatibilityProfile,
    language: ExternalLanguage,
    method: string,
    params: unknown,
  ): unknown {
    switch (method) {
      case 'workspace/configuration': {
        const items = (params as { items?: unknown } | null)?.items;
        if (!Array.isArray(items)) return [];
        const context = { documentFolders: this.configurationFolders(language) };
        return items.slice(0, 64).map((item) => {
          const section = (item as { section?: unknown } | null)?.section;
          return profile.configuration(typeof section === 'string' ? section : null, context);
        });
      }
      case 'window/workDoneProgress/create':
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/showMessageRequest':
        return null;
      default:
        return undefined;
    }
  }

  private acceptNotification(connection: Connection, method: string, params: unknown): void {
    if (this.states[connection.language].connection !== connection) return;
    if (method === 'window/showMessage' || method === 'window/logMessage') {
      const text = (params as { message?: unknown } | null)?.message;
      if (typeof text === 'string')
        connection.stderr = `${connection.stderr}\n${text}`.slice(-maximumStderrTail);
      return;
    }
    if (method !== 'textDocument/publishDiagnostics') return;
    const value = params as { uri?: unknown; version?: unknown; diagnostics?: unknown } | null;
    if (!value || typeof value.uri !== 'string') return;
    const document = this.documents.get(value.uri);
    if (!document || languageOf(document.languageId) !== connection.language) return;
    const sent = connection.opened.get(value.uri);
    if (typeof value.version === 'number' && sent !== undefined && value.version < sent) return;
    const lines = linesOf(document);
    const findings = attributeExternalDiagnostics(value.diagnostics, connection.profile, (range) =>
      rangeFromServer(lines, range, connection.encoding),
    );
    this.states[connection.language].external.set(value.uri, findings);
    if (this.covers(connection.language, value.uri)) {
      this.options.publishDiagnostics(this.merged(value.uri, connection.language));
    }
  }

  private merged(uri: string, language: ExternalLanguage): Record<string, unknown> {
    const builtIn = this.builtInDiagnostics.get(uri) ?? { uri, diagnostics: [] };
    const builtInFindings = (builtIn.diagnostics as unknown[]).filter(
      (finding): finding is MergeDiagnostic =>
        !!finding && typeof finding === 'object' && 'range' in finding,
    );
    const external = this.states[language].external.get(uri) ?? [];
    return {
      ...builtIn,
      diagnostics: mergeDiagnostics(builtInFindings, external, this.setting(language).fillGaps),
    };
  }

  private republish(language: ExternalLanguage): void {
    for (const document of this.documents.values()) {
      if (languageOf(document.languageId) !== language) continue;
      this.options.publishDiagnostics(
        this.covers(language, document.uri)
          ? this.merged(document.uri, language)
          : (this.builtInDiagnostics.get(document.uri) ?? { uri: document.uri, diagnostics: [] }),
      );
    }
  }

  private covers(language: ExternalLanguage, uri: string): boolean {
    const connection = this.states[language].connection;
    return !!connection && this.setting(language).use && connection.opened.has(uri);
  }

  private eligible(connection: Connection, document: MirroredDocument): boolean {
    if (!connection.profile.onlyExistingFiles || !/^file:/iu.test(document.uri)) return true;
    try {
      return this.options.fileExists(fileURLToPath(document.uri));
    } catch {
      return false;
    }
  }

  private serverText(connection: Connection, text: string): string {
    return connection.profile.asciiSubstitution ? asciiSubstitute(text) : text;
  }

  private send(connection: Connection, method: string, params: unknown): void {
    try {
      connection.client.notify(method, params);
    } catch (error) {
      this.connectionFailed(connection, error instanceof Error ? error.message : String(error));
    }
  }

  private openInServer(connection: Connection, document: MirroredDocument): void {
    if (!this.eligible(connection, document)) return;
    if (connection.opened.has(document.uri)) {
      connection.opened.delete(document.uri);
      this.send(connection, 'textDocument/didClose', { textDocument: { uri: document.uri } });
    }
    connection.opened.set(document.uri, document.version);
    this.send(connection, 'textDocument/didOpen', {
      textDocument: {
        uri: document.uri,
        languageId: document.languageId,
        version: document.version,
        text: this.serverText(connection, document.text),
      },
    });
  }

  private scheduleChange(connection: Connection, uri: string): void {
    if (!connection.opened.has(uri)) {
      const document = this.documents.get(uri);
      if (document) this.openInServer(connection, document);
      if (document && connection.opened.has(uri)) this.republish(connection.language);
      return;
    }
    const pending = connection.pendingChanges.get(uri);
    if (pending) clearTimeout(pending);
    connection.pendingChanges.set(
      uri,
      setTimeout(
        () => this.sendChange(connection, uri),
        this.options.changeDelayMilliseconds ?? 150,
      ),
    );
  }

  private sendChange(connection: Connection, uri: string): void {
    const pending = connection.pendingChanges.get(uri);
    if (pending) clearTimeout(pending);
    connection.pendingChanges.delete(uri);
    const document = this.documents.get(uri);
    if (!document || this.states[connection.language].connection !== connection) return;
    if ((connection.opened.get(uri) ?? Number.MAX_SAFE_INTEGER) >= document.version) return;
    connection.opened.set(uri, document.version);
    this.send(connection, 'textDocument/didChange', {
      textDocument: { uri, version: document.version },
      contentChanges: [{ text: this.serverText(connection, document.text) }],
    });
  }

  private flushChanges(connection: Connection): void {
    for (const uri of [...connection.pendingChanges.keys()]) this.sendChange(connection, uri);
  }

  private closeInServer(connection: Connection, document: MirroredDocument): void {
    const pending = connection.pendingChanges.get(document.uri);
    if (pending) clearTimeout(pending);
    connection.pendingChanges.delete(document.uri);
    const sent = connection.opened.get(document.uri);
    if (sent === undefined) return;
    connection.opened.delete(document.uri);
    if (connection.profile.refreshClosedFromDisk && /^file:/iu.test(document.uri)) {
      let disk: string | null = null;
      try {
        disk = this.options.readDiskText(fileURLToPath(document.uri));
      } catch {
        disk = null;
      }
      if (disk !== null) {
        this.send(connection, 'textDocument/didChange', {
          textDocument: { uri: document.uri, version: Math.max(sent, document.version) + 1 },
          contentChanges: [{ text: this.serverText(connection, disk) }],
        });
      }
    }
    this.send(connection, 'textDocument/didClose', { textDocument: { uri: document.uri } });
  }

  private configurationFolders(language: ExternalLanguage): string[] {
    const folders = new Set<string>();
    for (const document of this.documents.values()) {
      if (languageOf(document.languageId) !== language || !/^file:/iu.test(document.uri)) continue;
      try {
        folders.add(dirname(fileURLToPath(document.uri)));
      } catch {}
    }
    return [...folders].sort().slice(0, maximumConfigurationFolders);
  }

  private updateConfiguration(connection: Connection): void {
    if (!connection.profile.configurationUsesFolders) return;
    const key = configurationKey(this.configurationFolders(connection.language));
    if (key === connection.configurationKey) return;
    connection.configurationKey = key;
    this.send(connection, 'workspace/didChangeConfiguration', { settings: null });
  }

  private requestFailed(connection: Connection, error: unknown): void {
    if ((error as { code?: unknown } | null)?.code !== 'native.timeout') return;
    connection.consecutiveTimeouts += 1;
    if (connection.consecutiveTimeouts >= consecutiveTimeoutLimit) {
      this.connectionFailed(connection, 'requests timed out', 'timeout');
    }
  }

  private connectionFailed(
    connection: Connection,
    detail: string,
    reason?: ExternalFailureReason,
  ): void {
    const state = this.states[connection.language];
    if (connection.failed || state.connection !== connection) return;
    connection.failed = true;
    state.connection = null;
    for (const timer of connection.pendingChanges.values()) clearTimeout(timer);
    connection.pendingChanges.clear();
    connection.client.kill();
    this.clients.delete(connection.client);
    state.external.clear();
    this.republish(connection.language);
    if (this.disposed) return;
    const failure = reason ?? (/ exited \(code /u.test(detail) ? 'exit' : 'protocol');
    this.reportFailure(
      connection.language,
      connection.candidate,
      failure,
      [detail, connection.stderr].filter(Boolean).join('\n'),
    );
  }

  private reportFailure(
    language: ExternalLanguage,
    candidate: ExternalServerCandidate,
    reason: ExternalFailureReason,
    detail: string,
  ): void {
    const state = this.states[language];
    const now = this.now();
    const window = this.options.restartWindowMilliseconds ?? 10 * 60 * 1_000;
    state.restarts = state.restarts.filter((time) => now - time < window);
    const attempt = state.restarts.length + 1;
    const delay = this.restartDelays[state.restarts.length];
    const restart = delay !== undefined && this.setting(language).use && !this.disposed;
    const server = state.detected?.displayName ?? candidate.path;
    this.options.publishOutput(
      outputNote(
        'App',
        'external-language.stopped',
        { id: 'external-language-server.stopped.headline', args: { server } },
        {
          severity: restart ? 'warning' : 'error',
          cause: { id: reasonMessages[reason] },
          action: {
            text: restart
              ? {
                  id: 'external-language-server.action.restarting',
                  args: {
                    seconds: Math.max(1, Math.round(delay / 1_000)),
                    attempt,
                    limit: this.restartDelays.length,
                  },
                }
              : {
                  id: 'external-language-server.action.built-in',
                  args: { language: externalLanguageNames[language] },
                },
          },
          ...(detail ? { detail: detail.slice(-maximumStderrTail) } : {}),
        },
      ),
    );
    if (!restart) {
      state.exhausted = true;
      this.options.onAvailabilityChanged();
      return;
    }
    state.restarts.push(now);
    this.clearRestart(state);
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (this.disposed || !this.setting(language).use || state.connection) return;
      void this.connect(language, candidate);
    }, delay);
  }

  private clearRestart(state: LanguageState): void {
    if (state.restartTimer) clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }

  private async disconnect(language: ExternalLanguage): Promise<void> {
    const state = this.states[language];
    const connection = state.connection;
    if (!connection) return;
    state.connection = null;
    connection.failed = true;
    for (const timer of connection.pendingChanges.values()) clearTimeout(timer);
    connection.pendingChanges.clear();
    state.external.clear();
    await connection.client.stop().catch(() => connection.client.kill());
    this.clients.delete(connection.client);
  }

  private normalizeAnswer(
    connection: Connection,
    method: string,
    raw: unknown,
    document: MirroredDocument,
  ): unknown {
    const convert = (range: LspRange) =>
      rangeFromServer(linesOf(document), range, connection.encoding);
    switch (method) {
      case 'textDocument/hover':
        return normalizeExternalHover(raw, convert);
      case 'textDocument/completion':
        return normalizeExternalCompletion(raw);
      case 'textDocument/signatureHelp':
        return normalizeExternalSignatureHelp(raw);
      case 'textDocument/definition':
        return normalizeExternalLocations(raw).map((location) => {
          const target = this.documents.get(location.uri);
          return target
            ? {
                uri: location.uri,
                range: rangeFromServer(linesOf(target), location.range, connection.encoding),
              }
            : location;
        });
      default:
        return null;
    }
  }
}

function emptyState(): LanguageState {
  return {
    detected: null,
    connection: null,
    restarts: [],
    restartTimer: null,
    exhausted: false,
    external: new Map(),
  };
}

function languageOf(languageId: string): ExternalDocumentLanguage {
  return languageId === 'rms' || languageId === 'xs' ? languageId : null;
}

function linesOf(document: MirroredDocument): DocumentLines {
  document.lines ??= new DocumentLines(document.text);
  return document.lines;
}

function configurationKey(folders: readonly string[]): string {
  return JSON.stringify(folders);
}

function isCompletionContext(value: unknown): boolean {
  const context = value as { triggerKind?: unknown; triggerCharacter?: unknown } | null;
  return (
    !!context &&
    typeof context === 'object' &&
    [1, 2, 3].includes(context.triggerKind as number) &&
    (context.triggerCharacter === undefined ||
      (typeof context.triggerCharacter === 'string' && context.triggerCharacter.length <= 4))
  );
}

function isSpawnError(error: unknown): boolean {
  const syscall = (error as { syscall?: unknown } | null)?.syscall;
  return typeof syscall === 'string' && syscall.startsWith('spawn');
}

function detailText(error: unknown, stderr: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return [message, stderr.trim()].filter(Boolean).join('\n').slice(-maximumStderrTail);
}

function withinWait(request: Promise<unknown>, milliseconds: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error('the external language server did not answer in time'), {
            code: 'native.timeout',
          }),
        ),
      milliseconds,
    );
  });
  request.catch(() => undefined);
  return Promise.race([request, expired]).finally(() => clearTimeout(timer));
}

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };
const fulfilled = (value: unknown): Settled => ({ ok: true, value });
const rejected = (error: unknown): Settled => ({ ok: false, error });

function unwrapSettled(result: Settled): unknown {
  if (result.ok) return result.value;
  throw result.error;
}

export function validateHandshake(result: unknown): {
  capabilities: Record<string, unknown>;
  encoding: PositionEncoding;
  serverName: string | null;
  serverVersion: string | null;
} | null {
  const value = result as { capabilities?: unknown; serverInfo?: unknown } | null;
  if (!value || typeof value !== 'object') return null;
  const capabilities = value.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return null;
  const record = capabilities as Record<string, unknown>;
  const sync = record.textDocumentSync;
  const syncKind =
    typeof sync === 'number'
      ? sync
      : sync && typeof sync === 'object'
        ? (sync as { openClose?: unknown }).openClose === true
          ? (sync as { change?: unknown }).change
          : 0
        : 0;
  if (syncKind !== 1 && syncKind !== 2) return null;
  const encoding = record.positionEncoding ?? 'utf-16';
  if (!isPositionEncoding(encoding)) return null;
  const info = value.serverInfo as { name?: unknown; version?: unknown } | null | undefined;
  const text = (field: unknown) =>
    typeof field === 'string' && field.trim() !== '' ? field.trim().slice(0, 128) : null;
  return {
    capabilities: record,
    encoding,
    serverName: text(info?.name),
    serverVersion: text(info?.version),
  };
}
