import { outputNote, type OutputMessage, type OutputText } from '../shared/output-message';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  gameArtLookOffered,
  maximumGameArtSpriteObjects,
  type CliffPieceRecord,
  type GameArtSpriteSet,
  type GameArtStatus,
  type GameArtTeamColors,
  type GameArtTerrainIndex,
  type PreviewLook,
  type PreviewPerspective,
} from '../shared/game-art';
import type { PreviewGenerationResult } from '../shared/api';
import { onGameInstallationChanged } from './game-installation';
import {
  GameArtAssetStore,
  gameArtSpriteBudget,
  loadTerrainSources,
  spriteFacingKeys,
} from './game-art-resources';
import {
  budgetedSpriteFacings,
  planSprites,
  spriteRequestObjects,
  type SpritePlan,
} from './game-art-sprites';
import type { GameArtTerrainSources } from './game-art-terrain';
import { cliffColors } from './game-art-cliffs';
import type { TopDownObject, TopDownScene } from './top-down-preview';

export interface GameArtTerrainView {
  key: string;
  mapHash: string;
  sources: GameArtTerrainSources;
  terrainIds: number[];
}

export interface GameArtSpriteView {
  key: string;
  plan: SpritePlan;
  set: GameArtSpriteSet;
  store: GameArtAssetStore;
}

export interface GameArtCliffView {
  key: string;
  pieces: readonly CliffPieceRecord[];
  colors: ReadonlyMap<number, number>;
}

export interface GameArtView {
  status: GameArtStatus;
  offered: boolean;
  expected: boolean;
  active: boolean;
  pending: boolean;
  terrain: GameArtTerrainView | null;
  sprites: GameArtSpriteView | null;
  cliffs: GameArtCliffView | null;
  store: GameArtAssetStore;
  playerColors: GameArtTeamColors | null;
}

export function useGameArtStatus(): GameArtStatus {
  const [status, setStatus] = useState<GameArtStatus>({ state: 'unlinked' });
  useEffect(() => {
    let current = true;
    const refresh = () =>
      window.rmside
        .getGameArtStatus()
        .then((next) => {
          if (current) setStatus(next);
        })
        .catch(() => undefined);
    void refresh();
    const unsubscribe = window.rmside.onGameArtStatus((next) => {
      if (current) setStatus(next);
    });
    const unsubscribeInstallation = onGameInstallationChanged(() => void refresh());
    return () => {
      current = false;
      unsubscribe();
      unsubscribeInstallation();
    };
  }, []);
  return status;
}

export function gameArtPreparationWanted(
  state: GameArtStatus['state'],
  wanted: boolean,
  newOccasion: boolean,
): boolean {
  return wanted && (state === 'idle' || (state === 'failed' && newOccasion));
}

export function useGameArtPreparation(
  state: GameArtStatus['state'],
  wanted: boolean,
  occasion: unknown,
): void {
  const lastOccasion = useRef<{ value: unknown } | null>(null);
  useEffect(() => {
    if (!wanted) {
      lastOccasion.current = null;
      return;
    }
    const newOccasion =
      lastOccasion.current === null || !Object.is(lastOccasion.current.value, occasion);
    lastOccasion.current = { value: occasion };
    if (gameArtPreparationWanted(state, wanted, newOccasion)) {
      void window.rmside.prepareGameArt().catch(() => undefined);
    }
  }, [occasion, state, wanted]);
}

export interface GameArtTerrainIndexState {
  index: GameArtTerrainIndex | null;
  failed: boolean;
}

export function useGameArtTerrainIndex(
  status: GameArtStatus,
  enabled: boolean,
): GameArtTerrainIndexState {
  const revision = enabled && status.state === 'ready' ? status.revision : null;
  const [loaded, setLoaded] = useState<{
    revision: number;
    index: GameArtTerrainIndex | null;
  } | null>(null);
  useEffect(() => {
    if (revision === null) return undefined;
    let current = true;
    void window.rmside
      .getGameArtTerrain()
      .then((index) => {
        if (current) setLoaded({ revision, index });
      })
      .catch(() => {
        if (current) setLoaded({ revision, index: null });
      });
    return () => {
      current = false;
    };
  }, [revision]);
  return useMemo(() => {
    if (revision === null || !loaded || loaded.revision !== revision) {
      return { index: null, failed: false };
    }
    return { index: loaded.index, failed: loaded.index === null };
  }, [loaded, revision]);
}

