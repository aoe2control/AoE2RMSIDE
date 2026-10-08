import { presentMessage } from '../shared/message-catalog';
import {
  outputNote,
  type OutputMessage,
  type OutputNoteExtra,
  type OutputText,
} from '../shared/output-message';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  isGameArtAssetKey,
  maximumGameArtImageRequestBytes,
  maximumGameArtImageBytes,
  maximumGameArtSpriteObjects,
  validateGameArtSpriteSet,
  validateGameArtTeamColors,
  validateGameArtTerrainIndex,
  type GameArtImage,
  type GameArtPhase,
  type GameArtSpriteRequestObject,
  type GameArtSpriteSet,
  type GameArtStatus,
  type GameArtTeamColors,
  type GameArtTerrainIndex,
} from '../shared/game-art';

export function gameTexturesInstallationIdentity(installationRoot: string): string {
  return createHash('sha256')
    .update('rmside-game-textures-installation-v1\0')
    .update(resolve(installationRoot).toLocaleLowerCase('en-US'))
    .digest('hex')
    .slice(0, 32);
}

export interface GameArtNativeSource {
  installationRoot: string;
  productVersion: string;
  cacheRoot: string;
}

export interface GameArtNativeProgress {
  phase: GameArtPhase;
  completed: number;
  total: number;
}

export interface GameArtNativeResult {
  status:
    'available' | 'unreadable' | 'unsupported-layout' | 'cancelled' | 'invalid' | 'unsupported';
  message: string;
  cacheKey: string;
  converted: number;
  reused: number;
  fallbacks: { asset: string; reason: string }[];
  fallbackCount: number;
  cacheBytes: number;
  elapsedMicroseconds: number;
  evicted: number;
}

export interface GameArtInstallation {
  installationRoot: string;
  productVersion: string;
  hasTerrainArt: boolean;
}

export const gameArtTerrainTextureFolder = [
  'resources',
  '_common',
  'terrain',
  'textures',
  '2x',
] as const;

export interface GameArtHost {
  installation(): Promise<GameArtInstallation | null>;
  prepare(
    requestId: string,
    source: GameArtNativeSource,
    onProgress: (progress: GameArtNativeProgress) => void,
  ): Promise<GameArtNativeResult>;
  sprites(
    requestId: string,
    source: GameArtNativeSource,
    objects: readonly GameArtSpriteRequestObject[],
    onProgress: (progress: GameArtNativeProgress) => void,
  ): Promise<GameArtNativeResult>;
  cancel(requestId: string): Promise<boolean>;
  transient?(error: unknown): boolean;
  readFile(path: string, maximumBytes: number): Promise<Uint8Array | null>;
  publish(message: OutputMessage): void;
  emit(status: GameArtStatus): void;
}

const maximumIndexBytes = 8 * 1024 * 1024;
const maximumSpriteIndexBytes = 16 * 1024 * 1024;
const productVersionPattern = /^\d{1,10}(?:\.\d{1,10}){1,3}$/u;

function installationKey(installation: GameArtInstallation): string {
  return `${resolve(installation.installationRoot).toLocaleLowerCase('en-US')}\0${installation.productVersion}\0${installation.hasTerrainArt}`;
}

interface RawTerrainIndex {
  textureRepeatTiles?: unknown;
  terrains?: unknown;
  blends?: unknown;
  playerColors?: unknown;
}

interface RawSpriteIndex {
  objects?: Record<string, unknown>;
  graphics?: Record<string, unknown>;
}

export class GameArtService {
  private key: string | null = null;
  private installationState: GameArtInstallation | null = null;
  private current: GameArtStatus = { state: 'unlinked' };
  private revision = 0;
  private cacheKey: string | null = null;
  private terrain: GameArtTerrainIndex | null = null;
  private preparing: { requestId: string; promise: Promise<GameArtStatus> } | null = null;
  private activeSprites: string | null = null;
  private readonly spriteRequests = new Map<string, Promise<GameArtSpriteSet | null>>();
  private sequence = 0;
  private compatibleListeners: (() => void)[] = [];
  private readonly allowedKeys = new Set<string>();

  constructor(
    private readonly host: GameArtHost,
    private readonly cacheRoot: string,
  ) {}

  async status(): Promise<GameArtStatus> {
    await this.refreshInstallation();
    return this.current;
  }

