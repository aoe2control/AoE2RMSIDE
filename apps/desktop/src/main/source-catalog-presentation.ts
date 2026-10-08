import { outputNote, type OutputMessage } from '../shared/output-message';
import type { MessageId } from '../shared/i18n/translator';
import { SourceCatalogDiscoveryError } from './source-catalog-probes';
import { SourceCatalogBatchError } from './source-catalog-batch';
import { EditorRequestCapacityError } from './editor-inventory-coordinator';
import { FileTooLargeError } from './bounded-file';
import { RequiredSourceLimitError } from './source-catalog-limits';

const budgetLabels = {
  paths: 'file-actions.included-files.budget.paths',
  metadata: 'file-actions.included-files.budget.metadata',
  'directory-visits': 'file-actions.included-files.budget.directory-visits',
  depth: 'file-actions.included-files.budget.depth',
} as const satisfies Record<string, MessageId>;

export function sourceCatalogFailureMessage(error: unknown): OutputMessage | null {
  if (error instanceof RequiredSourceLimitError) {
    const ids = {
      file: 'file-actions.included-files.required-limit.file',
      bytes: 'file-actions.included-files.required-limit.bytes',
      records: 'file-actions.included-files.required-limit.records',
      metadata: 'file-actions.included-files.required-limit.metadata',
    } as const satisfies Record<string, MessageId>;
    return outputNote(
      'Files',
      `source-catalog.required.${error.kind}`,
      { id: 'file-actions.included-files.refresh-failed' },
      {
        severity: 'warning',
        detail: error.message,
        cause: {
          id: ids[error.kind],
          args: {
            limit: error.kind === 'records' ? error.maximum : error.maximum / (1024 * 1024),
            ...(error.kind === 'file' ? { scope: error.scope } : {}),
          },
        },
        action: { text: { id: 'file-actions.included-files.required-limit.reduce' } },
      },
    );
  }
  if (error instanceof SourceCatalogBatchError) {
    const ids = {
      roots: 'file-actions.map-test-sources.limit.maps',
      records: 'file-actions.map-test-sources.limit.records',
      bytes: 'file-actions.map-test-sources.limit.bytes',
      metadata: 'file-actions.map-test-sources.limit.metadata',
    } as const satisfies Record<string, MessageId>;
    return outputNote(
      'Map test',
      `source-catalog.batch.${error.limit}`,
      { id: 'file-actions.map-test-sources.failed' },
      {
        severity: 'warning',
        detail: error.message,
        cause: {
          id: ids[error.limit],
          args: {
            limit:
              error.limit === 'bytes' || error.limit === 'metadata'
                ? error.maximum / (1024 * 1024)
                : error.maximum,
          },
        },
      },
    );
  }
  if (!(error instanceof SourceCatalogDiscoveryError) || error.reason === 'authority') return null;
  return outputNote(
    'Files',
    `source-catalog.${error.reason}`,
    { id: 'file-actions.included-files.refresh-failed' },
    {
      severity: 'warning',
      detail: error.message,
      cause:
        error.reason === 'stale'
          ? { id: 'file-actions.included-files.changed' }
          : {
              id: 'file-actions.included-files.discovery-limit',
              args: {
                budget: { id: budgetLabels[error.reason] },
                scope: error.scope,
                used: error.used,
                maximum: error.maximum,
              },
            },
      ...(error.reason === 'stale'
        ? {}
        : { action: { text: { id: 'file-actions.included-files.discovery-reduce' as const } } }),
    },
  );
}

type EditorWarningKind = 'inventory' | 'diagnostic-queue' | 'generation-context';

export function editorAssistanceFailure(error: unknown, kind: EditorWarningKind): OutputMessage {
  const capacity =
    kind === 'diagnostic-queue' ||
    error instanceof EditorRequestCapacityError ||
    error instanceof RequiredSourceLimitError ||
    error instanceof FileTooLargeError ||
    (error instanceof SourceCatalogDiscoveryError &&
      ['paths', 'metadata', 'directory-visits', 'depth'].includes(error.reason));
  return outputNote(
    'Files',
    `editor-assistance.${kind}`,
    { id: 'editor-assistance.limited.headline' },
    {
      severity: 'warning',
      detail: error instanceof Error ? error.message : String(error),
      cause: {
        id:
          kind === 'diagnostic-queue'
            ? 'editor-assistance.limited.diagnostic-queue'
            : 'editor-assistance.limited.sources',
      },
      action: {
        text: {
          id: capacity ? 'editor-assistance.limited.capacity' : 'editor-assistance.limited.retry',
        },
      },
    },
  );
}

export function requiredSourceLimitReporter(
  publish: (message: OutputMessage) => void,
): (error: unknown, context: string) => boolean {
  let current: string | undefined;
  const reported = new Set<RequiredSourceLimitError['kind']>();
  return (error, context) => {
    if (!(error instanceof RequiredSourceLimitError)) return false;
    if (context !== current) {
      current = context;
      reported.clear();
    }
    if (!reported.has(error.kind)) {
      reported.add(error.kind);
      publish(sourceCatalogFailureMessage(error)!);
    }
    return true;
  };
}

export function catalogRefreshFailureReporter(
  contextEpoch: () => string,
  publish: (error: unknown) => void,
): (error: unknown, capturedContext: string) => void {
  const reported = new WeakSet<object>();
  return (error, capturedContext) => {
    if (error instanceof RequiredSourceLimitError || capturedContext !== contextEpoch()) return;
    if (typeof error === 'object' && error !== null) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    publish(error);
  };
}

export function editorAssistanceReporter(
  contextEpoch: () => string,
  publish: (message: OutputMessage) => void,
): (error: unknown, kind: EditorWarningKind) => void {
  let context: string | undefined;
  const kinds = new Set<EditorWarningKind>();
  return (error, kind) => {
    if ((error as { code?: unknown } | null)?.code === -32801) return;
    const current = contextEpoch();
    if (context !== current) {
      kinds.clear();
      context = current;
    }
    if (kinds.has(kind)) return;
    kinds.add(kind);
    publish(editorAssistanceFailure(error, kind));
  };
}
