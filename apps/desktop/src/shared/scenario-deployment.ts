import type { ManualDeploymentProfile, PreviewGenerationResult, PreviewScenarioData } from './api';

export const scenarioDeploymentContract = { major: 1, minor: 0, patch: 0 } as const;
export const maximumScenarioNameLength = 100;
const maximumMapSide = 480;
const maximumObjects = 1_000_000;
const maximumObjectKinds = 65_536;
const maximumScriptEffects = 100_000;

type ResultObjects = PreviewGenerationResult['objects'];

export type ScenarioDeploymentMap = Pick<
  PreviewGenerationResult,
  | 'documentUri'
  | 'width'
  | 'height'
  | 'terrainIdsLe'
  | 'elevations'
  | 'layerIdsLe'
  | 'cliffPiecesLe'
  | 'appearanceObjectsLe'
  | 'appearanceInstanceIdsLe'
  | 'playerColorIds'
  | 'playerCivilizationIds'
  | 'presentationSeed'
> & {
  objects: Pick<ResultObjects, 'idsLe' | 'xLe' | 'yLe' | 'owners' | 'facetsLe' | 'statusesLe'>;
  scenario: PreviewScenarioData;
};

export interface ScenarioDeploymentRequest {
  contractVersion: typeof scenarioDeploymentContract;
  profileId: string;
  name: string;
  scriptName: string;
  includeEffects: boolean;
  replaceExisting: boolean;
  map: ScenarioDeploymentMap;
}

export type ScenarioDeploymentOutcome =
  | { status: 'exists'; fileName: string }
  | {
      status: 'deployed';
      fileName: string;
      path: string;
      replaced: boolean;
      objectCount: number;
      effectCount: number;
    };

export interface ScenarioDeploymentContext {
  installationRoot: string;
  profiles: ManualDeploymentProfile[];
  selectedProfileId: string | null;
}

const reservedDeviceNames = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/iu;

export function scenarioNameProblem(
  name: string,
): 'empty' | 'long' | 'characters' | 'reserved' | null {
  if (typeof name !== 'string' || name.trim().length === 0) return 'empty';
  if (name.length > maximumScenarioNameLength) return 'long';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(name) || name !== name.trim() || name.endsWith('.')) {
    return 'characters';
  }
  if (reservedDeviceNames.test(name)) return 'reserved';
  return null;
}

export function suggestedScenarioName(scriptName: string, seed: number | undefined): string {
  const base =
    scriptName
      .replace(/\.[^.]*$/u, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
      .trim() || 'Map';
  return (seed === undefined ? base : `${base}-${seed}`).slice(0, 100).replace(/[. ]+$/u, '');
}

export function scenarioDeploymentMap(
  result: PreviewGenerationResult,
): ScenarioDeploymentMap | null {
  if (result.backend !== 'exact' || !result.scenario) return null;
  const { objects } = result;
  return {
    documentUri: result.documentUri,
    width: result.width,
    height: result.height,
    terrainIdsLe: result.terrainIdsLe,
    elevations: result.elevations,
    layerIdsLe: result.layerIdsLe,
    ...(result.cliffPiecesLe ? { cliffPiecesLe: result.cliffPiecesLe } : {}),
    ...(result.appearanceObjectsLe ? { appearanceObjectsLe: result.appearanceObjectsLe } : {}),
    ...(result.appearanceInstanceIdsLe
      ? { appearanceInstanceIdsLe: result.appearanceInstanceIdsLe }
      : {}),
    playerColorIds: result.playerColorIds,
    ...(result.playerCivilizationIds
      ? { playerCivilizationIds: result.playerCivilizationIds }
      : {}),
    ...(result.presentationSeed !== undefined ? { presentationSeed: result.presentationSeed } : {}),
    objects: {
      idsLe: objects.idsLe,
      xLe: objects.xLe,
      yLe: objects.yLe,
      owners: objects.owners,
      facetsLe: objects.facetsLe,
      statusesLe: objects.statusesLe,
    },
    scenario: result.scenario,
  };
}

export function scenarioSummary(
  map: Pick<
    ScenarioDeploymentMap,
    'scenario' | 'objects' | 'appearanceObjectsLe' | 'cliffPiecesLe'
  >,
): {
  objects: number;
  effects: number;
  xsInclude: string | null;
} {
  return {
    objects:
      map.objects.idsLe.byteLength / 4 +
      (map.appearanceObjectsLe?.byteLength ?? 0) / 16 +
      (map.cliffPiecesLe?.byteLength ?? 0) / 20,
    effects: map.scenario.scriptEffects.length,
    xsInclude: map.scenario.xsIncludes[0] ?? null,
  };
}

function bytes(value: unknown, what: string, maximum: number, optional = false): void {
  if (optional && value === undefined) return;
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) {
    throw new Error(`scenario ${what} is invalid`);
  }
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function numbers(value: unknown, length: number, minimum: number, maximum: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => integer(entry, minimum, maximum))
  );
}

