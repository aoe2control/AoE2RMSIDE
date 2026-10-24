import type { PreviewLook, PreviewPerspective } from './game-art';
import { validateAppRunSettings, type AppRunSettings } from './connector-run-api';

export const appPictureLimits = Object.freeze({
  path: 4096,
  name: 512,
  label: 200,
});

export type AppPreviewRelief = 'off' | 'terrain' | 'raised' | 'height-map';
export type AppPreviewObjects = 'markers' | 'minimap' | 'off';

export type AppPictureView =
  | { shown: false }
  | {
      shown: true;
      requestHash: string;
      look: PreviewLook;
      perspective: PreviewPerspective;
      relief: AppPreviewRelief;
      objects: AppPreviewObjects;
      camera: { centerX: number; centerY: number; zoom: number };
      viewport: { width: number; height: number; padding: number };
      mapTest: boolean;
    };

export interface AppPictureInputRequest {
  path: string | null;
  settings?: AppRunSettings;
}

export interface AppPictureInputReply {
  input: Record<string, unknown>;
  path: string | null;
  name: string;
  settings: string;
  teams: number[];
}

export const appPictureTextureLimits = Object.freeze({
  maps: 9,
  dimension: 480,
  colors: 1024,
  texelsPerTile: 16,
  texels: 2048 * 2048,
  totalTexels: 2 * 2048 * 2048,
});

export interface AppPictureTexturesMap {
  width: number;
  height: number;
  terrainIds: Uint16Array;
  layerIds: Uint16Array;
  colors: { terrain: number; color: number }[];
  left: number;
  top: number;
  columns: number;
  rows: number;
  texelsPerTile: number;
}

export interface AppPictureTexturesRequest {
  maps: AppPictureTexturesMap[];
}

export type AppPictureTexturesReply =
  { available: false } | { available: true; textures: Uint8Array[] };

const requestHashPattern = /^[0-9a-f]{16,128}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} has the unknown field ${key}`);
  }
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`${label} is not one of ${values.join(', ')}`);
  }
  return value as T;
}

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is not a number from ${minimum} to ${maximum}`);
  }
  return value;
}

