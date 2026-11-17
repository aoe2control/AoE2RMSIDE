import type {
  PreviewGenerationResult,
  PreviewScenarioData,
  PreviewScenarioObjectKind,
  PreviewScenarioScriptEffect,
} from '../shared/api';
import { decodeCliffPieceColumn } from '../shared/game-art';
import { decodeAppearanceObjectColumn } from '../shared/terrain-appearances';
import type {
  ScenarioInput,
  ScenarioObject,
  ScenarioPlayer,
  ScenarioTrigger,
} from './scenario-writer';

const activeObjectStatus = 2;
const noLayer = 0xffff;
const fullTurn = Math.PI * 2;

export interface ScenarioSetup {
  scriptName: string;
  seed: number;
  mapSize: string;
  gameMode: string;
  startingAge: number;
  players: Array<{ slot: number; team: number; civilizationId: number; colorIndex: number }>;
  ideVersion: string;
}

export type ScenarioMap = Pick<
  PreviewGenerationResult,
  | 'width'
  | 'height'
  | 'terrainIdsLe'
  | 'elevations'
  | 'layerIdsLe'
  | 'cliffPiecesLe'
  | 'appearanceObjectsLe'
  | 'appearanceInstanceIdsLe'
> & {
  objects: Pick<
    PreviewGenerationResult['objects'],
    'idsLe' | 'xLe' | 'yLe' | 'owners' | 'facetsLe' | 'statusesLe'
  >;
  scenario: PreviewScenarioData;
};

export interface ScenarioBuildOptions {
  includeEffects: boolean;
  fileName: string;
  timestamp: number;
}

function unsigned(bytes: Uint8Array, width: 1 | 2 | 4, count: number, what: string): number[] {
  if (bytes.byteLength !== count * width) throw new Error(`scenario ${what} column is malformed`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, index) =>
    width === 1
      ? view.getUint8(index)
      : width === 2
        ? view.getUint16(index * 2, true)
        : view.getUint32(index * 4, true),
  );
}

function signed(bytes: Uint8Array, width: 2 | 4, count: number, what: string): number[] {
  if (bytes.byteLength !== count * width) throw new Error(`scenario ${what} column is malformed`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, index) =>
    width === 2 ? view.getInt16(index * 2, true) : view.getInt32(index * 4, true),
  );
}

export function scenarioFacing(
  kind: PreviewScenarioObjectKind | undefined,
  facet: number,
): { rotation: number; frame: number } {
  if (kind?.randomAngle) {
    const directions = Math.max(kind.facetCount, 8);
    let angle = (facet * fullTurn) / directions + Math.PI / 4;
    while (angle >= fullTurn) angle -= fullTurn;
    return { rotation: angle, frame: 0 };
  }
  return { rotation: facet, frame: kind?.randomFacet ? facet : 0 };
}

export function appearanceVariant(
  kind: PreviewScenarioObjectKind | undefined,
  seed: number,
): number {
  if (!kind?.randomFacet || kind.facetCount <= 1) return 0;
  return (Math.imul(seed + 1, 0x9e3779b1) >>> 0) % kind.facetCount;
}

function formatNumber(value: number): string {
  const text = Math.fround(value).toString();
  return /[.eE]/u.test(text) ? text : `${text}.0`;
}

export function scriptEffectsXs(
  effects: readonly PreviewScenarioScriptEffect[],
  playerSlots: readonly number[],
  scriptName: string,
): string {
  const owners = [0, ...[...playerSlots].sort((left, right) => left - right)];
  const lines = [
    `// The effect commands of ${scriptName.replace(/[\r\n]/gu, ' ')}, replayed in script order.`,
    'rule rmsideScriptEffects',
    '  active',
    '  runImmediately',
    '  minInterval 1',
    '  priority 100',
    '{',
  ];
  for (const effect of effects) {
    const targets = effect.effect < 0 ? [0] : owners;
    for (const owner of targets) {
      lines.push(
        `  xsEffectAmount(${effect.effect}, ${effect.target}, ${effect.attribute}, ${formatNumber(effect.value)}, ${owner});`,
      );
    }
  }
  lines.push('  xsDisableSelf();', '}');
  return lines.join('\n');
}

export function scenarioSetupFromResult(
  result: Pick<
    PreviewGenerationResult,
    'playerColorIds' | 'playerCivilizationIds' | 'presentationSeed'
  > & {
    scenario: PreviewScenarioData;
  },
  scriptName: string,
  ideVersion: string,
): ScenarioSetup {
  const { setup } = result.scenario;
  const civilizations = result.playerCivilizationIds ?? [];
  const players: ScenarioSetup['players'] = [];
  for (let slot = 1; slot <= 8; slot += 1) {
    const civilizationId = civilizations[slot] ?? -1;
    if (civilizationId < 0) continue;
    players.push({
      slot,
      team: Math.max(0, setup.playerTeams[slot] ?? 0),
      civilizationId,
      colorIndex: result.playerColorIds[slot] ?? slot - 1,
    });
  }
  return {
    scriptName,
    seed: result.presentationSeed ?? 0,
    mapSize: setup.mapSize,
    gameMode: setup.gameMode,
    startingAge: setup.startingAge,
    players,
    ideVersion,
  };
}

