import {
  isMapIconArtDensity,
  isMapIconArtSize,
  isMapIconSpawnMarkerSizePercent,
  isMapIconSpawnMarkerStyle,
  mapIconGameTexturesSourcePattern,
  mapIconPerspectives,
  mapIconRenderContract,
  mapIconRenderLooks,
  type MapIconPerspective,
  type MapIconRenderLook,
  type GeneratedMapIconSaveRequest,
  type ManualDeploymentMapIconMode,
  type ManualDeploymentMapIconRequest,
} from './api';

export const manualDeploymentMapIconModes: readonly ManualDeploymentMapIconMode[] = [
  'none',
  'retain-original',
  'generate',
];

export const mapIconRenderPixelBytes = mapIconRenderContract.size * mapIconRenderContract.size * 4;

const lowercaseSha256Pattern = /^[0-9a-f]{64}$/u;

export function validateManualDeploymentMapIconRequest(
  value: unknown,
): ManualDeploymentMapIconRequest {
  if (!isPlainRecord(value)) throw new Error('map icon option is invalid');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'mode' && key !== 'render')) {
    throw new Error('map icon option is invalid');
  }
  const mode = value.mode;
  if (!manualDeploymentMapIconModes.includes(mode as ManualDeploymentMapIconMode)) {
    throw new Error('map icon option mode is invalid');
  }
  if (mode !== 'generate') {
    if (value.render !== undefined) {
      throw new Error('map icon pixels are only accepted when generating an icon');
    }
    return Object.freeze({ mode: mode as ManualDeploymentMapIconMode });
  }
  const render = value.render;
  if (!isPlainRecord(render)) throw new Error('generated map icon render is missing');
  if (
    Object.keys(render).some(
      (key) =>
        key !== 'contractVersion' &&
        key !== 'perspective' &&
        key !== 'look' &&
        key !== 'relief' &&
        key !== 'terrainSmoothing' &&
        key !== 'spawnMarkers' &&
        key !== 'spawnMarkerSizePercent' &&
        key !== 'trees' &&
        key !== 'treeDensity' &&
        key !== 'treeSize' &&
        key !== 'treeSpawnOverlap' &&
        key !== 'resources' &&
        key !== 'resourceDensity' &&
        key !== 'resourceSize' &&
        key !== 'resourceSpawnOverlap' &&
        key !== 'sourceSemanticHash' &&
        key !== 'gameTexturesSource' &&
        key !== 'identity' &&
        key !== 'pixels',
    )
  ) {
    throw new Error('generated map icon render is invalid');
  }
  if (render.contractVersion !== mapIconRenderContract.version) {
    throw new Error('generated map icon render contract version is unsupported');
  }
  if (!mapIconPerspectives.includes(render.perspective as MapIconPerspective)) {
    throw new Error('generated map icon perspective is invalid');
  }
  if (!mapIconRenderLooks.includes(render.look as MapIconRenderLook)) {
    throw new Error('generated map icon look is invalid');
  }
  if (
    render.look === 'game-textures'
      ? typeof render.gameTexturesSource !== 'string' ||
        !mapIconGameTexturesSourcePattern.test(render.gameTexturesSource)
      : render.gameTexturesSource !== undefined
  ) {
    throw new Error('generated map icon game textures source is invalid');
  }
  if (typeof render.relief !== 'boolean') {
    throw new Error('generated map icon relief choice is invalid');
  }
  if (typeof render.terrainSmoothing !== 'boolean') {
    throw new Error('generated map icon terrain smoothing choice is invalid');
  }
  if (!isMapIconSpawnMarkerStyle(render.spawnMarkers)) {
    throw new Error('generated map icon spawn marker choice is invalid');
  }
  if (!isMapIconSpawnMarkerSizePercent(render.spawnMarkerSizePercent)) {
    throw new Error('generated map icon spawn marker size is invalid');
  }
  for (const key of ['trees', 'treeSpawnOverlap', 'resources', 'resourceSpawnOverlap'] as const) {
    if (typeof render[key] !== 'boolean') {
      throw new Error(`generated map icon ${key} choice is invalid`);
    }
  }
  for (const key of ['treeDensity', 'resourceDensity'] as const) {
    if (!isMapIconArtDensity(render[key])) {
      throw new Error(`generated map icon ${key} is invalid`);
    }
  }
  for (const key of ['treeSize', 'resourceSize'] as const) {
    if (!isMapIconArtSize(render[key])) {
      throw new Error(`generated map icon ${key} is invalid`);
    }
  }
  if (
    typeof render.sourceSemanticHash !== 'string' ||
    !lowercaseSha256Pattern.test(render.sourceSemanticHash) ||
    typeof render.identity !== 'string' ||
    !lowercaseSha256Pattern.test(render.identity)
  ) {
    throw new Error('generated map icon identity is invalid');
  }
  const pixels = render.pixels;
  const tag = Object.prototype.toString.call(pixels);
  if (
    (tag !== '[object Uint8ClampedArray]' && tag !== '[object Uint8Array]') ||
    (pixels as Uint8Array).byteLength !== mapIconRenderPixelBytes ||
    (pixels as Uint8Array).length !== mapIconRenderPixelBytes
  ) {
    throw new Error(`generated map icon pixels must be ${mapIconRenderPixelBytes} RGBA bytes`);
  }
  return Object.freeze({
    mode: 'generate',
    render: Object.freeze({
      contractVersion: mapIconRenderContract.version,
      perspective: render.perspective as MapIconPerspective,
      look: render.look as MapIconRenderLook,
      relief: render.relief,
      terrainSmoothing: render.terrainSmoothing,
      spawnMarkers: render.spawnMarkers,
      spawnMarkerSizePercent: render.spawnMarkerSizePercent,
      trees: render.trees as boolean,
      treeDensity: render.treeDensity as number,
      treeSize: render.treeSize as number,
      treeSpawnOverlap: render.treeSpawnOverlap as boolean,
      resources: render.resources as boolean,
      resourceDensity: render.resourceDensity as number,
      resourceSize: render.resourceSize as number,
      resourceSpawnOverlap: render.resourceSpawnOverlap as boolean,
      sourceSemanticHash: render.sourceSemanticHash,
      ...(render.look === 'game-textures'
        ? { gameTexturesSource: render.gameTexturesSource as string }
        : {}),
      identity: render.identity,
      pixels: new Uint8ClampedArray(pixels as Uint8ClampedArray),
    }),
  });
}

