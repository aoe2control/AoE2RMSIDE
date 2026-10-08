import type {
  LocalPresentationNames,
  PreviewGenerationResult,
  SelectedMinimapPalette,
  TerrainMinimapColor,
} from '../shared/api';
import type { PreviewLook } from '../shared/game-art';
import { failedConnectionSearch, type ConnectionRouteSet } from '../shared/connection-routes';
import { t, type MessageId } from '../shared/i18n/translator';
import type { PresentedPreviewResult } from './presentation-names';
import { classifyTerrainFamily, terrainFamilyColor } from './terrain-families';
import { failedConnectionSearchColor } from './preview-connection-routes';
import {
  selectionTileIndices,
  type PreviewSelection,
  type TopDownConnection,
  type TopDownObject,
  type TopDownScene,
} from './top-down-preview';

export type AtomicShape = 'circle' | 'diamond' | 'square' | 'triangle' | 'line' | 'double-line';

const markerShapeOutlines: Partial<Record<AtomicShape, readonly number[]>> = {
  diamond: [0, -1, 1, 0, 0, 1, -1, 0],
  triangle: [0, -1, 1, 1, -1, 1],
  square: [-1, -1, 1, -1, 1, 1, -1, 1],
};

export function markerShapePolygon(
  shape: AtomicShape,
  x: number,
  y: number,
  radius: number,
  verticalScale = 1,
): number[] {
  const outline = markerShapeOutlines[shape] ?? [];
  return outline.map((value, index) =>
    index % 2 === 0 ? x + value * radius : y + value * radius * verticalScale,
  );
}

export type PreviewMaterialSubject =
  | { kind: 'terrain'; id: number }
  | { kind: 'object'; id: number; owner: number }
  | { kind: 'helper'; id: number }
  | { kind: 'wall'; id: number }
  | { kind: 'cliff'; id: number }
  | {
      kind: 'connection';
      connection: TopDownConnection['kind'];
      failedSearch?: true;
    };

export interface PreviewMaterial {
  color: number;
  name: string | null;
  nameId?: MessageId;
  subject: PreviewMaterialSubject;
  identity: string;
  shape: AtomicShape;
  nameSource?: 'linked-installation';
  colorSource?: TerrainColorSource;
  helper?: true;
}

const hiddenTownCenterAnnexObjectIds = new Set([618, 619, 620, 890, 1649]);

export function isVisiblePreviewObject(object: Pick<TopDownObject, 'objectId'>): boolean {
  return !hiddenTownCenterAnnexObjectIds.has(object.objectId);
}

export const knownHelperObjectIds: ReadonlySet<number> = new Set([94, 278, 837, 1613]);

export const helperObjectColor = 0xc4c7cc;

export function previewHelperObjectIds(
  map: Pick<PreviewGenerationResult, 'objectNames' | 'graphiclessObjectIds'>,
  local: Pick<LocalPresentationNames, 'graphiclessObjectIds'> | null,
): ReadonlySet<number> {
  const helpers = new Set<number>(knownHelperObjectIds);
  for (const id of map.graphiclessObjectIds ?? []) helpers.add(id);
  if (local) {
    const shipped = new Set(map.objectNames.map((entry) => entry.objectId));
    for (const id of local.graphiclessObjectIds) if (!shipped.has(id)) helpers.add(id);
  }
  return helpers;
}

export interface PreviewObjectVisibility {
  objects: boolean;
  helpers: boolean;
  helperObjectIds: ReadonlySet<number>;
  decorations?: boolean;
}

export const defaultPreviewObjectVisibility: PreviewObjectVisibility = Object.freeze({
  objects: true,
  helpers: false,
  helperObjectIds: new Set<number>(),
});

export function isHelperPreviewObject(
  object: Pick<TopDownObject, 'objectId'>,
  helperObjectIds: ReadonlySet<number>,
): boolean {
  return helperObjectIds.has(object.objectId);
}

export function isDecorationPreviewObject(object: Pick<TopDownObject, 'appearance'>): boolean {
  return object.appearance === 'decoration';
}

export function isDrawnPreviewObject(
  object: Pick<TopDownObject, 'objectId' | 'appearance'>,
  visibility: PreviewObjectVisibility = defaultPreviewObjectVisibility,
): boolean {
  return (
    visibility.objects &&
    isVisiblePreviewObject(object) &&
    (visibility.decorations === true || !isDecorationPreviewObject(object)) &&
    (visibility.helpers || !isHelperPreviewObject(object, visibility.helperObjectIds))
  );
}

export function hasVisiblePreviewFootprint(object: Pick<TopDownObject, 'objectId'>): boolean {
  return object.objectId === 109;
}

export type SelectedTileLayerKind = 'terrain' | 'connection' | 'cliff' | 'object' | 'wall';

export interface SelectedTileLayer {
  key: string;
  kind: SelectedTileLayerKind;
  material: PreviewMaterial;
  operationIndex: number | null;
  renderOrder: number;
}