export function assertScenarioDeploymentRequest(value: unknown): ScenarioDeploymentRequest {
  const request = value as ScenarioDeploymentRequest | null;
  if (
    !request ||
    typeof request !== 'object' ||
    request.contractVersion?.major !== 1 ||
    !/^[0-9]{3,20}$/u.test(String(request.profileId)) ||
    typeof request.profileId !== 'string' ||
    !text(request.name, 1, maximumScenarioNameLength) ||
    !text(request.scriptName, 1, 260) ||
    typeof request.includeEffects !== 'boolean' ||
    typeof request.replaceExisting !== 'boolean'
  ) {
    throw new Error('scenario deployment request is invalid');
  }
  const map = request.map;
  if (
    !map ||
    typeof map !== 'object' ||
    !text(map.documentUri, 1, 4096) ||
    !integer(map.width, 1, maximumMapSide) ||
    !integer(map.height, 1, maximumMapSide) ||
    !numbers(map.playerColorIds, 9, -1, 255) ||
    (map.playerCivilizationIds !== undefined && !numbers(map.playerCivilizationIds, 9, -1, 1023)) ||
    (map.presentationSeed !== undefined && !integer(map.presentationSeed, -(2 ** 31), 2 ** 32))
  ) {
    throw new Error('scenario map is invalid');
  }
  const tiles = map.width * map.height;
  bytes(map.terrainIdsLe, 'terrain', tiles * 4);
  bytes(map.elevations, 'elevation', tiles * 2);
  bytes(map.layerIdsLe, 'layer', tiles * 2);
  bytes(map.cliffPiecesLe, 'cliff pieces', 20 * tiles * 8, true);
  bytes(map.appearanceObjectsLe, 'appearances', 16 * maximumObjects, true);
  bytes(map.appearanceInstanceIdsLe, 'appearance identities', 4 * maximumObjects, true);
  const objects = map.objects;
  if (!objects || typeof objects !== 'object') throw new Error('scenario objects are invalid');
  bytes(objects.idsLe, 'object IDs', 4 * maximumObjects);
  bytes(objects.xLe, 'object x', 4 * maximumObjects);
  bytes(objects.yLe, 'object y', 4 * maximumObjects);
  bytes(objects.owners, 'object owners', maximumObjects);
  bytes(objects.facetsLe, 'object facets', 2 * maximumObjects);
  bytes(objects.statusesLe, 'object states', 4 * maximumObjects);
  const scenario = map.scenario;
  if (
    !scenario ||
    typeof scenario !== 'object' ||
    !Array.isArray(scenario.objectKinds) ||
    scenario.objectKinds.length > maximumObjectKinds ||
    !scenario.objectKinds.every(
      (kind) =>
        integer(kind?.objectId, 0, 2 ** 31) &&
        integer(kind.facetCount, 1, 0xffff) &&
        typeof kind.randomFacet === 'boolean' &&
        typeof kind.randomAngle === 'boolean',
    ) ||
    !Array.isArray(scenario.scriptEffects) ||
    scenario.scriptEffects.length > maximumScriptEffects ||
    !scenario.scriptEffects.every(
      (effect) =>
        integer(effect?.effect, -(2 ** 31), 2 ** 31) &&
        integer(effect.target, -(2 ** 31), 2 ** 31) &&
        integer(effect.attribute, -(2 ** 31), 2 ** 31) &&
        typeof effect.value === 'number' &&
        Number.isFinite(effect.value) &&
        integer(effect.operationIndex, 0, 2 ** 32),
    ) ||
    !Array.isArray(scenario.xsIncludes) ||
    scenario.xsIncludes.length > 64 ||
    !scenario.xsIncludes.every((name) => text(name, 1, 4096)) ||
    !scenario.setup ||
    !text(scenario.setup.mapSize, 0, 64) ||
    !text(scenario.setup.gameMode, 0, 64) ||
    !integer(scenario.setup.startingAge, 2, 6) ||
    !numbers(scenario.setup.playerTeams, 9, -1, 8)
  ) {
    throw new Error('scenario data is invalid');
  }
  bytes(scenario.objectHeights256Le, 'object heights', 4 * maximumObjects);
  return request;
}