const generatedSaveKeys = [
  'documentRevision',
  'documentUri',
  'externalAssetHash',
  'render',
  'sourceCatalogHash',
  'sourceCatalogRevision',
  'sourceGraphHash',
].join(',');

export function validateGeneratedMapIconSaveRequest(value: unknown): GeneratedMapIconSaveRequest {
  if (!isPlainRecord(value) || Object.keys(value).sort().join(',') !== generatedSaveKeys) {
    throw new Error('map icon save request is invalid');
  }
  if (
    typeof value.documentUri !== 'string' ||
    value.documentUri.length < 1 ||
    value.documentUri.length > 4096 ||
    !Number.isSafeInteger(value.documentRevision) ||
    (value.documentRevision as number) < 0 ||
    !Number.isSafeInteger(value.sourceCatalogRevision) ||
    (value.sourceCatalogRevision as number) < 0 ||
    [value.sourceCatalogHash, value.sourceGraphHash, value.externalAssetHash].some(
      (hash) => typeof hash !== 'string' || !lowercaseSha256Pattern.test(hash),
    )
  ) {
    throw new Error('map icon save identity is invalid');
  }
  const { render } = validateManualDeploymentMapIconRequest({
    mode: 'generate',
    render: value.render,
  });
  return Object.freeze({
    documentUri: value.documentUri,
    documentRevision: value.documentRevision as number,
    sourceCatalogRevision: value.sourceCatalogRevision as number,
    sourceCatalogHash: value.sourceCatalogHash as string,
    sourceGraphHash: value.sourceGraphHash as string,
    externalAssetHash: value.externalAssetHash as string,
    render: render!,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