export interface SelectedLayerInstance extends SelectedTileLayer {
  elementOrder: number;
  tileIndex: number;
  x: number;
  y: number;
}

export interface AggregatedSelectionLayer {
  count: number;
  ids: readonly number[];
  instances: SelectedLayerInstance[];
  key: string;
  kind: SelectedTileLayerKind;
  material: PreviewMaterial;
  renderOrder: number;
}

export function partitionHelperLayers(layers: readonly AggregatedSelectionLayer[]): {
  helperCount: number;
  helperLayers: AggregatedSelectionLayer[];
  mainLayers: AggregatedSelectionLayer[];
} {
  const helperLayers = layers.filter((layer) => layer.material.helper);
  return {
    helperCount: helperLayers.reduce((total, layer) => total + layer.count, 0),
    helperLayers,
    mainLayers: layers.filter((layer) => !layer.material.helper),
  };
}

export function legendHighlightKey(
  pointerLayerKey: string | null,
  focusedLayerKey: string | null,
): string | null {
  return pointerLayerKey ?? focusedLayerKey;
}

export interface AggregatedLayerActivation {
  ambiguityMessage: string | null;
  operationIndex: number | null;
}

export interface PreviewLayerLabel {
  name: string;
  nameMuted: boolean;
  owner: string | null;
  disambiguation: string | null;
  details: readonly string[];
  nameSource: 'linked-installation' | null;
  description: string;
}

export function previewLayerLabel(
  layer: Pick<AggregatedSelectionLayer, 'ids' | 'material'>,
  disambiguate = false,
): PreviewLayerLabel {
  const { material } = layer;
  const subject = material.subject;
  const ids = layerIds(layer);
  const idText = ids.join(', ');
  const presentedName = material.nameId ? t(material.nameId) : material.name;
  const named = presentedName !== null;
  const details: string[] = [];
  const objectNumber = () => t('preview-panel.name.object-number', { id: idText });
  const terrainNumber = () => t('preview-panel.name.terrain-number', { id: idText });
  let name: string;
  let owner: string | null = null;
  switch (subject.kind) {
    case 'terrain':
      name = presentedName ?? terrainNumber();
      if (named) details.push(terrainNumber());
      break;
    case 'object':
      name = presentedName ?? objectNumber();
      if (named) details.push(objectNumber());
      if (subject.owner > 0) {
        owner = t('preview-panel.material.owner-short', { owner: subject.owner });
        details.push(t('preview-panel.material.player', { owner: subject.owner }));
      } else {
        details.push(t('preview-panel.material.gaia'));
      }
      break;
    case 'helper':
      name = presentedName ?? objectNumber();
      if (named) details.push(objectNumber());
      details.push(t('preview-panel.material.helper-object'));
      break;
    case 'wall':
      name = presentedName ?? t('preview-panel.name.wall-number', { id: idText });
      if (named) details.push(objectNumber());
      break;
    case 'cliff':
      name = t('preview-panel.material.cliff');
      details.push(t('preview-panel.material.cliff-type', { id: idText }));
      break;
    case 'connection':
      name = subject.failedSearch
        ? t('preview-panel.material.connection.failed')
        : t(connectionNames[subject.connection]);
      break;
  }
  return {
    name,
    nameMuted: !named && subject.kind !== 'cliff' && subject.kind !== 'connection',
    owner,
    disambiguation: disambiguate && ids.length > 0 ? idText : null,
    details,
    nameSource: material.nameSource ?? null,
    description:
      details.length > 0 ? t('preview-panel.material.description', { name, details }) : name,
  };
}

const connectionNames: Readonly<Record<TopDownConnection['kind'], MessageId>> = {
  land: 'preview-panel.material.connection.land',
  water: 'preview-panel.material.connection.water',
  road: 'preview-panel.material.connection.road',
  unknown: 'preview-panel.material.connection.unknown',
};

export function previewLegendLabels(
  layers: readonly Pick<AggregatedSelectionLayer, 'ids' | 'key' | 'material'>[],
): Map<string, PreviewLayerLabel> {
  const labels = layers.map((layer) => previewLayerLabel(layer));
  const shown = new Map<string, Set<string>>();
  const text = (label: PreviewLayerLabel) => `${label.name}\u0000${label.owner ?? ''}`;
  layers.forEach((layer, index) => {
    const key = text(labels[index]!);
    const group = shown.get(key) ?? new Set<string>();
    group.add(layerIds(layer).join(','));
    shown.set(key, group);
  });
  return new Map(
    layers.map((layer, index) => {
      const label = labels[index]!;
      const clash = shown.get(text(label))!.size > 1;
      return [layer.key, clash ? previewLayerLabel(layer, true) : label];
    }),
  );
}