function text(value: unknown, minimum: number, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${label} is not text of ${minimum} to ${maximum} characters`);
  }
  return value;
}

function nullablePath(value: unknown, label: string): string | null {
  return value === null ? null : text(value, 1, appPictureLimits.path, label);
}

export function validateAppPictureView(value: unknown): AppPictureView {
  const view = record(value, 'picture view');
  if (view.shown === false) {
    knownKeys(view, ['shown'], 'picture view');
    return { shown: false };
  }
  if (view.shown !== true) throw new Error('picture view shown is not a boolean');
  knownKeys(
    view,
    [
      'shown',
      'requestHash',
      'look',
      'perspective',
      'relief',
      'objects',
      'camera',
      'viewport',
      'mapTest',
    ],
    'picture view',
  );
  if (typeof view.requestHash !== 'string' || !requestHashPattern.test(view.requestHash)) {
    throw new Error('picture view request hash is invalid');
  }
  const camera = record(view.camera, 'picture view camera');
  knownKeys(camera, ['centerX', 'centerY', 'zoom'], 'picture view camera');
  const viewport = record(view.viewport, 'picture view viewport');
  knownKeys(viewport, ['width', 'height', 'padding'], 'picture view viewport');
  if (typeof view.mapTest !== 'boolean') throw new Error('picture view mapTest is not a boolean');
  return {
    shown: true,
    requestHash: view.requestHash,
    look: oneOf(view.look, ['minimap', 'texture-colors', 'game-textures'], 'picture view look'),
    perspective: oneOf(view.perspective, ['top-down', 'diamond'], 'picture view perspective'),
    relief: oneOf(view.relief, ['off', 'terrain', 'raised', 'height-map'], 'picture view relief'),
    objects: oneOf(view.objects, ['markers', 'minimap', 'off'], 'picture view objects'),
    camera: {
      centerX: finite(camera.centerX, -1e6, 1e6, 'picture view camera centerX'),
      centerY: finite(camera.centerY, -1e6, 1e6, 'picture view camera centerY'),
      zoom: finite(camera.zoom, 1e-6, 1e6, 'picture view camera zoom'),
    },
    viewport: {
      width: finite(viewport.width, 0, 100_000, 'picture view viewport width'),
      height: finite(viewport.height, 0, 100_000, 'picture view viewport height'),
      padding: finite(viewport.padding, 0, 10_000, 'picture view viewport padding'),
    },
    mapTest: view.mapTest,
  };
}

export function validateAppPictureInputRequest(value: unknown): AppPictureInputRequest {
  const request = record(value, 'picture input request');
  knownKeys(request, ['path', 'settings'], 'picture input request');
  return {
    path: nullablePath(request.path, 'picture input path'),
    ...(request.settings === undefined
      ? {}
      : { settings: validateAppRunSettings(request.settings, 'picture input settings') }),
  };
}

export function validateAppPictureInputReply(value: unknown): AppPictureInputReply {
  const reply = record(value, 'picture input');
  knownKeys(reply, ['input', 'path', 'name', 'settings', 'teams'], 'picture input');
  const input = record(reply.input, 'picture input generation input');
  if (!Array.isArray(reply.teams) || reply.teams.length < 1 || reply.teams.length > 8) {
    throw new Error('picture input teams is not a list of 1 to 8');
  }
  const teams = reply.teams.map((team, index) => {
    if (!Number.isInteger(team) || (team as number) < 0 || (team as number) > 8) {
      throw new Error(`picture input teams[${index}] is not a team id`);
    }
    return team as number;
  });
  return {
    input,
    path: nullablePath(reply.path, 'picture input path'),
    name: text(reply.name, 1, appPictureLimits.name, 'picture input name'),
    settings: text(reply.settings, 0, appPictureLimits.label, 'picture input settings'),
    teams,
  };
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is not an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function rasterTexels(map: Pick<AppPictureTexturesMap, 'columns' | 'rows' | 'texelsPerTile'>) {
  return map.columns * map.rows * map.texelsPerTile * map.texelsPerTile;
}

export function validateAppPictureTexturesRequest(value: unknown): AppPictureTexturesRequest {
  const request = record(value, 'picture textures request');
  knownKeys(request, ['maps'], 'picture textures request');
  const limits = appPictureTextureLimits;
  if (
    !Array.isArray(request.maps) ||
    request.maps.length < 1 ||
    request.maps.length > limits.maps
  ) {
    throw new Error(`picture textures maps is not a list of 1 to ${limits.maps}`);
  }
  let total = 0;
  const maps = request.maps.map((entry, index): AppPictureTexturesMap => {
    const label = `picture textures maps[${index}]`;
    const map = record(entry, label);
    knownKeys(
      map,
      [
        'width',
        'height',
        'terrainIds',
        'layerIds',
        'colors',
        'left',
        'top',
        'columns',
        'rows',
        'texelsPerTile',
      ],
      label,
    );
    const width = integer(map.width, 1, limits.dimension, `${label} width`);
    const height = integer(map.height, 1, limits.dimension, `${label} height`);
    for (const key of ['terrainIds', 'layerIds'] as const) {
      const column = map[key];
      if (!(column instanceof Uint16Array) || column.length !== width * height) {
        throw new Error(`${label} ${key} is not one 16-bit id per tile`);
      }
    }
    if (!Array.isArray(map.colors) || map.colors.length > limits.colors) {
      throw new Error(`${label} colors is not a list of at most ${limits.colors}`);
    }
    const colors = map.colors.map((color, colorIndex) => {
      const item = record(color, `${label} colors[${colorIndex}]`);
      knownKeys(item, ['terrain', 'color'], `${label} colors[${colorIndex}]`);
      return {
        terrain: integer(item.terrain, 0, 0xffff, `${label} colors[${colorIndex}] terrain`),
        color: integer(item.color, 0, 0xffffff, `${label} colors[${colorIndex}] color`),
      };
    });
    const left = integer(map.left, 0, width - 1, `${label} left`);
    const top = integer(map.top, 0, height - 1, `${label} top`);
    const columns = integer(map.columns, 1, width - left, `${label} columns`);
    const rows = integer(map.rows, 1, height - top, `${label} rows`);
    const texelsPerTile = integer(map.texelsPerTile, 1, limits.texelsPerTile, `${label} texels`);
    const texels = rasterTexels({ columns, rows, texelsPerTile });
    if (texels > limits.texels) throw new Error(`${label} raster is too large`);
    total += texels;
    return {
      width,
      height,
      terrainIds: map.terrainIds as Uint16Array,
      layerIds: map.layerIds as Uint16Array,
      colors,
      left,
      top,
      columns,
      rows,
      texelsPerTile,
    };
  });
  if (total > limits.totalTexels) throw new Error('picture textures rasters are too large');
  return { maps };
}

export function validateAppPictureTexturesReply(
  value: unknown,
  request: AppPictureTexturesRequest,
): AppPictureTexturesReply {
  const reply = record(value, 'picture textures');
  if (reply.available === false) {
    knownKeys(reply, ['available'], 'picture textures');
    return { available: false };
  }
  if (reply.available !== true) throw new Error('picture textures available is not a boolean');
  knownKeys(reply, ['available', 'textures'], 'picture textures');
  if (!Array.isArray(reply.textures) || reply.textures.length !== request.maps.length) {
    throw new Error('picture textures does not answer every map');
  }
  const textures = reply.textures.map((texture: unknown, index) => {
    const expected = rasterTexels(request.maps[index]!) * 4;
    if (!(texture instanceof Uint8Array) || texture.length !== expected) {
      throw new Error(`picture textures[${index}] is not a raster of ${expected} bytes`);
    }
    return texture;
  });
  return { available: true, textures };
}
