import type {
  AppQualityRun,
  AppQualitySetting,
  AppRunContext,
} from '../../shared/connector-run-api';
import { qualityCasesToRun, qualitySettingPlayers } from '../../shared/quality-check';
import { ConnectorToolError } from './dispatcher';
import { parseMapSize, parseTeams } from './run-arguments';

export { qualityCheckOptions } from '../quality-check-options';

export const qualityDefaultSeeds = 50;

export interface QualityArguments {
  seeds?: number;
  firstSeed?: number;
  settings?: readonly { map_size?: string; players?: number; teams?: string }[];
  cases?: readonly string[];
}

export interface QualityPlan {
  run: AppQualityRun;
  freshSeed: boolean;
  maps: number;
}

function resolveSetting(
  entry: { map_size?: string; players?: number; teams?: string },
  context: AppRunContext,
  index: number,
): AppQualitySetting {
  const label = `settings[${index}]`;
  const size =
    entry.map_size === undefined ? undefined : parseMapSize(entry.map_size, `${label}.map_size`);
  const teams =
    entry.teams === undefined
      ? undefined
      : parseTeams(entry.teams, entry.players, `${label}.teams`);
  const count = teams?.players ?? entry.players ?? context.players.length;
  return {
    mapSize: size?.name ?? context.mapSize,
    width: size?.tiles ?? context.width,
    height: size?.tiles ?? context.height,
    players: qualitySettingPlayers(context.players, count, teams?.teams),
    seedCount: 0,
  };
}

export function planQualityCheck(
  args: QualityArguments,
  context: AppRunContext,
  catalogCases: readonly string[],
  maximumMaps: number,
  freshSeed: () => number,
): QualityPlan {
  const seedCount = args.seeds ?? qualityDefaultSeeds;
  const settings = (args.settings ?? []).map((entry, index) =>
    resolveSetting(entry, context, index),
  );
  const maps = seedCount * Math.max(1, settings.length);
  if (maps > maximumMaps) {
    throw new ConnectorToolError(
      'invalid_arguments',
      `This check would generate ${maps} maps; the most is ${maximumMaps} (seeds times settings).`,
      { hint: 'Use fewer seeds or fewer settings.' },
    );
  }
  let cases: string[];
  if (args.cases && args.cases.length > 0) {
    const unknown = args.cases.filter((id) => !catalogCases.includes(id));
    if (unknown.length > 0) {
      throw new ConnectorToolError(
        'invalid_arguments',
        `Unknown quality cases: ${unknown.join(', ')}.`,
        { hint: `Known cases: ${catalogCases.join(', ')}.` },
      );
    }
    cases = qualityCasesToRun(args.cases, catalogCases);
  } else {
    cases = qualityCasesToRun(context.qualityCases ?? catalogCases, catalogCases);
  }
  const fresh = args.firstSeed === undefined;
  return {
    run: {
      caseIds: cases,
      seedStart: fresh ? freshSeed() >>> 0 : args.firstSeed!,
      seedCount,
      settings,
    },
    freshSeed: fresh,
    maps,
  };
}