export function previewLegendFilterMatches(label: PreviewLayerLabel, filter: string): boolean {
  const terms = filterText(filter).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const text = filterText(
    [label.name, label.owner ?? '', label.disambiguation ?? '', label.description].join(' '),
  );
  return terms.every((term) => text.includes(term));
}

function filterText(text: string): string {
  return text.toLocaleLowerCase().replaceAll('_', ' ');
}

export interface PreviewLegendTextMetrics {
  name(text: string): number;
  muted(text: string): number;
  count(text: string): number;
  readout(text: string): number;
}

export const previewLegendBoxMetrics = Object.freeze({
  rowPadding: 4,
  iconColumn: 18,
  columnGap: 5,
  readoutPadding: 4,
  readoutGap: 10,
  readoutIcon: 12 + 4,
  legendPadding: 4,
});

export const previewLegendMaximumRowWidth = 224;
const previewLegendCountDigits = 6;
const previewLegendCoordinateDigits = 3;

export function previewLegendPanelWidth(
  catalog: {
    objectNames: readonly { objectId: number; name: string }[];
    terrainNames: readonly { terrainId: number; name: string }[];
  },
  metrics: PreviewLegendTextMetrics,
): number {
  const box = previewLegendBoxMetrics;
  const owner = metrics.muted(t('preview-panel.material.owner-short', { owner: 8 }));
  const space = metrics.name(' ');
  let widest = 0;
  let largestId = 0;
  const idsByName = new Map<string, number>();
  for (const { objectId, name } of catalog.objectNames) {
    largestId = Math.max(largestId, objectId);
    if (placeholderObjectName.test(name)) continue;
    idsByName.set(name, (idsByName.get(name) ?? 0) + 1);
  }
  for (const [name, count] of idsByName) {
    const suffix = Math.max(owner, count > 1 ? metrics.muted(String(largestId)) : 0);
    widest = Math.max(widest, metrics.name(name) + space + suffix);
  }
  for (const { terrainId, name } of catalog.terrainNames) {
    largestId = Math.max(largestId, terrainId);
    if (!placeholderTerrainName.test(name)) widest = Math.max(widest, metrics.name(name));
  }
  const fixed = [
    ...terrainPalette.map((entry) => t(entry.nameId)),
    ...[...exactTerrainFallbacks.values()].map((entry) => t(entry.nameId)),
    t('preview-panel.material.cliff'),
    ...Object.values(connectionNames).map((nameId) => t(nameId)),
  ];
  for (const name of fixed) widest = Math.max(widest, metrics.name(name));
  const id = String(Math.max(largestId, 9999));
  for (const [unnamed, owned] of [
    [t('preview-panel.name.object-number', { id }), true],
    [t('preview-panel.name.terrain-number', { id }), false],
    [t('preview-panel.name.wall-number', { id }), false],
  ] as const) {
    widest = Math.max(widest, metrics.name(unnamed) + (owned ? space + owner : 0));
  }
  const count = metrics.count('0'.repeat(previewLegendCountDigits));
  const row = Math.min(
    previewLegendMaximumRowWidth,
    2 * box.rowPadding + box.iconColumn + 2 * box.columnGap + widest + count,
  );
  return Math.ceil(Math.max(row + 2 * box.legendPadding, previewReadoutWidth(metrics)));
}

export function previewReadoutWidth(metrics: Pick<PreviewLegendTextMetrics, 'readout'>): number {
  const box = previewLegendBoxMetrics;
  const coordinate = '0'.repeat(previewLegendCoordinateDigits);
  return (
    2 * box.readoutPadding +
    box.readoutGap +
    2 * box.readoutIcon +
    metrics.readout(`(${coordinate}, ${coordinate})–(${coordinate}, ${coordinate})`) +
    metrics.readout(t('preview-panel.readout.cursor', { x: coordinate, y: coordinate }))
  );
}

const previewInformationInset = 44;

export function previewReadoutStacked(readoutWidth: number, previewWidth: number): boolean {
  return Math.ceil(readoutWidth) > previewWidth - previewInformationInset;
}

function layerIds(layer: Pick<AggregatedSelectionLayer, 'ids' | 'material'>): readonly number[] {
  if (layer.ids.length > 0) return layer.ids;
  const subject = layer.material.subject;
  return 'id' in subject ? [subject.id] : [];
}

const terrainPalette: readonly { color: number; nameId: MessageId }[] = [
  { color: 0x66865d, nameId: 'preview-panel.material.terrain.grass' },
  { color: 0x668fa0, nameId: 'preview-panel.material.terrain.shallows' },
  { color: 0x356d84, nameId: 'preview-panel.material.terrain.water' },
  { color: 0xb49462, nameId: 'preview-panel.material.terrain.beach' },
  { color: 0x7d9064, nameId: 'preview-panel.material.terrain.earth' },
  { color: 0x7b7191, nameId: 'preview-panel.material.terrain.stone' },
];

