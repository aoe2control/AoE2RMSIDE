import type { AppPictureView } from '../../shared/connector-picture-api';
import {
  pictureContract,
  pictureLookForPreviewLook,
  type PictureCell,
  type PictureLook,
  type PictureMark,
  type PictureObjects,
  type PicturePerspective,
  type PictureRegion,
  type PictureRelief,
  type PictureRequest,
} from '../pictures/picture-contract';
import type { PictureMap } from '../pictures/picture-map';
import { ConnectorToolError } from './dispatcher';
import type { ConnectorJsonValue, ConnectorToolArguments } from './validator';

export type PictureView = 'whole' | 'area' | 'base' | 'bases' | 'compare' | 'as_shown';

export type PictureLookWord = 'texture' | 'minimap' | 'preview';

export interface PictureOptions {
  view: PictureView;
  area?: { x: number; y: number; w: number; h: number };
  player?: number;
  radius: number;
  look: PictureLook;
  objects: PictureObjects;
  relief: boolean;
  perspective: PicturePerspective;
  grid: boolean;
  players: boolean;
  findings: boolean;
  second?: { look?: PictureLook; perspective?: PicturePerspective };
  size: number;
}

export function pictureLookFromWord(word: string | undefined): PictureLook {
  if (word === 'minimap') return 'minimap';
  return word === 'preview' ? 'terrain-textures' : 'texture-colors';
}

export function pictureLookWord(look: PictureLook): PictureLookWord {
  if (look === 'minimap') return 'minimap';
  return look === 'terrain-textures' ? 'preview' : 'texture';
}

function invalid(message: string, hint?: string): ConnectorToolError {
  return new ConnectorToolError('invalid_arguments', message, hint ? { hint } : {});
}

function perspectiveOf(value: ConnectorJsonValue | undefined): PicturePerspective | undefined {
  return value === 'grid' || value === 'top_down' || value === 'diamond' ? value : undefined;
}

function record(value: ConnectorJsonValue | undefined): ConnectorToolArguments | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ConnectorToolArguments)
    : undefined;
}

export function parsePictureOptions(args: ConnectorToolArguments): PictureOptions {
  const view = args.view as PictureView;
  const area = record(args.area) as PictureOptions['area'] | undefined;
  const player = typeof args.player === 'number' ? args.player : undefined;
  const overlays = Array.isArray(args.overlays) ? (args.overlays as string[]) : [];
  const compare = record(args.compare);
  const options: PictureOptions = {
    view,
    ...(area ? { area } : {}),
    ...(player === undefined ? {} : { player }),
    radius: typeof args.radius === 'number' ? args.radius : 20,
    look: pictureLookFromWord(typeof args.look === 'string' ? args.look : undefined),
    objects: (args.objects as PictureObjects | undefined) ?? 'markers',
    relief: args.relief !== false,
    perspective: perspectiveOf(args.perspective) ?? 'grid',
    grid: overlays.includes('grid'),
    players: overlays.includes('players'),
    findings: overlays.includes('findings') || args.findings_of !== undefined,
    size: typeof args.size === 'number' ? args.size : 768,
  };
  if (compare) {
    const look = typeof compare.look === 'string' ? pictureLookFromWord(compare.look) : undefined;
    const perspective = perspectiveOf(compare.perspective);
    if (look === undefined && perspective === undefined) {
      throw invalid(
        'compare needs a look or a perspective for the second picture.',
        "Use compare {look:'minimap'} or compare {perspective:'diamond'}.",
      );
    }
    if (view === 'bases' || view === 'compare') {
      throw invalid(
        `compare puts a second picture beside one view; view ${view} already shows several.`,
        'Use compare with view whole, area, base or as_shown.',
      );
    }
    options.second = {
      ...(look === undefined ? {} : { look }),
      ...(perspective === undefined ? {} : { perspective }),
    };
  }
  if (view === 'as_shown') {
    for (const key of ['map', 'area', 'player', 'compare_to', 'findings_of'] as const) {
      if (args[key] !== undefined) {
        throw invalid(
          `view as_shown pictures the IDE preview as the user sees it; leave out ${key}.`,
        );
      }
    }
    return options;
  }
  if (view === 'area' && !area) throw invalid('view area needs area {x, y, w, h}.');
  if (view === 'base' && player === undefined) throw invalid('view base needs player.');
  if (view === 'compare' && args.compare_to === undefined) {
    throw invalid('view compare needs compare_to, the id of the other map.');
  }
  if (view !== 'compare' && args.compare_to !== undefined) {
    throw invalid('compare_to belongs to view compare.');
  }
  if (area && player !== undefined) throw invalid('Give area or player, not both.');
  if (overlays.includes('findings') && args.findings_of === undefined) {
    throw invalid('The findings overlay needs findings_of {run}.');
  }
  return options;
}

function regionFor(options: PictureOptions, map: PictureMap, id: string): PictureRegion {
  const view = options.view === 'compare' ? null : options.view;
  if (options.area && (view === 'area' || view === null)) {
    const { x, y, w, h } = options.area;
    if (x >= map.width || y >= map.height) {
      throw invalid(`The area starts outside ${id}, which is ${map.width}x${map.height} tiles.`);
    }
    return { kind: 'tiles', x, y, w, h };
  }
  if (options.player !== undefined && (view === 'base' || view === null)) {
    if (!map.players.some((entry) => entry.owner === options.player)) {
      throw invalid(`Player ${options.player} has no start on ${id}.`, playersHint(map));
    }
    return { kind: 'base', player: options.player, radius: options.radius };
  }
  return { kind: 'whole' };
}

