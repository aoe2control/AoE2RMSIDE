import { outputNote, type OutputMessage, type OutputText } from '../shared/output-message';
import { join, resolve } from 'node:path';
import type { ConfigurationCatalog, ContentPackDescriptor } from '../shared/api';

export interface LocalContentSource {
  datPath: string;
  objectReplacementsPath: string;
  definitionsPath: string;
  productVersion: string;
  profileId: string;
}

export type LocalContentImportResult =
  | { status: 'available'; contentPack: ContentPackDescriptor; importMicroseconds: number }
  | {
      status: 'unreadable' | 'unsupported-layout' | 'invalid' | 'unsupported';
      message: string;
    };

export interface LocalContentHost {
  importLocalContent(source: LocalContentSource): Promise<LocalContentImportResult>;
  transient?(error: unknown): boolean;
  fileStamp(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  publish(message: OutputMessage): void;
}

export interface LinkedInstallation {
  installationRoot: string;
  productVersion: string;
}

export const localContentImportDeadlineMilliseconds = 120_000;

export function localContentPaths(installationRoot: string) {
  const common = join(resolve(installationRoot), 'resources', '_common');
  return {
    datPath: join(common, 'dat', 'empires2_x2_p1.dat'),
    objectReplacementsPath: join(common, 'dat', 'objreplacement.json'),
    definitionsPath: join(common, 'drs', 'gamedata_x2', 'random_map.def'),
  };
}

function compareProductVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export class LocalContentService {
  private settled:
    { key: string; source: LocalContentSource; result: LocalContentImportResult } | undefined;
  private inFlight: { key: string; promise: Promise<ContentPackDescriptor | null> } | undefined;

  constructor(
    private readonly host: LocalContentHost,
    private readonly deadlineMilliseconds = localContentImportDeadlineMilliseconds,
  ) {}

  async contentFor(
    installation: LinkedInstallation | null,
    catalog: ConfigurationCatalog,
  ): Promise<ContentPackDescriptor | null> {
    const productVersion = installation?.productVersion ?? '';
    if (!installation || !/^\d{1,10}(?:\.\d{1,10}){1,3}$/u.test(productVersion)) return null;
    if (
      catalog.behaviorProfiles.some((profile) => profile.productVersions.includes(productVersion))
    ) {
      return null;
    }
    const packaged = catalog.contentPacks
      .filter((pack) => pack.packagedBundle && pack.compatibleProfileIds.length > 0)
      .sort((left, right) => compareProductVersions(right.productVersion, left.productVersion))[0];
    const profileId = packaged?.compatibleProfileIds[0];
    if (!packaged || !profileId) return null;
    const source: LocalContentSource = {
      ...localContentPaths(installation.installationRoot),
      productVersion,
      profileId,
    };
    const stamps = await Promise.all(
      [source.datPath, source.objectReplacementsPath, source.definitionsPath].map((path) =>
        this.host.fileStamp(path),
      ),
    );
    const key = JSON.stringify({
      root: resolve(installation.installationRoot).toLocaleLowerCase('en-US'),
      productVersion,
      profileId,
      stamps,
    });
    if (this.settled?.key === key) return availablePack(this.settled.result);
    if (this.inFlight?.key === key) return this.inFlight.promise;
    const promise = this.derive(key, source, packaged).finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = undefined;
    });
    this.inFlight = { key, promise };
    return promise;
  }

  sourceFor(
    contentPack: Pick<ContentPackDescriptor, 'packId' | 'packVersion' | 'contentHash'>,
  ): LocalContentSource | undefined {
    const settled = this.settled;
    if (!settled || settled.result.status !== 'available') return undefined;
    const pack = settled.result.contentPack;
    return pack.packId === contentPack.packId &&
      pack.packVersion === contentPack.packVersion &&
      pack.contentHash === contentPack.contentHash
      ? { ...settled.source }
      : undefined;
  }

  private async derive(
    key: string,
    source: LocalContentSource,
    packaged: ContentPackDescriptor,
  ): Promise<ContentPackDescriptor | null> {
    const label: OutputText = {
      id: 'linked-game.unverified-version',
      args: { version: source.productVersion },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: LocalContentImportResult;
    let transient = false;
    try {
      result = await Promise.race([
        this.host.importLocalContent(source),
        new Promise<LocalContentImportResult>((resolveDeadline) => {
          timer = setTimeout(
            () =>
              resolveDeadline({
                status: 'unreadable',
                message: `reading took longer than ${Math.round(this.deadlineMilliseconds / 1000)} s`,
              }),
            this.deadlineMilliseconds,
          );
        }),
      ]);
    } catch (error) {
      transient = this.host.transient?.(error) ?? false;
      result = {
        status: 'unreadable',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (transient) return null;
    this.settled = { key, source, result };
    if (result.status === 'available') {
      const objects = result.contentPack.objectNames.length;
      this.host.publish(
        outputNote(
          'Game folder',
          'game-folder.content-read',
          { id: 'linked-game.content-read', args: { label } },
          {
            cause:
              result.importMicroseconds === 0
                ? { id: 'linked-game.content-read.cause.loaded', args: { objects } }
                : {
                    id: 'linked-game.content-read.cause.read',
                    args: {
                      objects,
                      milliseconds: Math.max(1, Math.round(result.importMicroseconds / 1000)),
                    },
                  },
          },
        ),
      );
    } else {
      this.host.publish(
        outputNote(
          'Game folder',
          'game-folder.content-unreadable',
          { id: 'linked-game.content-unreadable', args: { label } },
          {
            severity: 'warning',
            cause: {
              id: 'linked-game.content-unreadable.cause',
              args: { version: packaged.productVersion },
            },
            detail: result.message,
          },
        ),
      );
    }
    return availablePack(result);
  }
}

function availablePack(result: LocalContentImportResult): ContentPackDescriptor | null {
  return result.status === 'available' ? result.contentPack : null;
}
