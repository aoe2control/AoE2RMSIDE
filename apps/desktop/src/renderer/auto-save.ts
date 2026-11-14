export interface AutoSaveCandidate {
  id: string;
  content: string;
  eligible: boolean;
}

export interface AutoSaveDocumentState {
  path: string | null;
  readOnly: boolean;
  dirty: boolean;
  sourceKind: string;
}

export function autoSaveEligible(document: AutoSaveDocumentState): boolean {
  return (
    document.dirty &&
    document.path !== null &&
    !document.readOnly &&
    document.sourceKind !== 'protected'
  );
}

export interface AutoSaveTimers {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
}

interface Entry {
  content: string;
  timer: number | null;
  saving: Promise<void> | null;
  again: boolean;
}

export class AutoSaveScheduler {
  private readonly entries = new Map<string, Entry>();
  private observed = new Map<string, string>();
  private enabled = false;
  private delayMilliseconds = 0;

  constructor(
    private readonly save: (id: string) => Promise<void>,
    private readonly timers: AutoSaveTimers = window,
  ) {}

  update(
    documents: readonly AutoSaveCandidate[],
    settings: { enabled: boolean; delayMilliseconds: number },
  ): void {
    const turnedOn = settings.enabled && !this.enabled;
    this.enabled = settings.enabled;
    this.delayMilliseconds = Math.max(0, settings.delayMilliseconds);
    const seen = new Set<string>();
    for (const document of documents) {
      seen.add(document.id);
      const entry = this.entries.get(document.id);
      if (!this.enabled || !document.eligible) {
        if (entry) this.forget(document.id, entry, document.content);
        continue;
      }
      if (!entry) {
        this.entries.set(document.id, {
          content: document.content,
          timer: null,
          saving: null,
          again: false,
        });
        const previous = this.observed.get(document.id);
        if (!turnedOn && previous !== undefined && previous !== document.content) {
          this.restart(document.id);
        }
        continue;
      }
      if (entry.content === document.content) continue;
      entry.content = document.content;
      this.restart(document.id);
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) this.forget(id, entry, null);
    }
    this.observed = new Map(documents.map((document) => [document.id, document.content]));
  }

  async flush(ids?: readonly string[]): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [id, entry] of this.entries) {
      if (ids && !ids.includes(id)) continue;
      if (entry.timer !== null) {
        this.timers.clearTimeout(entry.timer);
        entry.timer = null;
        pending.push(this.run(id));
      } else if (entry.saving) {
        pending.push(entry.saving);
      }
    }
    await Promise.all(pending);
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) this.timers.clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  pending(id: string): boolean {
    const entry = this.entries.get(id);
    return Boolean(entry && (entry.timer !== null || entry.saving));
  }

  private restart(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer !== null) this.timers.clearTimeout(entry.timer);
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = null;
      if (entry.saving) entry.again = true;
      else void this.run(id);
    }, this.delayMilliseconds);
  }

  private run(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.saving) {
      entry.again = true;
      return entry.saving;
    }
    const saving = (async () => {
      try {
        await this.save(id);
      } finally {
        entry.saving = null;
        if (entry.again && this.entries.get(id) === entry) {
          entry.again = false;
          await this.run(id);
        }
      }
    })();
    entry.saving = saving;
    return saving;
  }

  private forget(id: string, entry: Entry, content: string | null): void {
    if (entry.timer !== null) this.timers.clearTimeout(entry.timer);
    entry.timer = null;
    entry.again = false;
    if (content !== null) entry.content = content;
    if (!entry.saving) this.entries.delete(id);
  }
}

export class SaveQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return result;
  }

  busy(id: string): boolean {
    return this.tails.has(id);
  }
}

export function diskHashForSave(
  documentHash: string,
  latestHash: string | undefined,
  lastOwnWrite: string | undefined,
): string {
  return latestHash !== undefined && latestHash === lastOwnWrite ? latestHash : documentHash;
}

export interface SavedDocumentState {
  content: string;
  savedContent: string;
  dirty: boolean;
  preview: boolean;
  editedThisOpenLifetime: boolean;
}

export function documentAfterSave<Document extends SavedDocumentState>(
  saved: Document,
  latest: Document | undefined,
  startContent: string,
): Document {
  if (!latest || latest.content === startContent) return saved;
  return {
    ...saved,
    content: latest.content,
    dirty: latest.content !== saved.savedContent,
    preview: false,
    editedThisOpenLifetime: true,
  };
}
