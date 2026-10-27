import type { XsStartOutcome } from '../../../shared/xs-start';
import { withoutKnownCrashMarker } from '../../../shared/known-crashes';
import { documentName } from '../../../shared/message-catalog';
import {
  refusalLocationFromText,
  withoutRefusalLocationMarker,
} from '../../../shared/refusal-location';
import { sourcePath } from '../diagnostics-store';
import type { CompactMap } from '../app-map-store';
import { ConnectorToolError } from '../dispatcher';
import { fitToCap, pageToCap, round1, shorten, whole } from './budget';
import {
  distance,
  mapObjectKinds,
  neutralShares,
  objectKinds,
  objectName,
  startFacts,
  startKinds,
  startObjectsSummary,
  terrainShares,
  terrainText,
  type ObjectKind,
  type PlayerStartFacts,
} from './map-facts';

export const mapSummaryCaps = Object.freeze({
  generate: 3_000,
  show: 1_000,
  inspect: 5_000,
  details: 6_000,
});

const warningsListed = 5;
const errorsListed = 5;

export interface ScriptError {
  file?: string;
  line?: number;
  msg: string;
}

function xsText(outcome: XsStartOutcome | null): string | undefined {
  if (!outcome) return undefined;
  if (outcome.kind === 'needs-game-folder')
    return 'not checked: link the game folder in AoE2RMSIDE';
  const report = outcome.report;
  const errors = report.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = report.findings.filter((finding) => finding.severity === 'warning').length;
  const findings = `${errors} ${errors === 1 ? 'error' : 'errors'}${
    warnings > 0 ? `, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''
  }`;
  switch (report.status) {
    case 'completed': {
      const changes = report.changes.length + report.omittedChanges;
      return `${changes} ${changes === 1 ? 'change' : 'changes'} at game start, ${findings}`;
    }
    case 'stopped':
      return `stopped${report.stop ? ` (${report.stop.code})` : ''}, ${findings}`;
    case 'skipped-compile-errors': {
      const count = report.compileErrors.reduce((sum, entry) => sum + entry.errors, 0);
      return `not run: ${count} XS compile ${count === 1 ? 'error' : 'errors'}`;
    }
    default:
      return 'not checked: link the game folder in AoE2RMSIDE';
  }
}

function moreAsk(map: CompactMap, facts: readonly PlayerStartFacts[]): string {
  const summary = startObjectsSummary(facts);
  const player =
    summary.differs
      .map((row) => row.per_player.findIndex((count) => count === Math.min(...row.per_player)))
      .find((index) => index >= 0) ?? 0;
  return `inspect_map {map:'${map.id}', player:${facts[player]?.p ?? 1}}`;
}

function startTile(start: [number, number] | null): [number, number] | undefined {
  return start ? [Math.floor(start[0]), Math.floor(start[1])] : undefined;
}

function perPlayerText(counts: readonly number[]): string {
  return counts.join('/');
}

export function compareText(map: CompactMap, earlier: CompactMap): string {
  const parts: string[] = [];
  const now = new Map(terrainShares(map).map((share) => [share.name, share.pct]));
  const before = new Map(terrainShares(earlier).map((share) => [share.name, share.pct]));
  const names = [...new Set([...now.keys(), ...before.keys()])];
  const moved = names
    .map((name) => ({ name, now: now.get(name) ?? 0, before: before.get(name) ?? 0 }))
    .filter((entry) => Math.abs(entry.now - entry.before) >= 2)
    .sort((a, b) => Math.abs(b.now - b.before) - Math.abs(a.now - a.before));
  for (const entry of moved.slice(0, 4)) {
    parts.push(`${entry.name} ${whole(entry.now)}% (was ${whole(entry.before)}%)`);
  }
  const factsNow = startFacts(map);
  const factsBefore = startFacts(earlier);
  for (const kind of startKinds) {
    for (const player of factsNow) {
      const previous = factsBefore.find((entry) => entry.p === player.p);
      if (!previous || !player.start || !previous.start) continue;
      const a = player.kinds[kind]?.n ?? 0;
      const b = previous.kinds[kind]?.n ?? 0;
      if (a !== b) parts.push(`player ${player.p} ${kind} ${a} (was ${b})`);
    }
  }
  const neutralNow = neutralShares(map);
  const neutralBefore = neutralShares(earlier);
  for (const label of new Set([...Object.keys(neutralNow), ...Object.keys(neutralBefore)])) {
    const a = neutralNow[label] ?? [];
    const b = neutralBefore[label] ?? [];
    if (perPlayerText(a) !== perPlayerText(b)) {
      parts.push(`${label} ${perPlayerText(a) || 'none'} (was ${perPlayerText(b) || 'none'})`);
    }
  }
  if (map.warnings.length !== earlier.warnings.length) {
    parts.push(`warnings ${map.warnings.length} (was ${earlier.warnings.length})`);
  }
  if (parts.length === 0) return 'no large differences';
  const shown = parts.slice(0, 8);
  return shorten(
    `${shown.join(', ')}${parts.length > shown.length ? `, ${parts.length - shown.length} more` : ''}`,
    400,
  );
}

export function generateSummary(map: CompactMap, options: { compare?: CompactMap } = {}): string {
  const kinds = mapObjectKinds(map);
  const facts = startFacts(map, kinds);
  const starts = startObjectsSummary(facts);
  const neutral = neutralShares(map, kinds);
  const value: Record<string, unknown> = {
    map: map.id,
    path: map.path ?? map.name,
    seed: map.seed,
    settings: map.settings,
    status: 'ok',
    time_s: round1(map.timeS),
    players: map.players.map((player) => ({
      p: player.p,
      team: player.team,
      start: startTile(player.start),
    })),
    start_objects: {
      same: starts.same || undefined,
      differs: starts.differs,
      ...(starts.more > 0 ? { more_differs: starts.more } : {}),
    },
    neutral: Object.keys(neutral).length > 0 ? neutral : undefined,
    terrain: terrainText(terrainShares(map)),
    warnings: map.warnings.slice(0, warningsListed).map((warning) => ({
      code: warning.code,
      msg: shorten(warning.message, 200),
    })),
    warning_count: map.warnings.length > 0 ? map.warnings.length : undefined,
    xs: xsText(map.xs),
    known_crash: map.knownCrash ?? undefined,
    compare: options.compare ? compareText(map, options.compare) : undefined,
    more: {
      ask: `${moreAsk(map, facts)}${
        map.warnings.length > warningsListed
          ? ` · get_details {id:'${map.id}', part:'warnings'}`
          : ''
      }`,
    },
  };
  return fitToCap(
    value,
    mapSummaryCaps.generate,
    ['warnings', 'players'],
    ['map', 'path', 'seed', 'settings', 'status'],
  );
}

export function showSummary(map: CompactMap, changed: readonly string[]): string {
  return fitToCap(
    {
      map: map.id,
      shown: true,
      seed: map.seed,
      settings: map.settings,
      status: 'ok',
      warnings: map.warnings.length,
      known_crash: map.knownCrash ?? undefined,
      changed_run_settings: [...changed],
      more: { ask: `inspect_map {map:'${map.id}', player:1}` },
    },
    mapSummaryCaps.show,
    ['changed_run_settings'],
    ['map', 'shown', 'seed', 'status'],
  );
}

export function sourceFile(
  sourceId: string,
  relativePath: (absolute: string) => string | null,
): string {
  const absolute = sourcePath(sourceId);
  return ((absolute ? relativePath(absolute) : null) ?? documentName(sourceId)).slice(0, 260);
}

export function failedRunSummary(
  facts: {
    path: string | null;
    name: string;
    seed?: number;
    settings?: string;
    stage: string;
    message: string;
    shown?: boolean;
    fileOf?: (sourceId: string) => string;
  },
  errors: readonly ScriptError[],
  cap: number,
): string {
  const listed = errors.slice(0, errorsListed).map((error) => ({
    ...(error.file ? { file: error.file } : {}),
    ...(error.line ? { line: error.line } : {}),
    msg: shorten(error.msg, 200),
  }));
  const message = withoutRefusalLocationMarker(withoutKnownCrashMarker(facts.message));
  const located = refusalLocationFromText(withoutKnownCrashMarker(facts.message));
  const place = located
    ? {
        file: facts.fileOf?.(located.sourceId) ?? documentName(located.sourceId),
        line: located.line,
      }
    : {};
  const path = facts.path ?? facts.name;
  return fitToCap(
    {
      ...(facts.shown === undefined ? {} : { shown: false }),
      path,
      seed: facts.seed,
      settings: facts.settings,
      status: 'failed',
      stage: facts.stage,
      errors: listed.length > 0 ? listed : [{ ...place, msg: shorten(message, 300) }],
      error_count: errors.length > errorsListed ? errors.length : undefined,
      more: { ask: `get_problems {path:'${path}'}` },
    },
    cap,
    ['errors'],
    ['path', 'status', 'stage'],
  );
}

export interface InspectRequest {
  area?: { x: number; y: number; w: number; h: number };
  player?: number;
  radius: number;
  what: 'objects' | 'terrain' | 'both';
  objects?: readonly string[];
  list: boolean;
  sources: boolean;
  cursor?: unknown;
  limit: number;
}

interface InspectArea {
  label: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  center?: [number, number];
  radius?: number;
}

function inspectArea(map: CompactMap, request: InspectRequest): InspectArea {
  if (request.player !== undefined) {
    const player = map.players.find((entry) => entry.p === request.player);
    if (!player) {
      throw new ConnectorToolError(
        'invalid_arguments',
        `The map has ${map.players.length} ${map.players.length === 1 ? 'player' : 'players'}.`,
      );
    }
    if (!player.start) {
      throw new ConnectorToolError(
        'not_found',
        `Player ${request.player} has no start on this map.`,
        {
          hint: 'Inspect an area instead.',
        },
      );
    }
    const [cx, cy] = player.start;
    return {
      label: `player ${request.player} radius ${request.radius}`,
      minX: Math.max(0, Math.floor(cx - request.radius)),
      minY: Math.max(0, Math.floor(cy - request.radius)),
      maxX: Math.min(map.width - 1, Math.ceil(cx + request.radius)),
      maxY: Math.min(map.height - 1, Math.ceil(cy + request.radius)),
      center: [cx, cy],
      radius: request.radius,
    };
  }
  const area = request.area ?? { x: 0, y: 0, w: map.width, h: map.height };
  if (area.x >= map.width || area.y >= map.height) {
    throw new ConnectorToolError(
      'invalid_arguments',
      `The area starts outside the ${map.width}x${map.height} map.`,
    );
  }
  const maxX = Math.min(map.width - 1, area.x + area.w - 1);
  const maxY = Math.min(map.height - 1, area.y + area.h - 1);
  return {
    label: `${area.x},${area.y} ${maxX - area.x + 1}x${maxY - area.y + 1}`,
    minX: area.x,
    minY: area.y,
    maxX,
    maxY,
  };
}

function insideTile(area: InspectArea, x: number, y: number): boolean {
  if (x < area.minX || x > area.maxX || y < area.minY || y > area.maxY) return false;
  if (!area.center || area.radius === undefined) return true;
  return distance(x + 0.5, y + 0.5, area.center[0], area.center[1]) <= area.radius;
}

function insidePoint(area: InspectArea, x: number, y: number): boolean {
  if (x < area.minX || x >= area.maxX + 1 || y < area.minY || y >= area.maxY + 1) return false;
  if (!area.center || area.radius === undefined) return true;
  return distance(x, y, area.center[0], area.center[1]) <= area.radius;
}

function objectFilter(
  map: CompactMap,
  filter: readonly string[] | undefined,
): ((index: number, kind: ObjectKind | null) => boolean) | undefined {
  if (!filter || filter.length === 0) return undefined;
  const kinds = new Set<string>();
  const names = new Set<string>();
  for (const entry of filter) {
    const lower = entry.trim().toLowerCase();
    const singular = lower.endsWith('s') ? lower.slice(0, -1) : lower;
    const kind = objectKinds.find(
      (candidate) => candidate === lower || candidate === `${singular}s` || candidate === singular,
    );
    if (kind) kinds.add(kind);
    else names.add(lower);
  }
  return (index, kind) =>
    (kind !== null && kinds.has(kind)) ||
    names.has(objectName(map, map.objects.ids[index]!).toLowerCase());
}

export function inspectSummary(map: CompactMap, request: InspectRequest, scope: string): string {
  const area = inspectArea(map, request);
  const value: Record<string, unknown> = { map: map.id, area: area.label };
  let tiles = 0;
  const tileIndices: number[] = [];
  for (let y = area.minY; y <= area.maxY; y += 1) {
    for (let x = area.minX; x <= area.maxX; x += 1) {
      if (!insideTile(area, x, y)) continue;
      tiles += 1;
      tileIndices.push(y * map.width + x);
    }
  }
  value.tiles = tiles;
  if (request.what !== 'objects') {
    const included = new Set(tileIndices);
    value.terrain = terrainText(
      terrainShares(map, (index) => included.has(index)),
      8,
    );
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (const index of tileIndices) {
      const height = map.elevation[index]!;
      minimum = Math.min(minimum, height);
      maximum = Math.max(maximum, height);
      sum += height;
    }
    if (tiles > 0) {
      value.elevation =
        minimum === maximum ? `${minimum}` : `${minimum}-${maximum}, mean ${round1(sum / tiles)}`;
    }
    let cliffs = 0;
    for (let segment = 0; segment * 4 < map.cliffs.length; segment += 1) {
      const x = (map.cliffs[segment * 4]! + map.cliffs[segment * 4 + 2]!) / 2;
      const y = (map.cliffs[segment * 4 + 1]! + map.cliffs[segment * 4 + 3]!) / 2;
      if (insidePoint(area, x, y)) cliffs += 1;
    }
    if (cliffs > 0) value.cliffs = cliffs;
  }
  const trim: string[] = [];
  if (request.what !== 'terrain') {
    const kinds = mapObjectKinds(map);
    const accepts = objectFilter(map, request.objects);
    const selected: number[] = [];
    for (let index = 0; index < map.objects.count; index += 1) {
      if (!insidePoint(area, map.objects.x[index]!, map.objects.y[index]!)) continue;
      if (accepts && !accepts(index, kinds[index] ?? null)) continue;
      selected.push(index);
    }
    const distanceOf = (index: number) =>
      area.center
        ? distance(area.center[0], area.center[1], map.objects.x[index]!, map.objects.y[index]!)
        : undefined;
    const groups = new Map<string, { n: number; nearest?: number }>();
    for (const index of selected) {
      const name = objectName(map, map.objects.ids[index]!);
      const group = groups.get(name) ?? { n: 0 };
      group.n += 1;
      const d = distanceOf(index);
      if (d !== undefined)
        group.nearest = group.nearest === undefined ? d : Math.min(group.nearest, d);
      groups.set(name, group);
    }
    value.objects = [...groups.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
      .map(([name, group]) => ({
        name,
        n: group.n,
        ...(group.nearest === undefined ? {} : { nearest: round1(group.nearest) }),
      }));
    trim.push('objects');
    if (request.sources) {
      const bySource = new Map<number, number>();
      let unknown = 0;
      for (const index of selected) {
        const operation = map.objects.operations[index]!;
        if (operation < 0) unknown += 1;
        else bySource.set(operation, (bySource.get(operation) ?? 0) + 1);
      }
      value.by_source = [...bySource.entries()]
        .map(([operation, n]) => ({ operation: map.operations[operation]!, n }))
        .sort(
          (a, b) =>
            b.n - a.n ||
            (a.operation.file ?? '').localeCompare(b.operation.file ?? '') ||
            (a.operation.line ?? 0) - (b.operation.line ?? 0),
        )
        .map(({ operation, n }) => ({
          ...(operation.file && operation.file !== map.path ? { file: operation.file } : {}),
          ...(operation.line === null ? {} : { line: operation.line }),
          cmd: operation.cmd,
          n,
        }));
      if (unknown > 0) value.without_source = unknown;
      trim.unshift('by_source');
    }
    if (request.list) {
      const ordered = [...selected].sort((a, b) => {
        const da = distanceOf(a);
        const db = distanceOf(b);
        if (da !== undefined && db !== undefined && da !== db) return da - db;
        return (
          map.objects.y[a]! - map.objects.y[b]! || map.objects.x[a]! - map.objects.x[b]! || a - b
        );
      });
      const offsetScope = `${scope}:list`;
      const items = ordered.map((index) => {
        const d = distanceOf(index);
        return {
          name: objectName(map, map.objects.ids[index]!),
          at: [Math.floor(map.objects.x[index]!), Math.floor(map.objects.y[index]!)],
          ...(map.objects.owners[index] ? { owner: map.objects.owners[index] } : {}),
          ...(d === undefined ? {} : { d: round1(d) }),
        };
      });
      const listed = pageToCap(value, items, {
        cap: mapSummaryCaps.inspect,
        limit: request.limit,
        cursor: request.cursor,
        scope: offsetScope,
      });
      const parsed = JSON.parse(listed) as Record<string, unknown>;
      if ('items' in parsed) {
        parsed.list = parsed.items;
        delete parsed.items;
      }
      const more = parsed.more as Record<string, unknown> | undefined;
      if (more && 'items' in more) {
        more.list = more.items;
        delete more.items;
      }
      return fitToCap(
        parsed,
        mapSummaryCaps.inspect,
        ['by_source', 'objects', 'list'],
        ['map', 'area', 'tiles'],
      );
    }
  }
  return fitToCap(value, mapSummaryCaps.inspect, trim, ['map', 'area', 'tiles']);
}

export type MapDetailsPart = 'warnings' | 'players' | 'terrain' | 'xs' | 'objects';

function xsItems(outcome: XsStartOutcome | null): Record<string, unknown>[] {
  if (!outcome) return [];
  if (outcome.kind === 'needs-game-folder') {
    return [{ what: 'status', text: 'not checked: link the game folder in AoE2RMSIDE' }];
  }
  const report = outcome.report;
  const place = (value: { sourceId: string; line: number } | null) =>
    value ? { line: value.line } : {};
  const items: Record<string, unknown>[] = [{ what: 'status', text: xsText(outcome) }];
  for (const finding of report.findings) {
    items.push({
      what: 'finding',
      code: finding.code,
      level: finding.severity,
      text: shorten(finding.message, 200),
      ...place(finding.place),
    });
  }
  if (report.stop) {
    items.push({
      what: 'stop',
      code: report.stop.code,
      text: shorten(report.stop.call || report.stop.function, 200),
      ...place(report.stop.place),
    });
  }
  for (const change of report.changes) {
    items.push({
      what: 'change',
      player: change.player,
      kind: change.kind,
      text: shorten(change.text || change.call, 200),
      ...place(change.place),
    });
  }
  for (const line of report.chatLines) {
    items.push({ what: 'chat', text: shorten(line.text, 200), ...place(line.place) });
  }
  return items;
}

function playerItems(map: CompactMap): Record<string, unknown>[] {
  return startFacts(map).map((player) => ({
    p: player.p,
    team: player.team,
    start: startTile(player.start),
    objects: Object.fromEntries(
      startKinds
        .filter((kind) => player.kinds[kind])
        .map((kind) => {
          const facts = player.kinds[kind]!;
          return [
            kind,
            {
              n: facts.n,
              nearest: facts.nearest === undefined ? undefined : round1(facts.nearest),
              farthest: facts.farthest === undefined ? undefined : round1(facts.farthest),
              piles: facts.piles && facts.piles.length > 1 ? facts.piles : undefined,
            },
          ];
        }),
    ),
  }));
}

function objectItems(map: CompactMap): Record<string, unknown>[] {
  const counts = new Map<string, { n: number; owned: number }>();
  for (let index = 0; index < map.objects.count; index += 1) {
    const name = objectName(map, map.objects.ids[index]!);
    const entry = counts.get(name) ?? { n: 0, owned: 0 };
    entry.n += 1;
    if (map.objects.owners[index]) entry.owned += 1;
    counts.set(name, entry);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .map(([name, entry]) => ({
      name,
      n: entry.n,
      ...(entry.owned > 0 ? { owned: entry.owned } : {}),
    }));
}

export function mapDetails(
  map: CompactMap,
  part: string,
  paging: { cursor?: unknown; limit: number },
): string {
  let items: readonly unknown[];
  switch (part) {
    case 'warnings':
      items = map.warnings.map((warning) => ({
        code: warning.code,
        msg: shorten(warning.message, 400),
        ...(warning.crash ? { known_crash: warning.crash } : {}),
      }));
      break;
    case 'players':
      items = playerItems(map);
      break;
    case 'terrain':
      items = terrainShares(map).map((share) => ({
        name: share.name,
        pct: share.pct,
        tiles: share.tiles,
      }));
      break;
    case 'xs':
      items = xsItems(map.xs);
      break;
    case 'objects':
      items = objectItems(map);
      break;
    default:
      throw new ConnectorToolError(
        'invalid_arguments',
        `A map has the parts warnings, players, terrain, xs and objects, not ${part}.`,
      );
  }
  return pageToCap({ id: map.id, part }, items, {
    cap: mapSummaryCaps.details,
    limit: paging.limit,
    cursor: paging.cursor,
    scope: `${map.id}:${part}`,
  });
}
