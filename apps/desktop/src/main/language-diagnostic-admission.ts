import { createHash } from 'node:crypto';
import { languageCatalogIdentity, type NativeSupervisor } from './native-supervisor';
import type { SourceCatalogService, MainSourceCatalog } from './source-catalog-service';
import type { EditorInventoryCoordinator } from './editor-inventory-coordinator';

interface Dependencies {
  native: Pick<
    NativeSupervisor,
    | 'currentLanguageSourceCatalog'
    | 'invalidateLanguageSourceCatalog'
    | 'languageProcessEpoch'
    | 'languageAnalysisEpoch'
    | 'languageDocument'
    | 'editorInventory'
  >;
  catalogs: Pick<SourceCatalogService, 'validateWitnesses'>;
  editor: Pick<EditorInventoryCoordinator, 'validatePublication'>;
  publish(params: unknown): void;
  warn(error: unknown, kind: 'diagnostic-queue' | 'generation-context'): void;
}
interface Pending {
  value: Record<string, unknown>;
  nativeEpoch: number;
  bytes: number;
}

export class LanguageDiagnosticAdmission {
  private readonly pending = new Map<string, Pending>();
  private retainedBytes = 0;
  private running = false;
  private readonly overflow = new Error(
    'current language diagnostics exceed the bounded publication queue',
  );

  constructor(private readonly dependencies: Dependencies) {}

  enqueue(params: unknown, nativeEpoch: number): void {
    const value = record(params);
    if (
      value &&
      typeof value.uri === 'string' &&
      nativeEpoch === this.dependencies.native.languageProcessEpoch() &&
      !this.dependencies.native.languageDocument(value.uri) &&
      value.version === undefined &&
      Array.isArray(value.diagnostics) &&
      value.diagnostics.length === 0
    ) {
      this.dependencies.publish(value);
      return;
    }
    if (!value || typeof value.uri !== 'string' || !this.headerCurrent(value, nativeEpoch)) return;
    const previous = this.pending.get(value.uri);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (
      bytes > 28 * 1024 * 1024 ||
      this.retainedBytes - (previous?.bytes ?? 0) + bytes > 28 * 1024 * 1024 ||
      (!previous && this.pending.size >= 512)
    ) {
      this.dependencies.warn(this.overflow, 'diagnostic-queue');
      return;
    }
    this.retainedBytes += bytes - (previous?.bytes ?? 0);
    this.pending.set(value.uri, { value, nativeEpoch, bytes });
    if (!this.running) void this.drain();
  }

  async generationAdmission(): Promise<{ validate(): Promise<void>; current(): void }> {
    const nativeEpoch = this.dependencies.native.languageProcessEpoch();
    const reading = this.dependencies.native.currentLanguageSourceCatalog();
    return {
      validate: async () => {
        try {
          await this.validateCatalog(reading, nativeEpoch);
        } catch (error) {
          if (reading === this.dependencies.native.currentLanguageSourceCatalog()) {
            this.dependencies.native.invalidateLanguageSourceCatalog(reading);
            this.dependencies.warn(error, 'generation-context');
          }
          throw stale();
        }
      },
      current: () => {
        if (
          reading !== this.dependencies.native.currentLanguageSourceCatalog() ||
          nativeEpoch !== this.dependencies.native.languageProcessEpoch()
        )
          throw stale();
      },
    };
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending.size) {
        const [uri, pending] = this.pending.entries().next().value!;
        this.pending.delete(uri);
        try {
          const current = await this.admit(pending);
          if (current?.() && !this.pending.has(uri)) this.dependencies.publish(pending.value);
        } catch {
        } finally {
          this.retainedBytes -= pending.bytes;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async admit({ value, nativeEpoch }: Pending): Promise<(() => boolean) | null> {
    if (!this.headerCurrent(value, nativeEpoch)) return null;
    const context = record(value.generationContext);
    if (!context) return null;
    const catalog = this.dependencies.native.currentLanguageSourceCatalog();
    if (!matchesCatalog(context.catalog, catalog)) return null;
    const editorCurrent = await this.dependencies.editor.validatePublication(value.editorContext);
    if (
      !this.headerCurrent(value, nativeEpoch) ||
      !matchesCatalog(context.catalog, this.dependencies.native.currentLanguageSourceCatalog())
    )
      return null;
    try {
      await this.validateCatalog(catalog, nativeEpoch);
    } catch {
      this.dependencies.native.invalidateLanguageSourceCatalog(catalog);
      return null;
    }
    return () => {
      editorCurrent();
      if (
        !this.headerCurrent(value, nativeEpoch) ||
        catalog !== this.dependencies.native.currentLanguageSourceCatalog()
      )
        return false;
      const effective = context.effectiveCatalogHash;
      const overlay = context.entryOverlayHash;
      if (effective === null) return overlay === null;
      if (!catalog || !hash(effective) || !hash(overlay)) return false;
      const document = this.dependencies.native.languageDocument(String(value.uri));
      return (
        !!document && createHash('sha256').update(document.text, 'utf8').digest('hex') === overlay
      );
    };
  }

  private async validateCatalog(
    catalog: MainSourceCatalog | undefined,
    nativeEpoch: number,
  ): Promise<void> {
    const current = () => {
      if (
        nativeEpoch !== this.dependencies.native.languageProcessEpoch() ||
        catalog !== this.dependencies.native.currentLanguageSourceCatalog()
      )
        throw stale();
    };
    current();
    if (catalog) await this.dependencies.catalogs.validateWitnesses(catalog);
    current();
  }

  private headerCurrent(value: Record<string, unknown>, nativeEpoch: number): boolean {
    if (
      nativeEpoch !== this.dependencies.native.languageProcessEpoch() ||
      typeof value.uri !== 'string'
    )
      return false;
    const editor = record(value.editorContext);
    if (!editor || editor.documentEpoch !== this.dependencies.native.languageAnalysisEpoch())
      return false;
    const document = this.dependencies.native.languageDocument(value.uri);
    if (document) return value.version === document.version;
    return (
      value.version === undefined &&
      Array.isArray(value.diagnostics) &&
      value.diagnostics.length === 0
    );
  }
}

function matchesCatalog(value: unknown, catalog: MainSourceCatalog | undefined): boolean {
  if (!catalog) return value === null;
  const identity = record(value);
  if (!identity) return false;
  return Object.entries(languageCatalogIdentity(catalog)).every(
    ([key, expected]) => identity[key] === expected,
  );
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
function stale(): Error {
  return Object.assign(new Error('strict language diagnostic context changed'), { code: -32801 });
}
