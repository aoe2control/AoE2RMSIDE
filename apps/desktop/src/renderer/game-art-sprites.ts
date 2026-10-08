import {
  CanvasSource,
  Container,
  GlProgram,
  ImageSource,
  Mesh,
  MeshGeometry,
  Shader,
  Sprite,
  Texture,
} from 'pixi.js';
import type { CliffPieceRecord, GameArtSpriteFacing, GameArtSpriteSet } from '../shared/game-art';
import { spriteDrawOrder, spriteFacing } from './game-art-blend';
import { gameArtMaximumSpriteBytes, type GameArtAssetStore } from './game-art-resources';
import {
  buildSpriteAtlas,
  type SpriteAtlas,
  type SpriteAtlasCanvasFactory,
  type SpriteAtlasEntry,
  type SpriteAtlasFallbackReason,
} from './game-art-sprite-atlas';
import { requestPreviewRender } from './preview-render-scheduler';
import {
  teamColorGlsl,
  teamColorKey,
  teamColorPixels,
  type TeamColor,
} from './game-art-team-colors';
import { spritePartPlacement } from './game-art-small-trees';
import { hasWallFrames, isGateObject, wallFacingIndex, wallFramesFor } from './game-art-walls';
import { isDecorationPreviewObject } from './preview-materials';
import { previewChunkSize, type TopDownObject } from './top-down-preview';

export const spriteUnitsPerPixelX = 2 / 96;
export const spriteUnitsPerPixelY = 4 / 96;

export interface SpritePart {
  graphic: number;
  facing: number;
  offsetX: number;
  offsetY: number;
  mapOffsetX: number;
  mapOffsetY: number;
}

export interface SpriteInstance {
  objectIndex: number;
  x: number;
  y: number;
  owner: number;
  parts: SpritePart[];
  decoration?: boolean;
  tree?: boolean;
}

export interface CliffSpriteInstance {
  pieceIndex: number;
  x: number;
  y: number;
  parts: SpritePart[];
}

export interface SpritePlan {
  instances: SpriteInstance[];
  glyphObjects: Set<number>;
  invisibleObjects: Set<number>;
  cliffs: CliffSpriteInstance[];
  cliffLines: Set<number>;
  chosen: Map<number, Set<number>>;
}

export const cliffCivilizationId = 0;

export interface SpritePlanOptions {
  treeObjectIds?: ReadonlySet<number>;
}