export function scenarioInstructions(setup: ScenarioSetup): string {
  return [
    `${setup.scriptName}, seed ${setup.seed}`,
    `Map size: ${setup.mapSize}. Players: ${setup.players.length}. Game mode: ${setup.gameMode}.`,
    `Made with AoE2RMSIDE ${setup.ideVersion}.`,
  ].join('\n');
}

export function scenarioInputFromMap(
  map: ScenarioMap,
  setup: ScenarioSetup,
  options: ScenarioBuildOptions,
): ScenarioInput {
  const { width, height, scenario } = map;
  const tiles = width * height;
  const terrain = unsigned(map.terrainIdsLe, 4, tiles, 'terrain');
  const elevation = signed(map.elevations, 2, tiles, 'elevation');
  const layers = unsigned(map.layerIdsLe, 2, tiles, 'layer');
  if (terrain.some((value) => value > 0xff)) throw new Error('scenario terrain is out of range');
  const kinds = new Map(scenario.objectKinds.map((kind) => [kind.objectId, kind]));
  const tileElevation = (x: number, y: number) =>
    Math.max(
      0,
      elevation[Math.min(height - 1, Math.floor(y)) * width + Math.min(width - 1, Math.floor(x))] ??
        0,
    );

  const objects: ScenarioObject[] = [];
  const count = map.objects.idsLe.byteLength / 4;
  const ids = unsigned(map.objects.idsLe, 4, count, 'object');
  const xs = unsigned(map.objects.xLe, 4, count, 'object x');
  const ys = unsigned(map.objects.yLe, 4, count, 'object y');
  const facets = unsigned(map.objects.facetsLe, 2, count, 'object facet');
  const statuses = signed(map.objects.statusesLe, 4, count, 'object status');
  const heights = signed(scenario.objectHeights256Le, 4, count, 'object height');
  if (map.objects.owners.byteLength !== count)
    throw new Error('scenario object owner column is malformed');
  for (let index = 0; index < count; index += 1) {
    if (statuses[index] !== activeObjectStatus) continue;
    const owner = map.objects.owners[index]!;
    if (owner > 8) continue;
    const objectId = ids[index]!;
    objects.push({
      objectId,
      owner,
      x: xs[index]! / 256,
      y: ys[index]! / 256,
      z: heights[index]! / 256,
      ...scenarioFacing(kinds.get(objectId), facets[index]!),
    });
  }
  const appearances = map.appearanceObjectsLe
    ? (decodeAppearanceObjectColumn(map.appearanceObjectsLe, width, height) ?? [])
    : [];
  const appearanceIds = map.appearanceInstanceIdsLe
    ? signed(map.appearanceInstanceIdsLe, 4, appearances.length, 'appearance instance')
    : null;
  appearances.forEach((appearance, index) => {
    const kind = kinds.get(appearance.objectId);
    const variant = appearanceVariant(kind, appearanceIds?.[index] ?? index);
    objects.push({
      objectId: appearance.objectId,
      owner: 0,
      x: appearance.x,
      y: appearance.y,
      z: tileElevation(appearance.x, appearance.y),
      ...scenarioFacing(kind, variant),
    });
  });
  const pieces = map.cliffPiecesLe
    ? (decodeCliffPieceColumn(map.cliffPiecesLe, width, height) ?? [])
    : [];
  for (const piece of pieces) {
    objects.push({
      objectId: piece.objectId,
      owner: 0,
      x: piece.x,
      y: piece.y,
      z: tileElevation(piece.x, piece.y),
      ...scenarioFacing(kinds.get(piece.objectId), piece.facet),
    });
  }

  const players: ScenarioPlayer[] = setup.players.map((player) => {
    const own = objects.filter((object) => object.owner === player.slot);
    const startX =
      own.length > 0 ? own.reduce((sum, object) => sum + object.x, 0) / own.length : width / 2;
    const startY =
      own.length > 0 ? own.reduce((sum, object) => sum + object.y, 0) / own.length : height / 2;
    return {
      slot: player.slot,
      colorIndex: player.colorIndex,
      team: player.team,
      startX,
      startY,
      food: 0,
      wood: 0,
      gold: 0,
      stone: 0,
      startingAge: setup.startingAge,
      populationCap: 200,
    };
  });

  const triggers: ScenarioTrigger[] =
    options.includeEffects && scenario.scriptEffects.length > 0
      ? [
          {
            name: 'Script effects',
            description:
              'The effect commands of the random map script, replayed once at the start (AoE2RMSIDE).',
            scriptCall: scriptEffectsXs(
              scenario.scriptEffects,
              setup.players.map((player) => player.slot),
              setup.scriptName,
            ),
          },
        ]
      : [];
  const xsInclude = scenario.xsIncludes[0] ?? '';
  return {
    width,
    height,
    terrain: Uint8Array.from(terrain),
    elevation: Uint8Array.from(elevation, (value) => Math.min(0xff, Math.max(0, value))),
    layer: Int16Array.from(layers, (value, tile) =>
      value === noLayer || value === terrain[tile] || value > 0x7fff ? -1 : value,
    ),
    players,
    objects,
    instructions: scenarioInstructions(setup),
    fileName: options.fileName,
    creator: 'AoE2RMSIDE',
    xsScriptName: xsInclude.replace(/^.*[\\/]/u, '').replace(/\.xs$/iu, ''),
    triggers,
    timestamp: options.timestamp,
  };
}