export function foundationTiles(
  object: Pick<TopDownObject, 'x' | 'y' | 'footprintWidth' | 'footprintHeight'>,
  width: number,
  height: number,
): number[] {
  const halfWidth = object.footprintWidth / 2;
  const halfHeight = object.footprintHeight / 2;
  if (halfWidth <= 0 || halfHeight <= 0) return [];
  const minimumX = Math.max(0, Math.round(object.x - halfWidth));
  const maximumX = Math.min(width - 1, Math.round(object.x + halfWidth) - 1);
  const minimumY = Math.max(0, Math.round(object.y - halfHeight));
  const maximumY = Math.min(height - 1, Math.round(object.y + halfHeight) - 1);
  const tiles: number[] = [];
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) tiles.push(y * width + x);
  }
  return tiles;
}

export function terrainWithFoundations(
  terrainIds: readonly number[],
  scene: Pick<TopDownScene, 'width' | 'height' | 'objects'>,
  set: GameArtSpriteSet | null,
  civilizationFor: (owner: number) => number,
  drawn: (object: TopDownObject) => boolean,
  texturedTerrain: (terrainId: number) => boolean,
): number[] {
  const result = [...terrainIds];
  if (!set) return result;
  const foundations = new Map(
    set.objects.map((entry) => [
      `${entry.civilizationId}:${entry.objectId}`,
      entry.foundationTerrain,
    ]),
  );
  for (const object of scene.objects) {
    if (!drawn(object)) continue;
    const foundation = foundations.get(`${civilizationFor(object.owner)}:${object.objectId}`);
    if (foundation === null || foundation === undefined || !texturedTerrain(foundation)) continue;
    for (const tile of foundationTiles(object, scene.width, scene.height))
      result[tile] = foundation;
  }
  return result;
}

interface PublishedGameArt {
  terrain: GameArtTerrainView;
  sprites: GameArtSpriteView | null;
  spritesKey: string | null;
}

export function gameArtTerrainKey(parts: {
  revision: number;
  mapHash: string;
  connections: 'post' | 'pre';
  foundations: boolean;
  colors: number;
  civilizations: string;
}): string {
  return `${parts.revision}:${parts.mapHash}:${parts.connections}:${parts.foundations ? 'foundations' : 'plain'}:${parts.colors}:${parts.civilizations}`;
}

export function gameArtCivilizationResolver(
  playerCivilizationIds: readonly number[] | undefined,
): (owner: number) => number {
  const civilizations = playerCivilizationIds ?? [];
  return (owner: number) => {
    const civilization = owner > 0 ? civilizations[owner] : 0;
    return civilization !== undefined && Number.isInteger(civilization) && civilization >= 0
      ? civilization
      : 0;
  };
}

export function gameArtCivilizationKey(
  playerCivilizationIds: readonly number[] | undefined,
): string {
  const resolve = gameArtCivilizationResolver(playerCivilizationIds);
  return Array.from({ length: 9 }, (_, owner) => resolve(owner)).join(',');
}

export function gameArtSpriteSetCurrent(
  loaded: { hash: string; civilizations: string; revision: number } | null,
  current: { mapHash: string | null; civilizations: string; revision: number | null },
): boolean {
  return (
    loaded !== null &&
    current.mapHash !== null &&
    current.revision !== null &&
    loaded.hash === current.mapHash &&
    loaded.civilizations === current.civilizations &&
    loaded.revision === current.revision
  );
}

export function gameArtPublishedFor(
  published: Pick<PublishedGameArt, 'spritesKey'> & { terrain: { key: string } },
  terrainKey: string | null,
  spritesKey: string | null,
): boolean {
  return (
    terrainKey !== null &&
    published.terrain.key === terrainKey &&
    published.spritesKey === spritesKey
  );
}

let colorRevisionSequence = 0;
const colorRevisions = new WeakMap<object, number>();

function colorRevision(minimapColor: (terrainId: number) => number): number {
  let revision = colorRevisions.get(minimapColor);
  if (revision === undefined) {
    colorRevisionSequence += 1;
    revision = colorRevisionSequence;
    colorRevisions.set(minimapColor, revision);
  }
  return revision;
}

