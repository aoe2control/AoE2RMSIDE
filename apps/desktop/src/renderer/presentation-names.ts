import type {
  LocalPresentationName,
  LocalPresentationNames,
  ObjectNameDescriptor,
  PreviewGenerationResult,
  TerrainMinimapColor,
  TerrainNameDescriptor,
} from '../shared/api';
import type { PreviewLook } from '../shared/game-art';
import { t } from '../shared/i18n/translator';
import type { TextureLookColors } from '../shared/texture-palette';
import { appNamedTerrainIds } from './preview-materials';

export interface PresentationNameSources {
  localObjectIds: ReadonlySet<number>;
  localTerrainIds: ReadonlySet<number>;
}

export type PresentedPreviewResult = PreviewGenerationResult & {
  presentationNameSources?: PresentationNameSources;
  objectLabels?: ReadonlyMap<number, string>;
  terrainLabels?: ReadonlyMap<number, string>;
  localTerrainColors?: readonly TerrainMinimapColor[];
  look?: PreviewLook;
  lookColors?: Pick<TextureLookColors, 'terrains' | 'gaiaObjects' | 'cliffs'>;
};

export function localPresentationNameText(entry: LocalPresentationName): string | null {
  if (entry.displayName && entry.constant) {
    return t('preview-panel.name.with-constant', {
      name: entry.displayName,
      constant: entry.constant,
    });
  }
  return entry.displayName ?? entry.constant;
}

export function localPresentationNameLabel(entry: LocalPresentationName): string | null {
  return entry.displayName && entry.constant ? entry.displayName : null;
}

const placeholderObjectName = /^Object \d+$/u;
const placeholderTerrainName = /^Terrain \d+$/u;

export function presentPreviewNames(
  result: PreviewGenerationResult,
  local: LocalPresentationNames | null,
): PresentedPreviewResult {
  const constants = result.constantNames;
  if (
    !contributesNames(local) &&
    (!constants || (constants.objects.length === 0 && constants.terrains.length === 0))
  ) {
    return result;
  }
  const localObjectIds = new Set<number>();
  const localTerrainIds = new Set<number>();
  const objectLabels = new Map<number, string>();
  const terrainLabels = new Map<number, string>();
  const objectNames = mergeNames<ObjectNameDescriptor>(
    (constants?.objects ?? []).map((entry) => [entry.objectId, entry.name]),
    result.objectNames.map((entry) => [entry.objectId, entry.name]),
    local?.objects ?? [],
    placeholderObjectName,
    localObjectIds,
    (objectId, name) => ({ objectId, name }),
    objectLabels,
  );
  const terrainNames = mergeNames<TerrainNameDescriptor>(
    constantTerrainNames(constants?.terrains),
    result.terrainNames.map((entry) => [entry.terrainId, entry.name]),
    local?.terrains ?? [],
    placeholderTerrainName,
    localTerrainIds,
    (terrainId, name) => ({ terrainId, name }),
    terrainLabels,
  );
  return {
    ...result,
    objectNames,
    terrainNames,
    presentationNameSources: { localObjectIds, localTerrainIds },
    ...(objectLabels.size > 0 ? { objectLabels } : {}),
    ...(terrainLabels.size > 0 ? { terrainLabels } : {}),
    ...(local && local.terrainColors.length > 0 ? { localTerrainColors: local.terrainColors } : {}),
  };
}

export function presentTerrainColorSources(
  shippedTerrainNames: PreviewGenerationResult['terrainNames'],
  local: LocalPresentationNames | null,
  constants: readonly TerrainNameDescriptor[] = [],
): Pick<PresentedPreviewResult, 'terrainNames' | 'localTerrainColors' | 'terrainLabels'> {
  if (
    (!local || (local.terrains.length === 0 && local.terrainColors.length === 0)) &&
    constants.length === 0
  ) {
    return { terrainNames: shippedTerrainNames };
  }
  const terrainLabels = new Map<number, string>();
  const terrainNames = mergeNames<TerrainNameDescriptor>(
    constantTerrainNames(constants),
    shippedTerrainNames.map((entry) => [entry.terrainId, entry.name]),
    local?.terrains ?? [],
    placeholderTerrainName,
    new Set<number>(),
    (terrainId, name) => ({ terrainId, name }),
    terrainLabels,
  );
  return {
    terrainNames,
    ...(terrainLabels.size > 0 ? { terrainLabels } : {}),
    ...(local && local.terrainColors.length > 0 ? { localTerrainColors: local.terrainColors } : {}),
  };
}

function contributesNames(local: LocalPresentationNames | null): local is LocalPresentationNames {
  return (
    local !== null &&
    (local.objects.length > 0 || local.terrains.length > 0 || local.terrainColors.length > 0)
  );
}

function constantTerrainNames(
  constants: readonly TerrainNameDescriptor[] | undefined,
): Array<readonly [number, string]> {
  return (constants ?? [])
    .filter((entry) => !appNamedTerrainIds.has(entry.terrainId))
    .map((entry) => [entry.terrainId, entry.name]);
}

function mergeNames<T>(
  constants: ReadonlyArray<readonly [number, string]>,
  shipped: ReadonlyArray<readonly [number, string]>,
  local: readonly LocalPresentationName[],
  placeholder: RegExp,
  localIds: Set<number>,
  create: (id: number, name: string) => T,
  labels: Map<number, string>,
): T[] {
  const names = new Map<number, string>(constants);
  for (const [id, name] of shipped) {
    if (!placeholder.test(name)) names.set(id, name);
  }
  for (const entry of local) {
    const name = localPresentationNameText(entry);
    if (!name) continue;
    names.set(entry.id, name);
    localIds.add(entry.id);
    const label = localPresentationNameLabel(entry);
    if (label) labels.set(entry.id, label);
    else labels.delete(entry.id);
  }
  return [...names.entries()]
    .sort(([left], [right]) => left - right)
    .map(([id, name]) => create(id, name));
}
