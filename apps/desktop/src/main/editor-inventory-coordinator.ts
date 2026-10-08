import { randomUUID } from 'node:crypto';
import type { LanguageServerRequestMethod } from '../shared/api';
import { desktopErrorMessage } from '../shared/desktop-error';
import type { NativeSupervisor } from './native-supervisor';
import type { EditorInventoryWitness, PreparedEditorInventory } from './editor-inventory-service';

const contractVersion = { major: 1, minor: 0, patch: 0 } as const;
const maximumWireBytes = 64 * 1024 * 1024;
const maximumChunkBytes = 4 * 1024 * 1024;
const maximumRequestBytes = 4 * 1024 * 1024;
const maximumRetainedRequestBytes = 16 * 1024 * 1024;

export class EditorRequestCapacityError extends Error {
  constructor(
    readonly budget: 'requests' | 'request-bytes' | 'retained-bytes',
    readonly used: number,
    readonly maximum: number,
  ) {
    super(
      desktopErrorMessage(
        'editor.busy',
        budget === 'requests'
          ? 'too many pending editor requests'
          : `Editor request parameters exceed their ${budget} limit (${used}/${maximum}).`,
      ),
    );
    this.name = 'EditorRequestCapacityError';
  }
}

interface EditorStamp {
  contextId: string;
  inventoryId: string | null;
  documentEpoch: number;
  complete: boolean;
}
interface Ready {
  context: string;
  stamp: EditorStamp;
  witness: EditorInventoryWitness;
}
export interface EditorRequestCapture {
  context: string;
  documentEpoch: string;
  uri: string | undefined;
  version: number | undefined;
}

interface Dependencies {
  native: Pick<
    NativeSupervisor,
    | 'editorInventory'
    | 'editorInventoryChanged'
    | 'languageIdentityEpoch'
    | 'languageProcessEpoch'
    | 'languageAnalysisEpoch'
    | 'languageDocument'
    | 'requestLanguageServer'
  >;
  contextEpoch(): string;
  prepare(assertCurrent: () => void): Promise<PreparedEditorInventory>;
  warn(error: unknown): void;
  generationAdmission(): Promise<{ validate(): Promise<void>; current(): void }>;
}

export class EditorInventoryCoordinator {
  private ready: Ready | undefined;
  private pending: Promise<Ready | undefined> | undefined;
  private invalidation: Promise<void> | undefined;
  private requestedInvalidation: { process: number; id: string } | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshWorker: Promise<void> | undefined;
  private requestedRefresh: (() => Promise<void>) | undefined;
  private disposed = false;
  private sequence = 0;
  private readonly captures = new Map<EditorRequestCapture, { bytes: number; params: unknown }>();
  private retainedRequestBytes = 0;
  private failedContext: string | undefined;
  private nativeContext: { process: number; id: string } | undefined;

  constructor(private readonly dependencies: Dependencies) {}

  capture(params: unknown): EditorRequestCapture {
    if (this.disposed) throw stale();
    const uri = documentUri(params);
    const bytes = Buffer.byteLength(JSON.stringify(params), 'utf8');
    const capacity =
      this.captures.size >= 32
        ? new EditorRequestCapacityError('requests', this.captures.size + 1, 32)
        : bytes > maximumRequestBytes
          ? new EditorRequestCapacityError('request-bytes', bytes, maximumRequestBytes)
          : this.retainedRequestBytes + bytes > maximumRetainedRequestBytes
            ? new EditorRequestCapacityError(
                'retained-bytes',
                this.retainedRequestBytes + bytes,
                maximumRetainedRequestBytes,
              )
            : undefined;
    if (capacity) {
      this.dependencies.warn(capacity);
      throw capacity;
    }
    const captured = {
      context: this.dependencies.contextEpoch(),
      documentEpoch: this.dependencies.native.languageIdentityEpoch(),
      uri,
      version: uri ? this.dependencies.native.languageDocument(uri)?.version : undefined,
    };
    this.captures.set(captured, { bytes, params });
    this.retainedRequestBytes += bytes;
    return captured;
  }

  release(captured: EditorRequestCapture): void {
    const reservation = this.captures.get(captured);
    if (!reservation) return;
    this.captures.delete(captured);
    this.retainedRequestBytes -= reservation.bytes;
  }

  invalidate(): void {
    if (this.disposed) return;
    this.sequence += 1;
    this.ready = undefined;
    this.failedContext = undefined;
    const contextId = randomUUID();
    this.nativeContext = {
      process: this.dependencies.native.languageProcessEpoch(),
      id: contextId,
    };
    this.requestedInvalidation = this.nativeContext;
    this.drainInvalidations();
  }