  async prepare(onCompatible?: () => void): Promise<GameArtStatus> {
    await this.refreshInstallation();
    const installation = this.installationState;
    if (!installation) return this.current;
    if (this.current.state === 'ready') onCompatible?.();
    if (this.current.state === 'ready' || this.current.state === 'unavailable') return this.current;
    if (onCompatible) this.compatibleListeners.push(onCompatible);
    if (this.preparing) return this.preparing.promise;
    const requestId = `game-art-prepare-${++this.sequence}`;
    const key = this.key;
    const promise = this.runPrepare(requestId, installation, key).finally(() => {
      if (this.preparing?.requestId === requestId) this.preparing = null;
    });
    this.preparing = { requestId, promise };
    return promise;
  }

  relinked(): void {
    if (this.current.state === 'failed') this.setStatus({ state: 'idle' });
  }

  async cancel(): Promise<void> {
    const pending = [this.preparing?.requestId, this.activeSprites].filter(
      (value): value is string => Boolean(value),
    );
    await Promise.all(pending.map((requestId) => this.host.cancel(requestId).catch(() => false)));
  }

  currentSource(): string | null {
    return this.current.state === 'ready' ? this.cacheKey : null;
  }

  async terrainIndex(): Promise<GameArtTerrainIndex | null> {
    await this.refreshInstallation();
    return this.current.state === 'ready' ? this.terrain : null;
  }

  async sprites(objects: readonly GameArtSpriteRequestObject[]): Promise<GameArtSpriteSet | null> {
    await this.refreshInstallation();
    const requested = objects.slice(0, maximumGameArtSpriteObjects);
    const identity = [
      this.key ?? '',
      this.revision,
      requested.map((object) => `${object.civilizationId}:${object.objectId}`).join(','),
    ].join('\0');
    const running = this.spriteRequests.get(identity);
    if (running) return running;
    const promise = this.convertSprites(requested).finally(() => {
      if (this.spriteRequests.get(identity) === promise) this.spriteRequests.delete(identity);
    });
    this.spriteRequests.set(identity, promise);
    return promise;
  }

  private async convertSprites(
    requested: readonly GameArtSpriteRequestObject[],
  ): Promise<GameArtSpriteSet | null> {
    const installation = this.installationState;
    if (this.current.state !== 'ready' || !installation || !this.cacheKey) return null;
    const requestId = `game-art-sprites-${++this.sequence}`;
    const key = this.key;
    this.activeSprites = requestId;
    let result: GameArtNativeResult;
    let transient = false;
    try {
      result = await this.host.sprites(
        requestId,
        this.source(installation),
        requested,
        (progress) => {
          if (this.key !== key || this.current.state !== 'ready' || progress.phase !== 'sprites') {
            return;
          }
          if (progress.total < 1) return;
          this.setStatus({
            ...this.current,
            sprites: { completed: progress.completed, total: progress.total },
          });
        },
      );
    } catch (error) {
      transient = this.host.transient?.(error) ?? false;
      result = failureResult(error);
    } finally {
      if (this.activeSprites === requestId) this.activeSprites = null;
      if (this.key === key && this.current.state === 'ready' && this.current.sprites) {
        const { revision, fallbackCount } = this.current;
        this.setStatus({ state: 'ready', revision, fallbackCount });
      }
    }
    if (this.key !== key) return null;
    if (result.status !== 'available') {
      if (result.status !== 'cancelled' && !transient) {
        this.host.publish(gameTexturesMessage('game-textures.sprites-failed', result.message));
      }
      return null;
    }
    const document = await this.readJson<RawSpriteIndex>('sprites.json', maximumSpriteIndexBytes);
    if (!document) return null;
    const set = selectSprites(document, requested, this.revision, result.fallbackCount);
    if (!set) return null;
    for (const graphic of set.graphics) {
      for (const facing of graphic.facings) {
        this.allowedKeys.add(facing.image);
        if (facing.playerMask) this.allowedKeys.add(facing.playerMask);
      }
    }
    return set;
  }

  async images(keys: readonly string[]): Promise<GameArtImage[]> {
    await this.refreshInstallation();
    const cacheKey = this.cacheKey;
    if (this.current.state !== 'ready' || !cacheKey) return [];
    const images: GameArtImage[] = [];
    let total = 0;
    for (const key of keys) {
      if (!isGameArtAssetKey(key) || !this.allowedKeys.has(key)) continue;
      const bytes = await this.host.readFile(
        this.cachePath(cacheKey, key),
        maximumGameArtImageBytes,
      );
      if (!bytes || !isPng(bytes)) continue;
      if (total + bytes.byteLength > maximumGameArtImageRequestBytes) break;
      total += bytes.byteLength;
      images.push({ key, bytes });
    }
    return images;
  }