const ownerColors = [
  0x2775e7, 0xdd4646, 0x30a651, 0xd8c33a, 0x5bcbd1, 0x9756ce, 0x7d8189, 0xe49335,
] as const;

const exactTerrainFallbacks = new Map<number, { color: number; nameId: MessageId }>([
  [0, { color: 0x66865d, nameId: 'preview-panel.material.terrain.grass' }],
  [1, { color: 0x356d84, nameId: 'preview-panel.material.terrain.water' }],
  [2, { color: 0xb49462, nameId: 'preview-panel.material.terrain.beach' }],
  [3, { color: 0x7d9064, nameId: 'preview-panel.material.terrain.dirt' }],
  [6, { color: 0x7d9064, nameId: 'preview-panel.material.terrain.earth' }],
  [16, { color: 0x7b7191, nameId: 'preview-panel.material.terrain.cliff-facet' }],
]);

export const appNamedTerrainIds: ReadonlySet<number> = new Set(exactTerrainFallbacks.keys());

const placeholderTerrainName = /^Terrain \d+$/u;
const placeholderObjectName = /^Object \d+$/u;

export type TerrainColorSource =
  'texture-palette' | 'shipped-palette' | 'linked-installation' | 'name-family';

export function terrainMaterial(
  terrainId: number,
  backend: PreviewGenerationResult['backend'] = 'synthetic',
  minimapPalette: SelectedMinimapPalette | null = null,
  terrainNames: PreviewGenerationResult['terrainNames'] = [],
  localTerrainIds?: ReadonlySet<number>,
  localTerrainColors?: readonly TerrainMinimapColor[],
  lookTerrainColors?: ReadonlyMap<number, number>,
): PreviewMaterial {
  const subject = { kind: 'terrain', id: terrainId } as const;
  if (backend === 'exact') {
    const fallback = exactTerrainFallbacks.get(terrainId);
    const listedName = findById(terrainNames, 'terrainId', terrainId)?.name;
    const presentedName =
      listedName && !placeholderTerrainName.test(listedName) ? listedName : undefined;
    const named = presentedName
      ? {
          identity: `name:${presentedName}`,
          name: presentedName,
          ...(localTerrainIds?.has(terrainId)
            ? { nameSource: 'linked-installation' as const }
            : {}),
        }
      : {};
    const base = {
      identity: `id:${terrainId}`,
      name: fallback ? t(fallback.nameId) : null,
      ...(fallback && !presentedName ? { nameId: fallback.nameId } : {}),
      shape: 'square' as const,
      subject,
    };
    const material = fallback ? { ...base, color: fallback.color } : undefined;
    const textureColor = lookTerrainColors?.get(terrainId);
    if (textureColor !== undefined) {
      return { ...base, color: textureColor, colorSource: 'texture-palette', ...named };
    }
    const paletteColor = findById(
      minimapPalette?.terrainColors,
      'terrainId',
      terrainId,
    )?.mediumColor;
    if (paletteColor !== undefined) {
      return { ...base, color: paletteColor, colorSource: 'shipped-palette', ...named };
    }
    const localColor = findById(localTerrainColors, 'terrainId', terrainId)?.mediumColor;
    if (localColor !== undefined) {
      return { ...base, color: localColor, colorSource: 'linked-installation', ...named };
    }
    if (material) return { ...material, ...named };
    return {
      ...base,
      color: terrainFamilyColor(terrainId, classifyTerrainFamily(listedName ? [listedName] : [])),
      colorSource: 'name-family',
      ...named,
    };
  }
  const index = Math.abs(terrainId - 1) % terrainPalette.length;
  const material = terrainPalette[index]!;
  return {
    color: material.color,
    identity: `id:${terrainId}`,
    name: terrainId > 0 ? t(material.nameId) : null,
    ...(terrainId > 0 ? { nameId: material.nameId } : {}),
    shape: 'square',
    subject,
  };
}