  private drainInvalidations(): void {
    if (this.invalidation || this.disposed) return;
    this.invalidation = Promise.resolve()
      .then(async () => {
        while (this.requestedInvalidation && !this.disposed) {
          const requested = this.requestedInvalidation;
          this.requestedInvalidation = undefined;
          if (requested.process !== this.dependencies.native.languageProcessEpoch()) continue;
          try {
            const state = stamp(
              await this.dependencies.native.editorInventory({
                contractVersion,
                action: 'invalidate',
                contextId: requested.id,
              }),
            );
            if (!this.disposed && requested === this.nativeContext)
              this.dependencies.native.editorInventoryChanged(state);
          } catch (error) {
            if (!this.requestedInvalidation) throw error;
          }
        }
      })
      .finally(() => {
        this.invalidation = undefined;
        if (this.requestedInvalidation) this.drainInvalidations();
      });
    void this.invalidation.catch(() => {});
  }

  scheduleRefresh(afterDocumentSync: () => Promise<void> = async () => {}): void {
    if (this.disposed) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.failedContext = undefined;
    this.requestedRefresh = afterDocumentSync;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshInBackground();
    }, 100);
    this.refreshTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.sequence += 1;
    this.ready = undefined;
    this.requestedInvalidation = undefined;
    this.requestedRefresh = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.captures.clear();
    this.retainedRequestBytes = 0;
  }

  private refreshInBackground(): void {
    if (this.refreshWorker || this.disposed) return;
    this.refreshWorker = (async () => {
      while (this.requestedRefresh && !this.refreshTimer && !this.disposed) {
        const afterDocumentSync = this.requestedRefresh;
        this.requestedRefresh = undefined;
        try {
          await afterDocumentSync();
          if (!this.disposed) await this.ensure();
        } catch {}
      }
    })().finally(() => {
      this.refreshWorker = undefined;
      if (this.requestedRefresh && !this.refreshTimer) this.refreshInBackground();
    });
  }

  async request(
    method: LanguageServerRequestMethod,
    params: unknown,
    captured = this.capture(params),
  ): Promise<unknown> {
    if (!this.captures.has(captured)) throw stale();
    try {
      if (this.captures.get(captured)!.params !== params) throw stale();
      this.check(captured);
      const ready = await this.ensure();
      this.check(captured);
      if (!ready && (method === 'textDocument/prepareRename' || method === 'textDocument/rename'))
        return null;
      const generation = await this.dependencies.generationAdmission();
      this.check(captured);
      const editor = stamp(
        await this.dependencies.native.editorInventory({ contractVersion, action: 'state' }),
      );
      this.check(captured);
      this.checkState(editor, ready);
      const value = record(params);
      const answer = await this.dependencies.native.requestLanguageServer(method, {
        ...value,
        editorContext: {
          ...editor,
          ...(captured.uri ? { documentVersion: captured.version } : {}),
          factsContract: editorFactsContract,
        },
      });
      const { result, closed } = editorFacts(answer);
      this.check(captured);
      if (closed) {
        await this.validateReady(ready);
        await generation.validate();
        this.check(captured);
      }
      this.checkState(editor, ready);
      generation.current();
      return result;
    } finally {
      this.release(captured);
    }
  }

  async localRequest(
    method: LanguageServerRequestMethod,
    params: unknown,
    captured: EditorRequestCapture,
  ): Promise<unknown> {
    if (!this.captures.has(captured)) throw stale();
    try {
      if (this.captures.get(captured)!.params !== params) throw stale();
      this.check(captured);
      const editor = stamp(
        await this.dependencies.native.editorInventory({ contractVersion, action: 'state' }),
      );
      this.check(captured);
      const result = await this.dependencies.native.requestLanguageServer(method, {
        ...record(params),
        editorContext: { ...editor, documentVersion: captured.version },
      });
      this.check(captured);
      return result;
    } finally {
      this.release(captured);
    }
  }

  async validatePublication(value: unknown): Promise<() => void> {
    const published = stamp(value);
    const ready = this.ready;
    this.checkState(published, ready);
    await this.validateReady(ready);
    this.checkState(published, ready);
    return () => this.checkState(published, ready);
  }

  async navigationWitness(
    sourceId: string,
  ): Promise<{ path: string; witness: EditorInventoryWitness; current: () => void }> {
    const context = this.dependencies.contextEpoch();
    const documentEpoch = this.dependencies.native.languageIdentityEpoch();
    const ready = await this.ensure();
    if (!ready) throw new Error('the editor inventory is unavailable');
    const current = () => {
      if (
        this.ready !== ready ||
        ready.context !== context ||
        context !== this.dependencies.contextEpoch() ||
        documentEpoch !== this.dependencies.native.languageIdentityEpoch()
      )
        throw stale();
    };
    current();
    await this.validateReady(ready);
    current();
    const path = await ready.witness.pathForSource(sourceId);
    current();
    return { path, witness: ready.witness, current };
  }

  private check(captured: EditorRequestCapture): void {
    if (
      this.disposed ||
      captured.context !== this.dependencies.contextEpoch() ||
      captured.documentEpoch !== this.dependencies.native.languageIdentityEpoch() ||
      (captured.uri &&
        (captured.version === undefined ||
          captured.version !== this.dependencies.native.languageDocument(captured.uri)?.version))
    )
      throw stale();
  }

  private checkState(state: EditorStamp, ready: Ready | undefined): void {
    if (this.disposed) throw stale();
    if (state.documentEpoch !== this.dependencies.native.languageAnalysisEpoch()) throw stale();
    if (ready) {
      if (
        this.ready !== ready ||
        ready.context !== this.dependencies.contextEpoch() ||
        !state.complete ||
        state.contextId !== ready.stamp.contextId ||
        state.inventoryId !== ready.stamp.inventoryId
      )
        throw stale();
    } else {
      if (this.ready !== undefined) throw stale();
      const process = this.dependencies.native.languageProcessEpoch();
      const expected =
        this.nativeContext?.process === process ? this.nativeContext.id : `native-start-${process}`;
      if (state.complete || state.inventoryId !== null || state.contextId !== expected)
        throw stale();
    }
  }

  private async validateReady(ready: Ready | undefined): Promise<void> {
    if (!ready) return;
    try {
      if (this.ready !== ready || ready.context !== this.dependencies.contextEpoch()) throw stale();
      await ready.witness.validate();
      if (this.ready !== ready || ready.context !== this.dependencies.contextEpoch()) throw stale();
    } catch (error) {
      if (this.ready === ready) this.invalidate();
      throw error;
    }
  }

  private async ensure(): Promise<Ready | undefined> {
    if (this.disposed) throw stale();
    const context = this.dependencies.contextEpoch();
    if (this.ready) {
      if (this.ready.context === context) return this.ready;
      this.invalidate();
    }
    if (this.failedContext === context) return undefined;
    while (this.pending) {
      await this.pending;
      if (context !== this.dependencies.contextEpoch()) throw stale();
      if (this.ready || this.failedContext === context) return this.ready;
    }
    const sequence = this.sequence;
    const documentEpoch = this.dependencies.native.languageIdentityEpoch();
    const nativeEpoch = this.dependencies.native.languageProcessEpoch();
    const current = () => {
      if (
        this.disposed ||
        sequence !== this.sequence ||
        context !== this.dependencies.contextEpoch() ||
        documentEpoch !== this.dependencies.native.languageIdentityEpoch()
      )
        throw stale();
    };
    const run = async (): Promise<Ready | undefined> => {
      let began = false;
      let committed = false;
      const started = performance.now();
      try {
        while (this.invalidation) await this.invalidation;
        current();
        const prepared = await this.dependencies.prepare(current);
        current();
        const { inventory, witness } = prepared;
        const requestId = randomUUID();
        const envelope = {
          contractVersion,
          requestId,
          contextId: inventory.contextId,
          inventoryId: inventory.inventoryId,
        };
        let wire = 0;
        const call = async (action: string, fields: Record<string, unknown> = {}) => {
          current();
          if (performance.now() - started >= 30_000) throw stale();
          const payload = { ...envelope, action, ...fields };
          wire += Buffer.byteLength(JSON.stringify(payload));
          if (wire > maximumWireBytes) throw new Error('editor inventory transport exceeds 64 MiB');
          const response = record(await this.dependencies.native.editorInventory(payload));
          wire += Buffer.byteLength(JSON.stringify(response));
          current();
          if (wire > maximumWireBytes || performance.now() - started >= 30_000)
            throw new Error('editor inventory transport limit exceeded');
          await new Promise<void>((resolve) => setImmediate(resolve));
          current();
          return response;
        };
        began = true;
        this.nativeContext = { process: nativeEpoch, id: inventory.contextId };
        const begin = await call('begin', {
          roots: inventory.roots,
          caseSensitive: inventory.caseSensitive,
          profileId: inventory.profileId,
          contentIdentity: inventory.contentIdentity,
          implicitDefinitions: inventory.implicitDefinitions,
          sources: inventory.sources.map((source) => ({
            normalizedPath: source.normalizedPath,
            sourceId: source.sourceId,
            rawHash: Buffer.from(source.rawHash).toString('hex'),
            byteLength: source.source.byteLength,
            origin: source.origin,
            role: source.role,
            ...(source.bufferRevision === undefined
              ? {}
              : { bufferRevision: source.bufferRevision }),
          })),
        });
        if (!Array.isArray(begin.requiredSourceIds) || begin.round !== 0)
          throw new Error('invalid editor inventory begin response');
        const requested = new Set<string>();
        const available = new Map(inventory.sources.map((source) => [source.sourceId, source]));
        const required = begin.requiredSourceIds.map((id: unknown) => {
          if (typeof id !== 'string' || requested.has(id) || !available.has(id))
            throw new Error('invalid editor inventory body request');
          requested.add(id);
          return available.get(id)!;
        });
        let round = 0;
        for (let at = 0; at < required.length;) {
          let bytes = 0;
          const batch = [];
          while (
            at < required.length &&
            batch.length < 128 &&
            bytes + required[at]!.source.byteLength <= maximumChunkBytes
          ) {
            const source = required[at++]!;
            bytes += source.source.byteLength;
            batch.push({
              sourceId: source.sourceId,
              sourceBase64: Buffer.from(source.source).toString('base64'),
            });
          }
          if (!batch.length) throw new Error('editor inventory source exceeds its chunk bound');
          const response = await call('append', { round, sources: batch });
          if (response.round !== round + 1) throw new Error('invalid editor inventory round');
          round += 1;
        }
        await witness.validate();
        current();
        const result = stamp(await call('commit', { round, complete: true }));
        if (
          !result.complete ||
          result.contextId !== inventory.contextId ||
          result.inventoryId !== inventory.inventoryId ||
          result.documentEpoch !== this.dependencies.native.languageAnalysisEpoch()
        )
          throw stale();
        committed = true;
        const ready: Ready = { context, stamp: result, witness };
        this.ready = ready;
        this.failedContext = undefined;
        this.dependencies.native.editorInventoryChanged(result);
        return ready;
      } catch (error) {
        if (
          !this.disposed &&
          sequence === this.sequence &&
          context === this.dependencies.contextEpoch() &&
          documentEpoch === this.dependencies.native.languageIdentityEpoch()
        ) {
          this.failedContext = context;
          this.dependencies.warn(error);
        }
        return undefined;
      } finally {
        if (
          !this.disposed &&
          began &&
          !committed &&
          nativeEpoch === this.dependencies.native.languageProcessEpoch()
        ) {
          await this.dependencies.native
            .editorInventory({ contractVersion, action: 'abort' })
            .then((state) => {
              const current = stamp(state);
              if (!this.disposed && sequence === this.sequence) {
                this.nativeContext = { process: nativeEpoch, id: current.contextId };
                this.dependencies.native.editorInventoryChanged(state);
              }
            })
            .catch(() => {});
        }
      }
    };
    this.pending = run().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
}

