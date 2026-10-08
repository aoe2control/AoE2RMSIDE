import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export class FileTooLargeError extends Error {
  constructor(
    readonly maximumBytes: number,
    readonly observedBytes = maximumBytes + 1,
  ) {
    super(`file exceeds its bounded size of ${maximumBytes} bytes`);
    this.name = 'FileTooLargeError';
  }
}

export async function readFileBounded(
  path: string,
  maximumBytes: number,
  beforeRead?: (metadata: Stats) => Promise<void>,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('bounded read limit is invalid');
  }
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('path is not a regular file');
    await beforeRead?.(metadata);
    if (metadata.size > maximumBytes) throw new FileTooLargeError(maximumBytes, metadata.size);
    let buffer = Buffer.allocUnsafe(Math.min(metadata.size, maximumBytes) + 1);
    let length = 0;
    for (;;) {
      if (length === buffer.length) {
        if (buffer.length > maximumBytes) throw new FileTooLargeError(maximumBytes, length);
        const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, maximumBytes + 1));
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximumBytes) throw new FileTooLargeError(maximumBytes, length);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export async function hashFileBounded(
  path: string,
  maximumBytes: number,
  beforeRead: (metadata: Stats) => Promise<void>,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new Error('bounded hash limit is invalid');
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('path is not a regular file');
    await beforeRead(metadata);
    if (metadata.size > maximumBytes) throw new FileTooLargeError(maximumBytes, metadata.size);
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
    const hash = createHash('sha256');
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        scratch,
        0,
        Math.min(scratch.length, maximumBytes + 1 - length),
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maximumBytes) throw new FileTooLargeError(maximumBytes, length);
      hash.update(scratch.subarray(0, bytesRead));
    }
    return hash.digest();
  } finally {
    await handle.close();
  }
}

export async function replaceFileAtomically(
  path: string,
  bytes: string | Uint8Array,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.new`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