export function useGameArt(options: {
  look: PreviewLook;
  perspective: PreviewPerspective;
  map: PreviewGenerationResult | null;
  scene: TopDownScene | null;
  terrainIds: readonly number[] | null;
  drawn: (object: TopDownObject) => boolean;
  objectsShown: boolean;
  minimapColor: (terrainId: number) => number;
  objectName?: (objectId: number) => string | null;
  appendOutput: (message: OutputMessage) => void;
}): GameArtView {
  const {
    look,
    perspective,
    map,
    scene,
    terrainIds,
    drawn,
    objectsShown,
    minimapColor,
    objectName = () => null,
    appendOutput,
  } = options;
  const status = useGameArtStatus();
  const offered = gameArtLookOffered(status);
  const wanted = look === 'game-textures' && offered;
  const terrainIndex = useGameArtTerrainIndex(status, wanted);
  const storeRef = useRef<GameArtAssetStore | null>(null);
  storeRef.current ??= new GameArtAssetStore(window.rmside);
  const store = storeRef.current;

  useGameArtPreparation(status.state, wanted, map);

  const index = wanted ? terrainIndex.index : null;

  const civilizationKey = gameArtCivilizationKey(map?.playerCivilizationIds);
  const civilizationFor = useMemo(
    () => gameArtCivilizationResolver(civilizationKey.split(',').map(Number)),
    [civilizationKey],
  );

  const [spriteSet, setSpriteSet] = useState<{
    hash: string;
    civilizations: string;
    revision: number;
    set: GameArtSpriteSet | null;
  } | null>(null);
  const mapHash = map?.semanticHash ?? null;
  useEffect(() => {
    if (!wanted || !index || !scene || !mapHash) return undefined;
    let current = true;
    const revision = index.revision;
    const objects = spriteRequestObjects(
      scene.objects,
      drawn,
      civilizationFor,
      maximumGameArtSpriteObjects,
      scene.cliffPieces ?? [],
    );
    void window.rmside
      .getGameArtSprites(objects)
      .then((set) => {
        if (current) setSpriteSet({ hash: mapHash, civilizations: civilizationKey, revision, set });
      })
      .catch(() => {
        if (current)
          setSpriteSet({ hash: mapHash, civilizations: civilizationKey, revision, set: null });
      });
    return () => {
      current = false;
    };
  }, [civilizationKey, index, mapHash, wanted]);

  const setResolved =
    index !== null &&
    gameArtSpriteSetCurrent(spriteSet, {
      mapHash,
      civilizations: civilizationKey,
      revision: index.revision,
    });
  const set = setResolved && spriteSet ? spriteSet.set : null;
  const colors = colorRevision(minimapColor);
  const terrainKey =
    index && scene && mapHash && terrainIds && setResolved
      ? gameArtTerrainKey({
          revision: index.revision,
          mapHash,
          connections: terrainIds === scene.terrainIds ? 'post' : 'pre',
          foundations: objectsShown && set !== null,
          colors,
          civilizations: civilizationKey,
        })
      : null;
  const spritesKey =
    terrainKey && perspective === 'diamond' && set ? `${terrainKey}:sprites:${set.revision}` : null;

  const [published, setPublished] = useState<PublishedGameArt | null>(null);
  const publishedRef = useRef(published);
  publishedRef.current = published;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const reportedGlyphs = useRef<string | null>(null);
  const inputs = useRef({ appendOutput, civilizationFor, drawn, minimapColor, objectName });
  inputs.current = { appendOutput, civilizationFor, drawn, minimapColor, objectName };
  useEffect(() => {
    if (!wanted) {
      setPublished(null);
      return undefined;
    }
    if (!terrainKey || !index || !scene || !map || !terrainIds || !mapHash) return undefined;
    const previous = publishedRef.current;
    const reusedTerrain = previous?.terrain.key === terrainKey ? previous.terrain : null;
    if (previous && gameArtPublishedFor(previous, terrainKey, spritesKey)) return undefined;
    let current = true;
    const { appendOutput, civilizationFor, drawn, minimapColor, objectName } = inputs.current;
    const build = async () => {
      let terrain = reusedTerrain;
      if (!terrain) {
        const textured = new Set(
          index.terrains.filter((entry) => entry.texture).map((entry) => entry.id),
        );
        const drawnTerrain = terrainWithFoundations(
          terrainIds,
          scene,
          objectsShown ? set : null,
          civilizationFor,
          drawn,
          (terrainId) => textured.has(terrainId),
        );
        const used = new Set<number>(drawnTerrain);
        for (const layer of scene.layerIds) if (layer !== 0xffff) used.add(layer);
        const sources = await loadTerrainSources(store, index, used, minimapColor);
        terrain = { key: terrainKey, mapHash, sources, terrainIds: drawnTerrain };
      }
      if (!current) return;
      let sprites: GameArtSpriteView | null = null;
      let spriteKeys: string[] = [];
      if (spritesKey && set) {
        const plan = planSprites(
          scene.objects,
          drawn,
          set,
          map.presentationSeed ?? 0,
          civilizationFor,
          scene.cliffPieces ?? [],
          { treeObjectIds: gameArtTreeObjectIds(map) },
        );
        plan.chosen = budgetedSpriteFacings(
          plan,
          set,
          gameArtSpriteBudget(store.bytesOf(terrain.sources.assetKeys)),
        );
        spriteKeys = spriteFacingKeys(set, plan.chosen);
        await store.load(spriteKeys);
        if (!current) return;
        sprites = { key: spritesKey, plan, set, store };
        const glyphTypes = [
          ...new Set(
            [...plan.glyphObjects].map((objectIndex) => scene.objects[objectIndex]?.objectId ?? -1),
          ),
        ].sort((left, right) => left - right);
        const report = `${mapHash}:${glyphTypes.join(',')}:${plan.cliffLines.size}`;
        if (reportedGlyphs.current !== report) {
          reportedGlyphs.current = report;
          const glyphLine = missingSpriteLine(glyphTypes, objectName);
          if (glyphLine) {
            appendOutput(outputNote('Game textures', 'game-textures.glyphs', glyphLine));
          }
          if (plan.cliffLines.size > 0) {
            appendOutput(
              outputNote('Game textures', 'game-textures.cliff-lines', {
                id: 'game-art.cliff-lines',
                args: { count: plan.cliffLines.size },
              }),
            );
          }
        }
      }
      store.retain(new Set([...terrain.sources.assetKeys, ...spriteKeys]));
      setPublished({ terrain, sprites, spritesKey });
    };
    build().catch(() => {
      if (current) setFailedKey(terrainKey);
    });
    return () => {
      current = false;
    };
  }, [
    index,
    map,
    mapHash,
    objectsShown,
    scene,
    set,
    spritesKey,
    store,
    terrainIds,
    terrainKey,
    wanted,
  ]);

  const statusUsable =
    status.state === 'idle' || status.state === 'preparing' || status.state === 'ready';
  const expected =
    wanted &&
    statusUsable &&
    !terrainIndex.failed &&
    (terrainKey === null || failedKey !== terrainKey);
  const shown = wanted && published && published.terrain.mapHash === mapHash ? published : null;
  const pending =
    expected &&
    map !== null &&
    scene !== null &&
    !(shown && gameArtPublishedFor(shown, terrainKey, spritesKey));

  const pieces = scene?.cliffPieces;
  const cliffs = useMemo<GameArtCliffView | null>(() => {
    if (!pieces || pieces.length === 0 || !mapHash) return null;
    return {
      key: `${mapHash}:${set?.revision ?? 'none'}`,
      pieces,
      colors: cliffColors(set, pieces),
    };
  }, [mapHash, pieces, set]);

  const active = shown !== null;
  return {
    status,
    offered,
    expected,
    active,
    pending,
    terrain: shown?.terrain ?? null,
    sprites: shown?.sprites ?? null,
    cliffs: active ? cliffs : null,
    store,
    playerColors: index?.playerColors ?? null,
  };
}

export function gameArtTreeObjectIds(
  map: Pick<PreviewGenerationResult, 'mapIconArtObjects'>,
): ReadonlySet<number> {
  return new Set(
    (map.mapIconArtObjects ?? [])
      .filter((entry) => entry.kind === 'tree')
      .map((entry) => entry.objectId),
  );
}

const namedGlyphTypes = 4;

export function missingSpriteLine(
  objectIds: readonly number[],
  objectName: (objectId: number) => string | null,
): OutputText | null {
  if (objectIds.length === 0) return null;
  const named = objectIds.slice(0, namedGlyphTypes).map((objectId): OutputText => {
    const name = objectName(objectId);
    return name
      ? { id: 'game-art.glyphs.object-named', args: { name, id: objectId } }
      : { id: 'game-art.glyphs.object', args: { id: objectId } };
  });
  const more = objectIds.length - named.length;
  return more > 0
    ? {
        id: 'game-art.glyphs.more',
        args: { count: objectIds.length, names: named, more },
      }
    : { id: 'game-art.glyphs', args: { count: objectIds.length, names: named } };
}