  private source(installation: GameArtInstallation): GameArtNativeSource {
    return {
      installationRoot: installation.installationRoot,
      productVersion: installation.productVersion,
      cacheRoot: this.cacheRoot,
    };
  }

  private cachePath(cacheKey: string, name: string): string {
    return join(this.cacheRoot, 'game-art-cache', 'v1', cacheKey, ...name.split('/'));
  }

  private setStatus(status: GameArtStatus): void {
    this.current = status;
    this.host.emit(status);
  }

  private async refreshInstallation(): Promise<void> {
    let installation: GameArtInstallation | null = null;
    try {
      installation = await this.host.installation();
    } catch {
      installation = null;
    }
    const key = installation ? installationKey(installation) : null;
    if (key === this.key) return;
    const running = this.preparing?.requestId;
    if (running) void this.host.cancel(running).catch(() => false);
    this.key = key;
    this.installationState = installation;
    this.cacheKey = null;
    this.terrain = null;
    this.preparing = null;
    this.allowedKeys.clear();
    this.revision += 1;
    if (!installation) {
      this.setStatus({ state: 'unlinked' });
    } else if (!productVersionPattern.test(installation.productVersion)) {
      this.setStatus({
        state: 'unavailable',
        reason: 'the linked game folder does not report a product version',
      });
    } else if (!installation.hasTerrainArt) {
      this.setStatus({
        state: 'unavailable',
        reason: 'the linked game folder has no terrain textures',
      });
    } else {
      this.setStatus({ state: 'idle' });
    }
  }

  private async runPrepare(
    requestId: string,
    installation: GameArtInstallation,
    key: string | null,
  ): Promise<GameArtStatus> {
    this.setStatus({ state: 'preparing', phase: null, completed: 0, total: 0 });
    let result: GameArtNativeResult;
    let transient = false;
    try {
      result = await this.host.prepare(requestId, this.source(installation), (progress) => {
        if (this.key !== key) return;
        this.setStatus({ state: 'preparing', ...progress });
        if (progress.phase !== null && progress.phase !== 'catalog') this.notifyCompatible();
      });
    } catch (error) {
      transient = this.host.transient?.(error) ?? false;
      result = failureResult(error);
    }
    if (result.status === 'available' && this.key === key) this.notifyCompatible();
    this.compatibleListeners = [];
    if (this.key !== key) return this.current;
    if (transient) {
      this.setStatus({ state: 'idle' });
      return this.current;
    }
    switch (result.status) {
      case 'available': {
        this.cacheKey = result.cacheKey;
        const raw = await this.readJson<RawTerrainIndex>('index.json', maximumIndexBytes);
        let index: GameArtTerrainIndex | null = null;
        try {
          index = raw
            ? validateGameArtTerrainIndex({
                ...raw,
                revision: this.revision,
                source: result.cacheKey,
                playerColors: usableTeamColors(raw.playerColors),
              })
            : null;
        } catch {
          index = null;
        }
        if (!index) {
          this.host.publish(gameTexturesMessage('game-textures.index-unreadable'));
          this.setStatus({ state: 'failed', reason: 'the converted terrain index is unreadable' });
          return this.current;
        }
        this.terrain = index;
        for (const terrain of index.terrains) {
          if (terrain.texture) this.allowedKeys.add(terrain.texture);
          if (terrain.overlayMask) this.allowedKeys.add(terrain.overlayMask);
        }
        for (const blend of index.blends) if (blend) this.allowedKeys.add(blend);
        this.host.publish(
          gameTexturesNote(
            'game-textures.terrain-ready',
            {
              id: 'notice.game-textures.terrain-ready',
              args: {
                converted: result.converted,
                reused: result.reused,
                seconds: result.elapsedMicroseconds / 1_000_000,
              },
            },
            {
              cause: {
                id: 'notice.game-textures.terrain-ready.cause',
                args: { megabytes: result.cacheBytes / (1024 * 1024) },
              },
            },
          ),
        );
        if (result.fallbackCount > 0) {
          const example = result.fallbacks[0];
          this.host.publish(
            gameTexturesNote(
              'game-textures.terrain-fallback',
              {
                id: 'notice.game-textures.terrain-fallback',
                args: { count: result.fallbackCount },
              },
              {
                severity: 'warning',
                ...(example
                  ? {
                      cause: {
                        id: 'notice.game-textures.terrain-fallback.cause',
                        args: { asset: example.asset, reason: example.reason },
                      },
                    }
                  : {}),
              },
            ),
          );
        }
        this.setStatus({
          state: 'ready',
          revision: this.revision,
          fallbackCount: result.fallbackCount,
        });
        return this.current;
      }
      case 'cancelled':
        this.host.publish(gameTexturesMessage('game-textures.cancelled'));
        this.setStatus({ state: 'idle' });
        return this.current;
      case 'unsupported-layout':
      case 'unsupported':
        this.host.publish(gameTexturesMessage('game-textures.unavailable', result.message));
        this.setStatus({ state: 'unavailable', reason: result.message });
        return this.current;
      default:
        this.host.publish(gameTexturesMessage('game-textures.failed', result.message));
        this.setStatus({ state: 'failed', reason: result.message });
        return this.current;
    }
  }

