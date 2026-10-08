import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileBounded } from './bounded-file';
import { decodeSourceBytes } from './source-codec';

export interface XsEnvironmentPayload {
  constants: { uri: string; text: string } | null;
  gameBuild: XsGameBuild | null;
}

export type XsGameBuild = '4x' | '5x';

export interface XsEnvironmentState {
  payload: XsEnvironmentPayload;
  constantsPath: string | null;
}

export const xsConstantsRelativePath = ['resources', '_common', 'xs', 'Constants.xs'] as const;
export const maximumXsConstantsBytes = 16 * 1024 * 1024;

export function xsGameBuildForProfile(profileId: string | null | undefined): XsGameBuild | null {
  if (typeof profileId !== 'string') return null;
  if (profileId.includes('101.103.54800')) return '5x';
  if (profileId.includes('101.103.48987')) return '4x';
  return null;
}

export interface XsEnvironmentReader {
  probe(path: string): Promise<{ size: number; modified: number } | null>;
  read(path: string): Promise<Uint8Array>;
}

export const nodeXsEnvironmentReader: XsEnvironmentReader = {
  probe: async (path) => {
    try {
      const metadata = await stat(path);
      return metadata.isFile() ? { size: metadata.size, modified: metadata.mtimeMs } : null;
    } catch {
      return null;
    }
  },
  read: (path) => readFileBounded(path, maximumXsConstantsBytes),
};

export class XsEnvironmentSource {
  private cache: { key: string; text: string } | null = null;

  constructor(private readonly reader: XsEnvironmentReader = nodeXsEnvironmentReader) {}

  async current(
    installationRoot: string | null,
    profileId: string | null | undefined,
  ): Promise<XsEnvironmentState> {
    const gameBuild = xsGameBuildForProfile(profileId);
    if (!installationRoot) {
      return { payload: { constants: null, gameBuild }, constantsPath: null };
    }
    const path = join(resolve(installationRoot), ...xsConstantsRelativePath);
    const probe = await this.reader.probe(path);
    if (!probe || probe.size > maximumXsConstantsBytes) {
      return { payload: { constants: null, gameBuild }, constantsPath: null };
    }
    const key = `${path.toLocaleLowerCase('en-US')}\u0000${probe.size}\u0000${probe.modified}`;
    let text: string;
    if (this.cache?.key === key) {
      text = this.cache.text;
    } else {
      try {
        text = decodeSourceBytes(await this.reader.read(path)).content;
      } catch {
        return { payload: { constants: null, gameBuild }, constantsPath: null };
      }
      this.cache = { key, text };
    }
    return {
      payload: { constants: { uri: pathToFileURL(path).href, text }, gameBuild },
      constantsPath: path,
    };
  }
}

export function sameXsEnvironment(
  left: XsEnvironmentPayload | null,
  right: XsEnvironmentPayload,
): boolean {
  return (
    left !== null &&
    left.gameBuild === right.gameBuild &&
    left.constants?.uri === right.constants?.uri &&
    left.constants?.text === right.constants?.text
  );
}