export function planSprites(
  objects: readonly TopDownObject[],
  drawn: (object: TopDownObject) => boolean,
  set: GameArtSpriteSet,
  seed: number,
  civilizationFor: (owner: number) => number,
  cliffPieces: readonly CliffPieceRecord[] = [],
  options: SpritePlanOptions = {},
): SpritePlan {
  const wallFrames = wallFramesFor(objects, drawn);
  const objectArt = new Map(
    set.objects.map((entry) => [`${entry.civilizationId}:${entry.objectId}`, entry]),
  );
  const graphics = new Map(set.graphics.map((graphic) => [graphic.id, graphic]));
  const plan: SpritePlan = {
    instances: [],
    glyphObjects: new Set(),
    invisibleObjects: new Set(),
    cliffs: [],
    cliffLines: new Set(),
    chosen: new Map(),
  };
  const choose = (graphic: number, facing: number) => {
    let facings = plan.chosen.get(graphic);
    if (!facings) {
      facings = new Set();
      plan.chosen.set(graphic, facings);
    }
    facings.add(facing);
  };
  for (const object of objects) {
    if (!drawn(object)) continue;
    const civilization = civilizationFor(object.owner);
    if (objectArt.get(`${civilization}:${object.objectId}`)?.invisible) {
      plan.invisibleObjects.add(object.index);
      continue;
    }
    const parts: SpritePart[] = [];
    const addParts = (objectId: number, mapOffsetX: number, mapOffsetY: number, depth: number) => {
      const art = objectArt.get(`${civilization}:${objectId}`);
      const wallFrame = depth === 0 ? wallFrames.get(object.index) : undefined;
      const joined =
        wallFrame !== undefined && hasWallFrames(graphics.get(art?.parts[0]?.graphic ?? -1));
      for (const part of art?.parts ?? []) {
        const graphic = graphics.get(part.graphic);
        if (!graphic) continue;
        let facing: number;
        if (joined) {
          const index = wallFacingIndex(graphic, wallFrame!);
          if (index === null) continue;
          facing = index;
        } else {
          facing = isGateObject(objectId)
            ? 0
            : spriteFacing(seed, object.index, objectId, graphic.facings.length);
        }
        parts.push({
          graphic: part.graphic,
          facing,
          offsetX: part.offsetX,
          offsetY: part.offsetY,
          mapOffsetX,
          mapOffsetY,
        });
        choose(part.graphic, facing);
      }
      if (depth >= 3) return;
      for (const annex of art?.annexes ?? []) {
        addParts(annex.objectId, mapOffsetX + annex.offsetX, mapOffsetY + annex.offsetY, depth + 1);
      }
    };
    addParts(object.objectId, 0, 0, 0);
    const decoration = isDecorationPreviewObject(object);
    if (parts.length === 0) {
      if (!decoration) plan.glyphObjects.add(object.index);
      continue;
    }
    plan.instances.push({
      objectIndex: object.index,
      x: object.x,
      y: object.y,
      owner: object.owner,
      parts,
      ...(decoration ? { decoration } : {}),
      ...(object.appearance === 'tree' || options.treeObjectIds?.has(object.objectId)
        ? { tree: true }
        : {}),
    });
  }
  for (const [pieceIndex, piece] of cliffPieces.entries()) {
    const art = objectArt.get(`${cliffCivilizationId}:${piece.objectId}`);
    const parts: SpritePart[] = [];
    for (const part of art?.parts ?? []) {
      const graphic = graphics.get(part.graphic);
      if (!graphic || piece.facet >= graphic.facings.length) continue;
      parts.push({
        graphic: part.graphic,
        facing: piece.facet,
        offsetX: part.offsetX,
        offsetY: part.offsetY,
        mapOffsetX: 0,
        mapOffsetY: 0,
      });
      choose(part.graphic, piece.facet);
    }
    if (parts.length === 0) plan.cliffLines.add(pieceIndex);
    else plan.cliffs.push({ pieceIndex, x: piece.x, y: piece.y, parts });
  }
  return plan;
}

export function spriteRequestObjects(
  objects: readonly TopDownObject[],
  drawn: (object: TopDownObject) => boolean,
  civilizationFor: (owner: number) => number,
  limit: number,
  cliffPieces: readonly CliffPieceRecord[] = [],
): { objectId: number; civilizationId: number }[] {
  const seen = new Map<string, { objectId: number; civilizationId: number }>();
  const add = (objectId: number, civilizationId: number) => {
    const key = `${civilizationId}:${objectId}`;
    if (!seen.has(key) && seen.size < limit) seen.set(key, { objectId, civilizationId });
  };
  for (const object of objects) {
    if (seen.size >= limit) break;
    if (drawn(object)) add(object.objectId, civilizationFor(object.owner));
  }
  for (const piece of cliffPieces) add(piece.objectId, cliffCivilizationId);
  return [...seen.values()];
}