function playersHint(map: PictureMap): string {
  const owners = map.players.map((entry) => entry.owner);
  return owners.length === 0
    ? 'This map has no player starts.'
    : `Players with a start: ${owners.join(', ')}.`;
}

function relief(options: Pick<PictureOptions, 'relief'>): PictureRelief {
  return options.relief ? 'raised' : 'off';
}

function caption(text: string): string {
  return text.slice(0, pictureContract.maximumCaptionLength);
}

function withSecond(cells: PictureCell[], options: PictureOptions): PictureCell[] {
  if (!options.second || cells.length !== 1) return cells;
  const first = cells[0]!;
  const look = first.look ?? options.look;
  const perspective = first.perspective ?? options.perspective;
  const second: PictureCell = {
    ...first,
    look: options.second.look ?? look,
    perspective: options.second.perspective ?? perspective,
  };
  if (second.look === look && second.perspective === perspective) {
    throw invalid(
      'compare names the look and perspective the first picture already has.',
      'Name another look or perspective in compare.',
    );
  }
  return [{ ...first, look, perspective }, second];
}

export interface PictureSubject {
  id: string;
  map: PictureMap;
}

export function appPictureRequest(
  options: PictureOptions,
  subjects: readonly PictureSubject[],
  marks: readonly PictureMark[] = [],
): PictureRequest {
  const first = subjects[0]!;
  let cells: PictureCell[];
  switch (options.view) {
    case 'bases': {
      const owners = first.map.players.map((entry) => entry.owner);
      if (owners.length === 0) throw invalid(`${first.id} has no player starts.`);
      cells = owners.slice(0, 8).map((owner) => ({
        map: 0,
        region: { kind: 'base', player: owner, radius: options.radius },
      }));
      break;
    }
    case 'compare': {
      const second = subjects[1]!;
      cells = [
        { map: 0, region: regionFor(options, first.map, first.id), caption: caption(first.id) },
        { map: 1, region: regionFor(options, second.map, second.id), caption: caption(second.id) },
      ];
      break;
    }
    default:
      cells = withSecond([{ map: 0, region: regionFor(options, first.map, first.id) }], options);
  }
  return {
    contractVersion: pictureContract.version,
    maps: subjects.map((subject) => subject.map),
    cells,
    look: options.look,
    perspective: options.perspective,
    objects: options.objects,
    relief: relief(options),
    overlays: {
      grid: options.grid,
      players: options.players,
      ...(marks.length > 0 ? { marks: marks.slice(0, pictureContract.maximumMarks) } : {}),
    },
    maxSide: options.size,
  };
}

export interface ShownPictureSettings {
  look: PictureLook;
  perspective: PicturePerspective;
  relief: PictureRelief;
  objects: PictureObjects;
  region: PictureRegion;
}

export function shownPictureSettings(
  view: Extract<AppPictureView, { shown: true }>,
  map: Pick<PictureMap, 'width' | 'height'>,
): ShownPictureSettings {
  const look = pictureLookForPreviewLook(view.look);
  const perspective: PicturePerspective = view.perspective === 'diamond' ? 'diamond' : 'top_down';
  const relief: PictureRelief =
    view.relief === 'off' ? 'off' : view.relief === 'raised' ? 'raised' : 'shaded';
  const objects: PictureObjects = view.objects === 'off' ? 'none' : view.objects;
  const { camera, viewport } = view;
  const framed =
    viewport.width >= 16 &&
    viewport.height >= 16 &&
    viewport.width <= 16_384 &&
    viewport.height <= 16_384 &&
    viewport.padding <= 1024 &&
    camera.zoom >= 0.05 &&
    camera.zoom <= 64 &&
    camera.centerX >= -map.width &&
    camera.centerX <= 2 * map.width &&
    camera.centerY >= -map.height &&
    camera.centerY <= 2 * map.height;
  const region: PictureRegion = framed
    ? {
        kind: 'camera',
        centerX: camera.centerX,
        centerY: camera.centerY,
        zoom: camera.zoom,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        padding: viewport.padding,
      }
    : { kind: 'whole' };
  return { look, perspective, relief, objects, region };
}

export function shownPictureRequest(
  settings: ShownPictureSettings,
  map: PictureMap,
  options: Pick<PictureOptions, 'second' | 'size'>,
): PictureRequest {
  const cells = withSecond(
    [
      {
        map: 0,
        region: settings.region,
        look: settings.look,
        perspective: settings.perspective,
      },
    ],
    {
      view: 'as_shown',
      radius: 20,
      look: settings.look,
      objects: settings.objects,
      relief: settings.relief !== 'off',
      perspective: settings.perspective,
      grid: false,
      players: false,
      findings: false,
      size: options.size,
      ...(options.second ? { second: options.second } : {}),
    },
  );
  return {
    contractVersion: pictureContract.version,
    maps: [map],
    cells,
    look: settings.look,
    perspective: settings.perspective,
    objects: settings.objects,
    relief: settings.relief,
    maxSide: options.size,
  };
}

export function sheetPictureRequest(
  maps: readonly { id: string; seed: number; map: PictureMap }[],
  options: { look: PictureLook; perspective: PicturePerspective; size: number },
): PictureRequest {
  return {
    contractVersion: pictureContract.version,
    maps: maps.map((entry) => entry.map),
    cells: maps.map((entry, index) => ({
      map: index,
      region: { kind: 'whole' },
      caption: caption(`${entry.id} ${entry.seed}`),
    })),
    look: options.look,
    perspective: options.perspective,
    objects: 'markers',
    relief: 'raised',
    overlays: { players: true },
    maxSide: options.size,
  };
}