export function objectMaterial(
  object: Pick<TopDownObject, 'objectId' | 'owner' | 'presentationKind'>,
  playerColorIds: readonly number[] = [],
  objectNames: PreviewGenerationResult['objectNames'] = [],
  minimapPalette: SelectedMinimapPalette | null = null,
  localObjectIds?: ReadonlySet<number>,
  helperObjectIds?: ReadonlySet<number>,
  lookObjectColors?: ReadonlyMap<number, number>,
): PreviewMaterial {
  const listedName = objectNameForId(objectNames, object.objectId);
  const objectName =
    listedName !== null && !placeholderObjectName.test(listedName) ? listedName : null;
  const nameSource =
    objectName !== null && localObjectIds?.has(object.objectId)
      ? { nameSource: 'linked-installation' as const }
      : {};
  const id = object.objectId;
  const nameIdentity = objectName === null ? `id:${id}` : `name:${objectName}`;
  if (helperObjectIds && isHelperPreviewObject(object, helperObjectIds)) {
    return {
      color: helperObjectColor,
      helper: true,
      identity: nameIdentity,
      name: objectName,
      shape:
        object.presentationKind === 'wall'
          ? 'double-line'
          : (['circle', 'diamond', 'triangle'] as const)[Math.abs(id) % 3]!,
      subject: { kind: 'helper', id },
      ...nameSource,
    };
  }
  if (object.presentationKind === 'wall') {
    return {
      color: 0x8c8174,
      identity: nameIdentity,
      name: objectName,
      shape: 'double-line',
      subject: { kind: 'wall', id },
      ...nameSource,
    };
  }
  const shape = (['circle', 'diamond', 'triangle'] as const)[Math.abs(id) % 3]!;
  const neutralColor =
    lookObjectColors?.get(id) ??
    findById(minimapPalette?.neutralObjectColors, 'objectId', id)?.color;
  const owner = object.owner > 0 ? object.owner : 0;
  return {
    color:
      object.owner === 0 && neutralColor !== undefined
        ? neutralColor
        : ownerPreviewColor(object.owner, playerColorIds),
    identity: `${nameIdentity}:owner:${owner}`,
    name: objectName,
    shape,
    subject: { kind: 'object', id, owner },
    ...nameSource,
  };
}

export function ownerPreviewColor(owner: number, playerColorIds: readonly number[] = []): number {
  if (owner <= 0) return ownerColors[6]!;
  return ownerColors[ownerPlayerColorIndex(owner, playerColorIds)]!;
}

export const playerColorCount = ownerColors.length;

export function ownerPlayerColorIndex(
  owner: number,
  playerColorIds: readonly number[] = [],
): number {
  const configuredColor = playerColorIds[owner];
  const resolvedColor =
    configuredColor !== undefined &&
    Number.isInteger(configuredColor) &&
    configuredColor >= 0 &&
    configuredColor < ownerColors.length
      ? configuredColor
      : owner - 1;
  return ((resolvedColor % ownerColors.length) + ownerColors.length) % ownerColors.length;
}

export const previewCliffColor = 0x5c3b1e;

export function cliffMaterial(
  cliffType: number,
  look: PreviewLook = 'minimap',
  minimapPalette: SelectedMinimapPalette | null = null,
  textureCliffColors?: ReadonlyMap<number, number>,
): PreviewMaterial {
  const color =
    look === 'texture-colors'
      ? (textureCliffColors?.get(cliffType) ?? previewCliffColor)
      : look === 'game-textures'
        ? (findById(minimapPalette?.cliffColors, 'cliffType', cliffType)?.leftColor ?? 0x3e332a)
        : previewCliffColor;
  return {
    color,
    identity: `id:${cliffType}`,
    name: null,
    shape: 'double-line',
    subject: { kind: 'cliff', id: cliffType },
  };
}

export function connectionMaterial(connection: Pick<TopDownConnection, 'kind'>): PreviewMaterial {
  const colors = { land: 0xe2c975, water: 0x5aa8ca, road: 0xb78a54, unknown: 0xd94b4b };
  return {
    color: colors[connection.kind],
    identity: connection.kind,
    name: null,
    shape: 'line',
    subject: { kind: 'connection', connection: connection.kind },
  };
}

export function failedConnectionSearchMaterial(): PreviewMaterial {
  return {
    color: failedConnectionSearchColor,
    identity: 'failed-search',
    name: null,
    shape: 'line',
    subject: { kind: 'connection', connection: 'unknown', failedSearch: true },
  };
}

function presentedCliffMaterial(map: PresentedPreviewResult, cliffType: number): PreviewMaterial {
  return cliffMaterial(cliffType, map.look, map.minimapPalette, map.lookColors?.cliffs);
}

function presentedTerrainMaterial(map: PresentedPreviewResult, terrainId: number): PreviewMaterial {
  return terrainMaterial(
    terrainId,
    map.backend,
    map.minimapPalette,
    map.terrainNames,
    map.presentationNameSources?.localTerrainIds,
    map.localTerrainColors,
    map.lookColors?.terrains,
  );
}

export function terrainColorSourcesIdentity(
  map: Pick<PresentedPreviewResult, 'terrainNames' | 'localTerrainColors'>,
): string {
  let hash = 0x811c9dc5;
  const mix = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const entry of map.terrainNames) mix(`n${entry.terrainId}:${entry.name};`);
  for (const entry of map.localTerrainColors ?? []) {
    mix(`c${entry.terrainId}:${entry.highColor}:${entry.mediumColor}:${entry.lowColor};`);
  }
  return hash.toString(16).padStart(8, '0');
}

function presentedObjectMaterial(
  map: PresentedPreviewResult,
  object: Pick<TopDownObject, 'objectId' | 'owner' | 'presentationKind'>,
  visibility: PreviewObjectVisibility,
): PreviewMaterial {
  return objectMaterial(
    object,
    map.playerColorIds,
    map.objectNames,
    map.minimapPalette,
    map.presentationNameSources?.localObjectIds,
    visibility.helperObjectIds,
    map.lookColors?.gaiaObjects,
  );
}