  private notifyCompatible(): void {
    const listeners = this.compatibleListeners;
    this.compatibleListeners = [];
    for (const listener of listeners) listener();
  }

  private async readJson<T>(name: string, maximumBytes: number): Promise<T | null> {
    if (!this.cacheKey) return null;
    const bytes = await this.host.readFile(this.cachePath(this.cacheKey, name), maximumBytes);
    if (!bytes) return null;
    try {
      const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
      return typeof value === 'object' && value !== null ? (value as T) : null;
    } catch {
      return null;
    }
  }
}

export function usableTeamColors(value: unknown): GameArtTeamColors | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return validateGameArtTeamColors(value);
  } catch {
    return undefined;
  }
}

function failureResult(error: unknown): GameArtNativeResult {
  return {
    status: 'unreadable',
    message: error instanceof Error ? error.message : String(error),
    cacheKey: '',
    converted: 0,
    reused: 0,
    fallbacks: [],
    fallbackCount: 0,
    cacheBytes: 0,
    elapsedMicroseconds: 0,
    evicted: 0,
  };
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.byteLength > 8 && signature.every((value, index) => bytes[index] === value);
}

export function selectSprites(
  document: RawSpriteIndex,
  requested: readonly GameArtSpriteRequestObject[],
  revision: number,
  fallbackCount: number,
): GameArtSpriteSet | null {
  const objects: unknown[] = [];
  const graphicIds = new Set<number>();
  const seen = new Set<string>();
  const queue = requested.map((request) => ({ ...request, depth: 0 }));
  for (let next = queue.shift(); next; next = queue.shift()) {
    const key = `${next.civilizationId}:${next.objectId}`;
    if (seen.has(key) || seen.size >= maximumGameArtSpriteObjects * 2) continue;
    seen.add(key);
    const entry = document.objects?.[key];
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as {
      table?: unknown;
      parts?: unknown;
      foundationTerrain?: unknown;
      annexes?: unknown;
      invisible?: unknown;
    };
    const parts = Array.isArray(record.parts) ? record.parts : [];
    for (const part of parts) {
      const graphic = (part as { graphic?: unknown })?.graphic;
      if (typeof graphic === 'number') graphicIds.add(graphic);
    }
    const annexes = (Array.isArray(record.annexes) ? record.annexes : []).map((annex) => {
      const value = annex as { object?: unknown; offsetX?: unknown; offsetY?: unknown };
      return { objectId: value?.object, offsetX: value?.offsetX, offsetY: value?.offsetY };
    });
    if (next.depth < 3) {
      for (const annex of annexes) {
        if (typeof annex.objectId === 'number') {
          queue.push({
            objectId: annex.objectId,
            civilizationId: next.civilizationId,
            depth: next.depth + 1,
          });
        }
      }
    }
    objects.push({
      objectId: next.objectId,
      civilizationId: next.civilizationId,
      table: record.table,
      parts,
      foundationTerrain: record.foundationTerrain ?? null,
      annexes,
      invisible: record.invisible === true,
    });
  }
  const graphics: unknown[] = [];
  for (const id of [...graphicIds].sort((left, right) => left - right)) {
    const entry = document.graphics?.[String(id)];
    if (typeof entry !== 'object' || entry === null) continue;
    graphics.push({ id, ...(entry as object) });
  }
  try {
    return validateGameArtSpriteSet({ revision, objects, graphics, fallbackCount });
  } catch {
    return null;
  }
}

function gameTexturesNote(
  code: string,
  headline: OutputText,
  extra: Pick<OutputNoteExtra, 'cause' | 'detail' | 'severity'> = {},
): OutputMessage {
  return outputNote('Game textures', code, headline, extra);
}

function gameTexturesMessage(code: string, raw?: string): OutputMessage {
  return presentMessage({ source: 'Game textures', code, ...(raw ? { raw } : {}) });
}
