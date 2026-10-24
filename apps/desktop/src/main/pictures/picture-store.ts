import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const pictureStoreLimits = Object.freeze({
  maximumFiles: 50,
  maximumBytes: 100 * 1024 * 1024,
  maximumPictureBytes: 2 * 1024 * 1024,
});

export const pictureStoreFolderName = 'pictures';

const pictureFilePattern = /^picture-\d{8}-\d{6}-\d{3}-[0-9a-f]{8}\.png$/u;

export function pictureStoreFolder(userData: string): string {
  if (!isAbsolute(userData)) throw new Error('the user data folder must be an absolute path');
  return join(resolve(userData), pictureStoreFolderName);
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

export function pictureFileName(png: Uint8Array, now: Date): string {
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}-` +
    String(now.getMilliseconds()).padStart(3, '0');
  const hash = createHash('sha256').update(png).digest('hex').slice(0, 8);
  return `picture-${stamp}-${hash}.png`;
}

export interface PictureStore {
  save(png: Uint8Array): Promise<string>;
}

export interface PictureStoreOptions {
  userData: string;
  now?: () => Date;
}

export function createPictureStore(options: PictureStoreOptions): PictureStore {
  const folder = pictureStoreFolder(options.userData);
  const now = options.now ?? (() => new Date());
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const result = chain.then(task, task);
    chain = result.catch(() => undefined);
    return result;
  };
  return {
    save(png) {
      return run(async () => {
        if (!(png instanceof Uint8Array) || png.byteLength === 0) {
          throw new Error('the picture is empty');
        }
        if (png.byteLength > pictureStoreLimits.maximumPictureBytes) {
          throw new Error('the picture is too large to save');
        }
        await mkdir(folder, { recursive: true });
        const name = pictureFileName(png, now());
        const target = join(folder, name);
        if (relative(folder, target).includes('..')) throw new Error('invalid picture path');
        const temporary = `${target}.partial`;
        await writeFile(temporary, png);
        await rename(temporary, target);
        await prunePictureFolder(folder, name);
        return target;
      });
    },
  };
}

export async function prunePictureFolder(folder: string, keep?: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const pictures: { name: string; size: number; time: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pictureFilePattern.test(entry.name)) continue;
    try {
      const info = await stat(join(folder, entry.name));
      pictures.push({ name: entry.name, size: info.size, time: info.mtimeMs });
    } catch {}
  }
  pictures.sort(
    (a, b) =>
      (a.name === keep ? -1 : 0) - (b.name === keep ? -1 : 0) ||
      b.time - a.time ||
      (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
  );
  const removed: string[] = [];
  let total = 0;
  for (const [index, picture] of pictures.entries()) {
    total += picture.size;
    const kept =
      picture.name === keep ||
      (index < pictureStoreLimits.maximumFiles && total <= pictureStoreLimits.maximumBytes);
    if (kept) continue;
    await rm(join(folder, picture.name), { force: true });
    removed.push(picture.name);
  }
  return removed;
}