export function selectedTileLayers(
  map: PresentedPreviewResult,
  scene: TopDownScene,
  tileIndex: number,
  visibility: PreviewObjectVisibility = defaultPreviewObjectVisibility,
): SelectedTileLayer[] {
  if (tileIndex < 0 || tileIndex >= scene.width * scene.height) return [];
  const x = tileIndex % scene.width;
  const y = Math.floor(tileIndex / scene.width);
  const layers: SelectedTileLayer[] = [
    {
      key: `terrain-${tileIndex}`,
      kind: 'terrain',
      material: presentedTerrainMaterial(map, scene.terrainIds[tileIndex]!),
      operationIndex: operationIndex(map.tileOperationIndicesLe, tileIndex),
      renderOrder: 0,
    },
  ];
  scene.connections.forEach((connection, index) => {
    if (!pointMatches(connection.start, x, y) && !pointMatches(connection.end, x, y)) return;
    layers.push({
      key: `connection-${index}`,
      kind: 'connection',
      material: connectionMaterial(connection),
      operationIndex: operationIndex(map.connectionOperationIndicesLe, index),
      renderOrder: 1_000 + index,
    });
  });
  scene.cliffs.forEach((cliff, index) => {
    if (!pointMatches(cliff.from, x, y) && !pointMatches(cliff.to, x, y)) return;
    layers.push({
      key: `cliff-${index}`,
      kind: 'cliff',
      material: presentedCliffMaterial(map, cliff.cliffType),
      operationIndex: operationIndex(map.cliffOperationIndicesLe, index),
      renderOrder: 2_000 + index,
    });
  });
  scene.objects.forEach((object, index) => {
    if (!isListedPreviewObject(object, visibility)) return;
    if (Math.floor(object.x) !== x || Math.floor(object.y) !== y) return;
    layers.push({
      key: `object-${object.index}`,
      kind: object.presentationKind,
      material: presentedObjectMaterial(map, object, visibility),
      operationIndex: operationIndex(map.objectOperationIndicesLe, index),
      renderOrder: 3_000 + object.index,
    });
  });
  return layers.sort(
    (left, right) => left.renderOrder - right.renderOrder || left.key.localeCompare(right.key),
  );
}

export function aggregateSelectionLayers(
  map: PresentedPreviewResult,
  scene: TopDownScene,
  selection: PreviewSelection,
  visibility: PreviewObjectVisibility = defaultPreviewObjectVisibility,
  routes: ConnectionRouteSet | null = null,
): AggregatedSelectionLayer[] {
  return aggregateTileIndexLayers(
    map,
    scene,
    selectionTileIndices(selection, scene.width),
    visibility,
    undefined,
    routes,
  );
}

