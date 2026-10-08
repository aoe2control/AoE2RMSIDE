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
  const objectNames = mergeNames<ObjectNameDescriptor>(
    (constants?.objects ?? []).map((entry) => [entry.objectId, entry.name]),
    result.objectNames.map((entry) => [entry.objectId, entry.name]),
    local?.objects ?? [],
    placeholderObjectName,
    localObjectIds,
    (objectId, name) => ({ objectId, name }),
  );
  const terrainNames = mergeNames<TerrainNameDescriptor>(
    constantTerrainNames(constants?.terrains),
    result.terrainNames.map((entry) => [entry.terrainId, entry.name]),
    local?.terrains ?? [],
    placeholderTerrainName,
    localTerrainIds,
    (terrainId, name) => ({ terrainId, name }),
  );
  return {
    ...result,
    objectNames,
    terrainNames,
    presentationNameSources: { localObjectIds, localTerrainIds },
    ...(local && local.terrainColors.length > 0 ? { localTerrainColors: local.terrainColors } : {}),
  };
}

export function presentTerrainColorSources(
  shippedTerrainNames: PreviewGenerationResult['terrainNames'],
  local: LocalPresentationNames | null,
  constants: readonly TerrainNameDescriptor[] = [],
): Pick<PresentedPreviewResult, 'terrainNames' | 'localTerrainColors'> {
  if (
    (!local || (local.terrains.length === 0 && local.terrainColors.length === 0)) &&
    constants.length === 0
  ) {
    return { terrainNames: shippedTerrainNames };
  }
  const terrainNames = mergeNames<TerrainNameDescriptor>(
    constantTerrainNames(constants),
    shippedTerrainNames.map((entry) => [entry.terrainId, entry.name]),
    local?.terrains ?? [],
    placeholderTerrainName,
    new Set<number>(),
    (terrainId, name) => ({ terrainId, name }),
  );
  return {
    terrainNames,
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
  }
  return [...names.entries()]
    .sort(([left], [right]) => left - right)
    .map(([id, name]) => create(id, name));
}
