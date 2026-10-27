export interface LanguageCatalogWorkerOptions {
  settleMilliseconds: number;
  isOpen(uri: string): boolean;
  build(uri: string, obsolete: () => boolean): Promise<void>;
  failed(uri: string, error: unknown): void;
}

export interface LanguageCatalogWorker {
  schedule(uri: string): Promise<void>;
  current(): Promise<void> | undefined;
}

export function languageCatalogWorker(
  options: LanguageCatalogWorkerOptions,
): LanguageCatalogWorker {
  let requested: { uri: string } | undefined;
  let sequence = 0;
  let worker: Promise<void> | undefined;
  return {
    schedule(uri) {
      requested = { uri };
      sequence += 1;
      worker ??= (async () => {
        while (requested) {
          const requestSequence = sequence;
          await new Promise<void>((resolvePending) =>
            setTimeout(resolvePending, options.settleMilliseconds),
          );
          if (requestSequence !== sequence) continue;
          const next = requested;
          requested = undefined;
          const obsolete = () => requested !== undefined || !options.isOpen(next.uri);
          try {
            await options.build(next.uri, obsolete);
          } catch (error) {
            if (obsolete()) continue;
            options.failed(next.uri, error);
            throw error;
          }
        }
      })().finally(() => {
        worker = undefined;
      });
      return worker;
    },
    current: () => worker,
  };
}
