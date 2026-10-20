import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileTooLargeError, readFileBounded, replaceFileAtomically } from './bounded-file';
import {
  deleteOwnSnippet,
  mergeImportedSnippets,
  ownSnippetLimits,
  parseSnippetFile,
  saveOwnSnippet,
  serializeSnippetFile,
  type OwnSnippet,
} from '../shared/own-snippets';

export interface OwnSnippetStoreReset {
  backupPath: string | null;
  reason: string;
}

export class OwnSnippetStore {
  readonly path: string;
  private readonly directory: string;
  private pending: Promise<unknown> = Promise.resolve();
  private cache: OwnSnippet[] | null = null;

  constructor(
    userDataPath: string,
    private readonly onReset: (reset: OwnSnippetStoreReset) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.directory = userDataPath;
    this.path = join(userDataPath, 'own-snippets-v1.json');
  }

  list(): Promise<OwnSnippet[]> {
    return this.serialize(async () => [...(await this.read())]);
  }

  save(snippet: OwnSnippet, previousName: string | null): Promise<OwnSnippet[]> {
    return this.change((snippets) => saveOwnSnippet(snippets, snippet, previousName));
  }

  delete(name: string): Promise<OwnSnippet[]> {
    return this.change((snippets) => deleteOwnSnippet(snippets, name));
  }

  import(
    imported: readonly OwnSnippet[],
  ): Promise<{ snippets: OwnSnippet[]; added: string[]; renamed: number }> {
    return this.serialize(async () => {
      const current = await this.read();
      const merged = mergeImportedSnippets(current, imported);
      await this.write(merged);
      const added = merged.slice(current.length).map((snippet) => snippet.name);
      const renamed = added.filter((name, index) => name !== imported[index]?.name).length;
      return { snippets: [...merged], added, renamed };
    });
  }

  private change(update: (snippets: OwnSnippet[]) => OwnSnippet[]): Promise<OwnSnippet[]> {
    return this.serialize(async () => {
      const next = update(await this.read());
      await this.write(next);
      return [...next];
    });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pending.catch(() => undefined).then(work);
    this.pending = run;
    return run;
  }

  private async read(): Promise<OwnSnippet[]> {
    if (this.cache) return this.cache;
    let bytes: Buffer;
    try {
      bytes = await readFileBounded(this.path, ownSnippetLimits.fileBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        this.cache = [];
        return this.cache;
      }
      if (!(error instanceof FileTooLargeError)) throw error;
      return this.reset(error.message);
    }
    try {
      this.cache = parseSnippetFile(bytes);
    } catch (error) {
      return this.reset(error instanceof Error ? error.message : String(error));
    }
    return this.cache;
  }

  private async reset(reason: string): Promise<OwnSnippet[]> {
    const stamp = this.now().toISOString().replace(/[:.]/gu, '-');
    const backupPath = join(this.directory, `own-snippets-v1.invalid-${stamp}.json`);
    let kept: string | null = backupPath;
    try {
      await copyFile(this.path, backupPath);
    } catch {
      kept = null;
    }
    if (kept) await this.write([]).catch(() => undefined);
    this.cache = [];
    this.onReset({ backupPath: kept, reason });
    return this.cache;
  }

  private async write(snippets: OwnSnippet[]): Promise<void> {
    await replaceFileAtomically(this.path, serializeSnippetFile(snippets));
    this.cache = snippets;
  }
}