export const editorFactsContract = 1;

export function editorFacts(answer: unknown): { result: unknown; closed: boolean } {
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    const envelope = answer as { rmsEditorFacts?: unknown; result?: unknown };
    const facts = envelope.rmsEditorFacts as { contract?: unknown; closed?: unknown } | undefined;
    if (facts && typeof facts === 'object' && 'result' in envelope) {
      if (facts.contract !== editorFactsContract || typeof facts.closed !== 'boolean')
        throw new Error('rms-ls answered with an unsupported editor facts contract');
      return { result: envelope.result ?? null, closed: facts.closed };
    }
  }
  return { result: answer, closed: true };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid editor request or response');
  return value as Record<string, unknown>;
}
function stamp(value: unknown): EditorStamp {
  const state = record(value);
  if (
    typeof state.contextId !== 'string' ||
    state.contextId.length > 128 ||
    (state.inventoryId !== null &&
      (typeof state.inventoryId !== 'string' || state.inventoryId.length > 128)) ||
    typeof state.complete !== 'boolean' ||
    !Number.isSafeInteger(state.documentEpoch) ||
    Number(state.documentEpoch) < 0
  )
    throw new Error('invalid editor inventory stamp');
  return state as unknown as EditorStamp;
}
function documentUri(params: unknown): string | undefined {
  const value = record(params).textDocument;
  if (!value) return undefined;
  const uri = record(value).uri;
  if (typeof uri !== 'string' || uri.length < 1 || uri.length > 4096)
    throw new Error('invalid editor document identity');
  return uri;
}
function stale(): Error {
  return Object.assign(new Error('editor document or inventory context changed'), { code: -32801 });
}