export function aggregateTileIndexLayers(
  map: PresentedPreviewResult,
  scene: TopDownScene,
  tileIndices: Iterable<number>,
  visibility: PreviewObjectVisibility = defaultPreviewObjectVisibility,
  operations?: ReadonlySet<number>,
  routes: ConnectionRouteSet | null = null,
): AggregatedSelectionLayer[] {
  const selectedTiles = new Set(
    [...tileIndices].filter((index) => index >= 0 && index < scene.width * scene.height),
  );
  const groups = new Map<string, AggregatedSelectionLayer & { idSet: Set<number> }>();
  const add = (layer: SelectedTileLayer, tileIndex: number, x: number, y: number) => {
    if (operations && (layer.operationIndex === null || !operations.has(layer.operationIndex))) {
      return;
    }
    const key = renderedMaterialIdentity(layer.kind, layer.material);
    let group = groups.get(key);
    if (!group) {
      group = {
        count: 0,
        ids: [],
        idSet: new Set(),
        instances: [],
        key,
        kind: layer.kind,
        material: layer.material,
        renderOrder: layerKindOrder(layer.kind),
      };
      groups.set(key, group);
    }
    const subject = layer.material.subject;
    if ('id' in subject) group.idSet.add(subject.id);
    group.instances.push({
      ...layer,
      elementOrder: layer.renderOrder,
      tileIndex,
      x,
      y,
    });
    group.count += 1;
  };
  for (const tileIndex of selectedTiles) {
    const x = tileIndex % scene.width;
    const y = Math.floor(tileIndex / scene.width);
    add(
      {
        key: `terrain-${tileIndex}`,
        kind: 'terrain',
        material: presentedTerrainMaterial(map, scene.terrainIds[tileIndex]!),
        operationIndex: operationIndex(map.tileOperationIndicesLe, tileIndex),
        renderOrder: 0,
      },
      tileIndex,
      x,
      y,
    );
  }
  const tracedTiles = routes ? tracedRouteTiles(routes, scene.width) : null;
  scene.connections.forEach((connection, index) => {
    const points =
      tracedTiles?.connections.get(index) ??
      distinctPoints(connection.start, connection.end).map(
        (point) => point.y * scene.width + point.x,
      );
    for (const tileIndex of points) {
      if (!selectedTiles.has(tileIndex)) continue;
      add(
        {
          key: `connection-${index}`,
          kind: 'connection',
          material: connectionMaterial(connection),
          operationIndex: operationIndex(map.connectionOperationIndicesLe, index),
          renderOrder: 1_000 + index,
        },
        tileIndex,
        tileIndex % scene.width,
        Math.floor(tileIndex / scene.width),
      );
    }
  });
  tracedTiles?.failures.forEach(({ operationIndex: failedOperation, tiles }, ordinal) => {
    for (const tileIndex of tiles) {
      if (!selectedTiles.has(tileIndex)) continue;
      add(
        {
          key: `failed-search-${ordinal}`,
          kind: 'connection',
          material: failedConnectionSearchMaterial(),
          operationIndex: failedOperation,
          renderOrder: 1_000 + scene.connections.length + ordinal,
        },
        tileIndex,
        tileIndex % scene.width,
        Math.floor(tileIndex / scene.width),
      );
    }
  });
  scene.cliffs.forEach((cliff, index) => {
    for (const point of distinctPoints(cliff.from, cliff.to)) {
      if (!selectedTiles.has(point.y * scene.width + point.x)) continue;
      add(
        {
          key: `cliff-${index}`,
          kind: 'cliff',
          material: presentedCliffMaterial(map, cliff.cliffType),
          operationIndex: operationIndex(map.cliffOperationIndicesLe, index),
          renderOrder: 2_000 + index,
        },
        point.y * scene.width + point.x,
        point.x,
        point.y,
      );
    }
  });
  scene.objects.forEach((object, index) => {
    if (!isListedPreviewObject(object, visibility)) return;
    const x = Math.floor(object.x);
    const y = Math.floor(object.y);
    if (!selectedTiles.has(y * scene.width + x)) return;
    add(
      {
        key: `object-${object.index}`,
        kind: object.presentationKind,
        material: presentedObjectMaterial(map, object, visibility),
        operationIndex: operationIndex(map.objectOperationIndicesLe, index),
        renderOrder: 3_000 + object.index,
      },
      y * scene.width + x,
      x,
      y,
    );
  });
  return [...groups.values()]
    .map(({ idSet, ...group }) => ({
      ...group,
      ids: [...idSet].sort((left, right) => left - right),
      instances: group.instances.sort(compareLayerInstances),
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.renderOrder - right.renderOrder ||
        lexicalCompare(left.key, right.key),
    );
}

export function operationTileIndices(
  map: PreviewGenerationResult,
  scene: TopDownScene,
  operationIndices: Iterable<number>,
  options: {
    selection?: PreviewSelection | null;
    visibility?: PreviewObjectVisibility;
  } = {},
): number[] {
  const operations = new Set(operationIndices);
  if (operations.size === 0) return [];
  const { selection, visibility } = options;
  const tiles = new Set<number>();
  const inside = (x: number, y: number) =>
    x >= 0 &&
    x < scene.width &&
    y >= 0 &&
    y < scene.height &&
    (!selection ||
      (x >= selection.minimumX &&
        x <= selection.maximumX &&
        y >= selection.minimumY &&
        y <= selection.maximumY));
  const addPoint = (point: { x: number; y: number }) => {
    if (inside(point.x, point.y)) tiles.add(point.y * scene.width + point.x);
  };
  for (let tileIndex = 0; tileIndex < scene.width * scene.height; tileIndex += 1) {
    const operation = operationIndex(map.tileOperationIndicesLe, tileIndex);
    if (operation !== null && operations.has(operation)) {
      addPoint({ x: tileIndex % scene.width, y: Math.floor(tileIndex / scene.width) });
    }
  }
  scene.objects.forEach((object, index) => {
    if (visibility ? !isDrawnPreviewObject(object, visibility) : !isVisiblePreviewObject(object))
      return;
    const operation = operationIndex(map.objectOperationIndicesLe, index);
    if (operation !== null && operations.has(operation)) {
      addPoint({ x: Math.floor(object.x), y: Math.floor(object.y) });
    }
  });
  scene.cliffs.forEach((cliff, index) => {
    const operation = operationIndex(map.cliffOperationIndicesLe, index);
    if (operation !== null && operations.has(operation)) {
      addPoint(cliff.from);
      addPoint(cliff.to);
    }
  });
  scene.connections.forEach((connection, index) => {
    const operation = operationIndex(map.connectionOperationIndicesLe, index);
    if (operation !== null && operations.has(operation)) {
      addPoint(connection.start);
      addPoint(connection.end);
    }
  });
  return [...tiles].sort((left, right) => left - right);
}

export function resolveAggregatedLayerActivation(
  map: PreviewGenerationResult,
  layer: AggregatedSelectionLayer,
): AggregatedLayerActivation {
  const resolved = layer.instances.flatMap((instance) => {
    if (instance.operationIndex === null) return [];
    const operation = map.provenanceOperations[instance.operationIndex];
    return operation ? [{ instance, operation }] : [];
  });
  const first = resolved[0];
  if (!first) return { ambiguityMessage: null, operationIndex: null };
  const origins = new Set(
    resolved.map(
      ({ operation }) =>
        `${operation.operationIdentity}\u0000${operation.sourceId}\u0000${operation.byteStart}\u0000${operation.byteEnd}`,
    ),
  );
  if (origins.size <= 1) {
    return { ambiguityMessage: null, operationIndex: first.instance.operationIndex };
  }
  const location = `${boundedTail(first.operation.sourceId, 72)}:${first.operation.byteStart}-${first.operation.byteEnd}`;
  return {
    ambiguityMessage: t('preview-panel.material.selection-ambiguity', {
      layer: boundedHead(previewLayerLabel(layer).description, 64),
      count: layer.count,
      sources: origins.size,
      location,
    }),
    operationIndex: first.instance.operationIndex,
  };
}

export function operationIndex(bytes: Uint8Array, index: number): number | null {
  const offset = index * 4;
  if (index < 0 || offset + 4 > bytes.byteLength) return null;
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
  return value === 0xffff_ffff ? null : value;
}

function isListedPreviewObject(
  object: Pick<TopDownObject, 'objectId' | 'appearance'>,
  visibility: PreviewObjectVisibility,
): boolean {
  return visibility.objects && isVisiblePreviewObject(object) && !isDecorationPreviewObject(object);
}

function pointMatches(point: { x: number; y: number }, x: number, y: number): boolean {
  return point.x === x && point.y === y;
}

function tracedRouteTiles(
  routes: ConnectionRouteSet,
  width: number,
): {
  connections: Map<number, number[]>;
  failures: { operationIndex: number; tiles: number[] }[];
} {
  const connections = new Map<number, number[]>();
  const failures: { operationIndex: number; tiles: number[] }[] = [];
  for (let record = 0; record < routes.count; record += 1) {
    const graphIndex = routes.records[record * 4]!;
    const first = routes.records[record * 4 + 2]!;
    const count = routes.records[record * 4 + 3]!;
    const tiles = new Set<number>();
    for (let vertex = first; vertex < first + count; vertex += 1) {
      tiles.add(routes.vertices[vertex * 2 + 1]! * width + routes.vertices[vertex * 2]!);
    }
    if (graphIndex === failedConnectionSearch) {
      failures.push({ operationIndex: routes.records[record * 4 + 1]!, tiles: [...tiles] });
    } else {
      connections.set(graphIndex, [...tiles]);
    }
  }
  return { connections, failures };
}

function distinctPoints(
  first: { x: number; y: number },
  second: { x: number; y: number },
): { x: number; y: number }[] {
  return first.x === second.x && first.y === second.y ? [first] : [first, second];
}

function findById<T, K extends keyof T>(
  values: readonly T[] | undefined,
  key: K,
  id: number,
): T | undefined {
  if (!values) return undefined;
  let minimum = 0;
  let maximum = values.length - 1;
  while (minimum <= maximum) {
    const index = Math.floor((minimum + maximum) / 2);
    const candidate = values[index]!;
    const candidateId = Number(candidate[key]);
    if (candidateId === id) return candidate;
    if (candidateId < id) minimum = index + 1;
    else maximum = index - 1;
  }
  return undefined;
}

export function objectNameForId(
  names: PreviewGenerationResult['objectNames'],
  objectId: number,
): string | null {
  let minimum = 0;
  let maximum = names.length - 1;
  while (minimum <= maximum) {
    const index = Math.floor((minimum + maximum) / 2);
    const candidate = names[index]!;
    if (candidate.objectId === objectId) return candidate.name;
    if (candidate.objectId < objectId) minimum = index + 1;
    else maximum = index - 1;
  }
  return null;
}

function renderedMaterialIdentity(kind: SelectedTileLayerKind, material: PreviewMaterial): string {
  return `${kind}\u0000${material.shape}\u0000${material.color.toString(16).padStart(6, '0')}\u0000${material.identity}`;
}

function layerKindOrder(kind: SelectedTileLayerKind): number {
  return { terrain: 0, connection: 1, cliff: 2, object: 3, wall: 4 }[kind];
}

function compareLayerInstances(left: SelectedLayerInstance, right: SelectedLayerInstance): number {
  return (
    left.y - right.y ||
    left.x - right.x ||
    left.elementOrder - right.elementOrder ||
    lexicalCompare(left.key, right.key)
  );
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedHead(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function boundedTail(value: string, maximum: number): string {
  return value.length <= maximum ? value : `…${value.slice(-(maximum - 1))}`;
}