export function budgetedSpriteFacings(
  plan: SpritePlan,
  set: GameArtSpriteSet,
  budgetBytes: number,
): Map<number, Set<number>> {
  const uses = new Map<string, number>();
  for (const instance of [...plan.instances, ...plan.cliffs]) {
    for (const part of instance.parts) {
      const key = `${part.graphic}:${part.facing}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const graphics = new Map(set.graphics.map((graphic) => [graphic.id, graphic]));
  const candidates: { graphic: number; facing: number; uses: number; bytes: number }[] = [];
  for (const [graphic, facings] of plan.chosen) {
    for (const facing of facings) {
      const entry = graphics.get(graphic)?.facings[facing];
      if (!entry) continue;
      const pixels = entry.width * entry.height * 4;
      candidates.push({
        graphic,
        facing,
        uses: uses.get(`${graphic}:${facing}`) ?? 0,
        bytes: entry.playerMask ? pixels * 3 : pixels,
      });
    }
  }
  candidates.sort(
    (left, right) =>
      right.uses - left.uses || left.graphic - right.graphic || left.facing - right.facing,
  );
  const chosen = new Map<number, Set<number>>();
  let total = 0;
  for (const candidate of candidates) {
    if (total + candidate.bytes > budgetBytes) continue;
    total += candidate.bytes;
    let facings = chosen.get(candidate.graphic);
    if (!facings) {
      facings = new Set();
      chosen.set(candidate.graphic, facings);
    }
    facings.add(candidate.facing);
  }
  return chosen;
}

function teamColorImage(
  main: CanvasImageSource,
  mask: CanvasImageSource,
  width: number,
  height: number,
  team: TeamColor,
): ImageData {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(main, 0, 0, width, height);
  const color = context.getImageData(0, 0, width, height);
  context.clearRect(0, 0, width, height);
  context.drawImage(mask, 0, 0, width, height);
  const strength = context.getImageData(0, 0, width, height);
  color.data.set(teamColorPixels(color.data, strength.data, team));
  return color;
}

function teamColorOverlay(
  main: CanvasImageSource,
  mask: CanvasImageSource,
  width: number,
  height: number,
  team: TeamColor,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(teamColorImage(main, mask, width, height, team), 0, 0);
  return canvas;
}

export const playerColorSpriteVertex = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUV;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}
`;

export const playerColorSpriteFragment = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uMain;
uniform sampler2D uMask;
uniform vec4 uColor;
uniform vec4 uTeam;
out vec4 finalColor;
${teamColorGlsl}
void main() {
  vec4 main = texture(uMain, vUV);
  float mask = texture(uMask, vUV).r;
  if (mask <= 0.0 || main.a <= 0.0) discard;
  vec3 shown = clamp(teamColored(main.rgb / main.a, mask, uTeam.rgb, uTeam.a), 0.0, 1.0);
  float alpha = main.a * uColor.a;
  finalColor = vec4(shown * alpha, alpha);
}
`;

let playerColorProgram: GlProgram | null = null;

function playerColorSpriteProgram(): GlProgram {
  playerColorProgram ??= GlProgram.from({
    name: 'rmside-player-colour',
    vertex: playerColorSpriteVertex,
    fragment: playerColorSpriteFragment,
    preferredFragmentPrecision: 'highp',
  });
  return playerColorProgram;
}

export interface GameArtSpriteStatistics {
  instances: number;
  createdSprites: number;
  overlayBytes: number;
  atlasPages: number;
  atlasBytes: number;
  atlasFallback: SpriteAtlasFallbackReason | 'disabled' | null;
  visibilityWrites: number;
  glyphObjects: number;
  invisibleObjects: number;
  cliffSprites: number;
  cliffLines: number;
}

export interface SpriteKindVisibility {
  objects: boolean;
  cliffs: boolean;
}

type ChunkEntry =
  { kind: 'object'; instance: SpriteInstance } | { kind: 'cliff'; instance: CliffSpriteInstance };

export const cliffSortLayer = 20;

export function spriteChunkKey(x: number, y: number): string {
  return `${Math.floor(x / previewChunkSize) * previewChunkSize}:${Math.floor(y / previewChunkSize) * previewChunkSize}`;
}

export function spriteChunkKeys(
  visible: Iterable<{ minimumX: number; minimumY: number }>,
): Set<string> {
  const keys = new Set<string>();
  for (const chunk of visible) {
    for (const [dx, dy] of [
      [0, 0],
      [0, 1],
      [-1, 0],
      [-1, 1],
    ] as const) {
      keys.add(
        `${chunk.minimumX + dx * previewChunkSize}:${chunk.minimumY + dy * previewChunkSize}`,
      );
    }
  }
  return keys;
}

export interface GameArtSpriteLayerOptions {
  maximumTextureSize?: number;
  createAtlasCanvas?: SpriteAtlasCanvasFactory;
  atlas?: boolean;
}

function tintedCopies(
  plan: SpritePlan,
  hasMask: (key: string) => boolean,
  teamColor: (owner: number) => TeamColor | null,
): Map<string, { key: string; team: TeamColor }> {
  const copies = new Map<string, { key: string; team: TeamColor }>();
  const add = (parts: readonly SpritePart[], owner: number) => {
    const team = teamColor(owner);
    if (!team) return;
    for (const part of parts) {
      const key = `${part.graphic}:${part.facing}`;
      if (!hasMask(key)) continue;
      const overlayKey = `${key}|${teamColorKey(team)}`;
      if (!copies.has(overlayKey)) copies.set(overlayKey, { key, team });
    }
  };
  for (const instance of plan.instances) add(instance.parts, instance.owner);
  for (const cliff of plan.cliffs) add(cliff.parts, 0);
  return copies;
}

export class GameArtSpriteLayer {
  readonly container = new Container({
    label: 'game-textures-objects',
    sortableChildren: true,
    isRenderGroup: true,
  });
  private atlas: SpriteAtlas | null = null;
  private readonly textures = new Map<
    string,
    {
      main: Texture;
      image: CanvasImageSource;
      mask: CanvasImageSource | null;
      facing: GameArtSpriteFacing;
    }
  >();
  private readonly overlays = new Map<string, Texture | Shader>();
  private readonly overlayGeometries = new Map<string, MeshGeometry>();
  private readonly maskSources = new Map<string, ImageSource>();
  private readonly byChunk = new Map<string, ChunkEntry[]>();
  private readonly built = new Map<string, { sprite: Container; kind: ChunkEntry['kind'] }[]>();
  private readonly drawn = new Set<number>();
  private readonly handled = new Set<number>();
  private readonly drawnCliffs = new Set<number>();
  private visibleKeys = new Set<string>();
  private kinds: SpriteKindVisibility = { objects: true, cliffs: true };
  private treeScale = 1;
  private readonly treeSprites: {
    sprite: Container;
    anchorX: number;
    anchorY: number;
    offsetX: number;
    offsetY: number;
  }[] = [];
  private readonly layers: Map<number, number>;
  readonly statistics: GameArtSpriteStatistics;

  constructor(
    plan: SpritePlan,
    set: GameArtSpriteSet,
    store: GameArtAssetStore,
    private readonly teamColor: (owner: number) => TeamColor | null,
    readonly gpu = false,
    options: GameArtSpriteLayerOptions = {},
  ) {
    this.container.eventMode = 'none';
    this.container.zIndex = 2;
    const graphics = new Map(set.graphics.map((graphic) => [graphic.id, graphic]));
    this.layers = new Map(set.graphics.map((graphic) => [graphic.id, graphic.layer]));
    const loaded: {
      key: string;
      image: CanvasImageSource;
      mask: CanvasImageSource | null;
      facing: GameArtSpriteFacing;
    }[] = [];
    for (const [graphicId, facings] of plan.chosen) {
      const graphic = graphics.get(graphicId);
      if (!graphic) continue;
      for (const index of facings) {
        const facing = graphic.facings[index];
        if (!facing) continue;
        const main = store.get(facing.image);
        if (!main) continue;
        const mask = facing.playerMask ? store.get(facing.playerMask) : undefined;
        loaded.push({
          key: `${graphicId}:${index}`,
          image: main.image,
          mask: mask?.image ?? null,
          facing,
        });
      }
    }
    let overlayBytes = 0;
    let atlasFallback: GameArtSpriteStatistics['atlasFallback'] = 'disabled';
    if (options.atlas !== false) {
      const masked = new Map(loaded.map((entry) => [entry.key, entry]));
      const copies = tintedCopies(plan, (key) => Boolean(masked.get(key)?.mask), teamColor);
      const entries: SpriteAtlasEntry[] = loaded.map((entry) => ({
        key: entry.key,
        width: entry.facing.width,
        height: entry.facing.height,
        draw: (context, x, y) =>
          context.drawImage(entry.image, x, y, entry.facing.width, entry.facing.height),
      }));
      for (const [overlayKey, copy] of copies) {
        const entry = masked.get(copy.key)!;
        const { width, height } = entry.facing;
        entries.push({
          key: overlayKey,
          width,
          height,
          draw: (context, x, y) =>
            context.putImageData(
              teamColorImage(entry.image, entry.mask!, width, height, copy.team),
              x,
              y,
            ),
        });
        overlayBytes += width * height * 4;
      }
      const built = buildSpriteAtlas(entries, {
        maximumBytes: gameArtMaximumSpriteBytes,
        ...(options.maximumTextureSize ? { maximumTextureSize: options.maximumTextureSize } : {}),
        ...(options.createAtlasCanvas ? { createCanvas: options.createAtlasCanvas } : {}),
      });
      if ('atlas' in built) {
        this.atlas = built.atlas;
        atlasFallback = null;
        for (const overlayKey of copies.keys()) {
          this.overlays.set(overlayKey, built.atlas.texture(overlayKey)!);
        }
      } else {
        atlasFallback = built.fallback;
        overlayBytes = 0;
      }
    }
    for (const entry of loaded) {
      this.textures.set(entry.key, {
        main:
          this.atlas?.texture(entry.key) ??
          new Texture({
            source: new ImageSource({ resource: entry.image as ImageBitmap, scaleMode: 'linear' }),
          }),
        image: entry.image,
        mask: entry.mask,
        facing: entry.facing,
      });
    }
    const file = (entry: ChunkEntry) => {
      const key = spriteChunkKey(entry.instance.x, entry.instance.y);
      const list = this.byChunk.get(key);
      if (list) list.push(entry);
      else this.byChunk.set(key, [entry]);
    };
    for (const instance of plan.instances) {
      if (!this.hasTexture(instance)) continue;
      this.drawn.add(instance.objectIndex);
      file({ kind: 'object', instance });
    }
    for (const instance of plan.cliffs) {
      if (!this.hasTexture(instance)) continue;
      this.drawnCliffs.add(instance.pieceIndex);
      file({ kind: 'cliff', instance });
    }
    for (const index of this.drawn) this.handled.add(index);
    for (const index of plan.invisibleObjects) this.handled.add(index);
    this.statistics = {
      instances: plan.instances.length,
      createdSprites: 0,
      overlayBytes,
      atlasPages: this.atlas?.pageCount ?? 0,
      atlasBytes: this.atlas?.bytes ?? 0,
      atlasFallback,
      visibilityWrites: 0,
      glyphObjects:
        plan.glyphObjects.size +
        plan.instances.filter(
          (instance) => !instance.decoration && !this.drawn.has(instance.objectIndex),
        ).length,
      invisibleObjects: plan.invisibleObjects.size,
      cliffSprites: this.drawnCliffs.size,
      cliffLines: plan.cliffLines.size + plan.cliffs.length - this.drawnCliffs.size,
    };
  }

  hasTexture(instance: { parts: readonly SpritePart[] }): boolean {
    return instance.parts.some((part) => this.textures.has(`${part.graphic}:${part.facing}`));
  }

  get drawnObjects(): ReadonlySet<number> {
    return this.drawn;
  }

  get presentedObjects(): ReadonlySet<number> {
    return this.handled;
  }

  get drawnCliffPieces(): ReadonlySet<number> {
    return this.drawnCliffs;
  }

  setKindVisibility(kinds: SpriteKindVisibility): void {
    if (kinds.objects === this.kinds.objects && kinds.cliffs === this.kinds.cliffs) return;
    this.kinds = { ...kinds };
    this.applyVisibility();
    requestPreviewRender(this.container);
  }

  get atlasActive(): boolean {
    return this.atlas !== null;
  }

  get textureSourceCount(): number {
    const sources = new Set<unknown>();
    for (const entry of this.textures.values()) sources.add(entry.main.source);
    for (const overlay of this.overlays.values()) {
      if (overlay instanceof Texture) sources.add(overlay.source);
    }
    return sources.size;
  }

  get treeSpriteScale(): number {
    return this.treeScale;
  }

  get treeSpriteCount(): number {
    return this.treeSprites.length;
  }

  setTreeScale(factor: number): void {
    if (factor === this.treeScale) return;
    this.treeScale = factor;
    for (const entry of this.treeSprites) {
      const placement = spritePartPlacement(
        entry.anchorX,
        entry.anchorY,
        entry.offsetX,
        entry.offsetY,
        spriteUnitsPerPixelX,
        spriteUnitsPerPixelY,
        factor,
      );
      entry.sprite.position.set(placement.x, placement.y);
      entry.sprite.scale.set(placement.scaleX, placement.scaleY);
    }
    requestPreviewRender(this.container);
  }

  private applyVisibility(): void {
    for (const [key, sprites] of this.built) this.showChunk(sprites, this.visibleKeys.has(key));
  }

  private showChunk(
    sprites: readonly { sprite: Container; kind: ChunkEntry['kind'] }[],
    visible: boolean,
  ): void {
    for (const { sprite, kind } of sprites) {
      sprite.visible = visible && (kind === 'cliff' ? this.kinds.cliffs : this.kinds.objects);
    }
    this.statistics.visibilityWrites += sprites.length;
  }

  private buildChunk(key: string): { sprite: Container; kind: ChunkEntry['kind'] }[] {
    const sprites: { sprite: Container; kind: ChunkEntry['kind'] }[] = [];
    for (const entry of this.byChunk.get(key) ?? []) {
      const layer = entry.kind === 'cliff' ? cliffSortLayer : undefined;
      const owner = entry.kind === 'object' ? entry.instance.owner : 0;
      const tree = entry.kind === 'object' && entry.instance.tree === true;
      for (const sprite of this.spritesFor(entry.instance, owner, layer, tree)) {
        sprites.push({ sprite, kind: entry.kind });
      }
    }
    this.built.set(key, sprites);
    if (sprites.length > 0) this.container.addChild(...sprites.map(({ sprite }) => sprite));
    this.statistics.createdSprites += sprites.length;
    return sprites;
  }

  update(visibleChunks: Iterable<{ minimumX: number; minimumY: number }>): void {
    const visibleChunkKeys = spriteChunkKeys(visibleChunks);
    let changed = false;
    for (const key of visibleChunkKeys) {
      if (this.visibleKeys.has(key)) continue;
      const sprites = this.built.get(key) ?? this.buildChunk(key);
      if (sprites.length === 0) continue;
      this.showChunk(sprites, true);
      changed = true;
    }
    for (const key of this.visibleKeys) {
      if (visibleChunkKeys.has(key)) continue;
      const sprites = this.built.get(key);
      if (!sprites || sprites.length === 0) continue;
      this.showChunk(sprites, false);
      changed = true;
    }
    this.visibleKeys = visibleChunkKeys;
    if (changed) requestPreviewRender(this.container);
  }

  private overlay(key: string, team: TeamColor): Texture | Shader | null {
    const entry = this.textures.get(key);
    if (!entry?.mask) return null;
    const overlayKey = `${key}|${teamColorKey(team)}`;
    const existing = this.overlays.get(overlayKey);
    if (existing) return existing;
    let overlay: Texture | Shader;
    if (this.gpu && !this.atlas) {
      let maskSource = this.maskSources.get(key);
      if (!maskSource) {
        maskSource = new ImageSource({
          resource: entry.mask as ImageBitmap,
          scaleMode: 'linear',
        });
        this.maskSources.set(key, maskSource);
      }
      overlay = new Shader({
        glProgram: playerColorSpriteProgram(),
        resources: {
          uMain: entry.main.source,
          uMask: maskSource,
          playerColorUniforms: {
            uTeam: { value: [team.red, team.green, team.blue, team.pivot], type: 'vec4<f32>' },
          },
        },
      });
    } else {
      const { width, height } = entry.facing;
      overlay = new Texture({
        source: new CanvasSource({
          resource: teamColorOverlay(entry.image, entry.mask, width, height, team),
          scaleMode: 'linear',
        }),
      });
      this.statistics.overlayBytes += width * height * 4;
    }
    this.overlays.set(overlayKey, overlay);
    return overlay;
  }

  private overlayGeometry(key: string, facing: GameArtSpriteFacing): MeshGeometry {
    let geometry = this.overlayGeometries.get(key);
    if (!geometry) {
      const left = -facing.anchorX;
      const top = -facing.anchorY;
      const right = facing.width - facing.anchorX;
      const bottom = facing.height - facing.anchorY;
      geometry = new MeshGeometry({
        positions: new Float32Array([left, top, right, top, right, bottom, left, bottom]),
        uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      });
      this.overlayGeometries.set(key, geometry);
    }
    return geometry;
  }

  private spritesFor(
    instance: { x: number; y: number; parts: readonly SpritePart[] },
    owner: number,
    sortLayer: number | undefined,
    tree = false,
  ): Container[] {
    const sprites: Container[] = [];
    const team = this.teamColor(owner);
    const factor = tree ? this.treeScale : 1;
    for (const [partIndex, part] of instance.parts.entries()) {
      const key = `${part.graphic}:${part.facing}`;
      const entry = this.textures.get(key);
      if (!entry) continue;
      const x = instance.x + part.mapOffsetX;
      const y = instance.y + part.mapOffsetY;
      const anchorX = x + y;
      const anchorY = y - x;
      const layer = sortLayer ?? this.layers.get(part.graphic) ?? 20;
      const order = spriteDrawOrder(layer, x, y) + partIndex;
      const placement = spritePartPlacement(
        anchorX,
        anchorY,
        part.offsetX,
        part.offsetY,
        spriteUnitsPerPixelX,
        spriteUnitsPerPixelY,
        factor,
      );
      const positionX = placement.x;
      const positionY = placement.y;
      const partSprites: Container[] = [];
      const sprite = new Sprite({ texture: entry.main });
      sprite.eventMode = 'none';
      sprite.anchor.set(
        entry.facing.anchorX / entry.facing.width,
        entry.facing.anchorY / entry.facing.height,
      );
      sprite.position.set(positionX, positionY);
      sprite.scale.set(placement.scaleX, placement.scaleY);
      sprite.zIndex = order;
      sprites.push(sprite);
      partSprites.push(sprite);
      const overlay = team ? this.overlay(key, team) : null;
      if (overlay instanceof Texture) {
        const coloured = new Sprite({ texture: overlay });
        coloured.eventMode = 'none';
        coloured.anchor.copyFrom(sprite.anchor);
        coloured.position.copyFrom(sprite.position);
        coloured.scale.copyFrom(sprite.scale);
        coloured.zIndex = order;
        sprites.push(coloured);
        partSprites.push(coloured);
      } else if (overlay) {
        const mesh = new Mesh({
          geometry: this.overlayGeometry(key, entry.facing),
          shader: overlay,
        });
        mesh.eventMode = 'none';
        mesh.position.set(positionX, positionY);
        mesh.scale.set(placement.scaleX, placement.scaleY);
        mesh.zIndex = order;
        sprites.push(mesh);
        partSprites.push(mesh);
      }
      if (tree) {
        for (const shown of partSprites) {
          this.treeSprites.push({
            sprite: shown,
            anchorX,
            anchorY,
            offsetX: part.offsetX,
            offsetY: part.offsetY,
          });
        }
      }
    }
    return sprites;
  }

  destroy(): void {
    this.container.destroy({ children: true });
    const atlas = this.atlas;
    this.atlas = null;
    for (const entry of this.textures.values()) {
      if (atlas) continue;
      entry.main.source.unload();
      entry.main.destroy(false);
    }
    for (const overlay of this.overlays.values()) {
      if (atlas && overlay instanceof Texture && atlas.owns(overlay)) continue;
      if (overlay instanceof Texture) overlay.destroy(true);
      else overlay.destroy(false);
    }
    atlas?.destroy();
    for (const geometry of this.overlayGeometries.values()) geometry.destroy(true);
    for (const source of this.maskSources.values()) source.destroy();
    this.overlays.clear();
    this.overlayGeometries.clear();
    this.maskSources.clear();
    this.textures.clear();
    this.built.clear();
    this.treeSprites.length = 0;
  }
}
