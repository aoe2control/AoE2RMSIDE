import { randomUUID } from 'node:crypto';
import type {
  MapTestRunResult,
  PreviewGenerationResult,
  RootExecutionState,
} from '../../../shared/api';
import type { ConnectorOutputFacts } from '../../../shared/connector-api';
import {
  validateAppPictureInputReply,
  validateAppPictureView,
  type AppPictureInputReply,
  type AppPictureView,
} from '../../../shared/connector-picture-api';
import {
  PictureError,
  type PictureLook,
  type PictureMark,
  type PicturePerspective,
  type PictureRequest,
  type PictureResult,
} from '../../pictures/picture-contract';
import { pictureMapFormat, type PictureMap } from '../../pictures/picture-map';
import { compactMapFromResult, type CompactMap, type CompactSource } from '../app-map-store';
import {
  ConnectorToolError,
  connectorJsonText,
  connectorTextResult,
  type ConnectorContent,
  type ConnectorToolContext,
  type ConnectorToolRegistry,
  type ConnectorToolResult,
} from '../dispatcher';
import { appExecutionLabel, busyError, type AppLane } from '../lane';
import {
  appPictureRequest,
  parsePictureOptions,
  pictureLookFromWord,
  pictureLookWord,
  sheetPictureRequest,
  shownPictureRequest,
  shownPictureSettings,
  type PictureOptions,
  type PictureSubject,
} from '../picture-layout';
import { resolvePictureTextures, type PictureTexturesOutcome } from '../picture-textures';
import { parseRunSettings, unsignedSeed, waitMilliseconds } from '../run-arguments';
import {
  expired,
  runningAnswer,
  type RegisteredRun,
  type RunContext,
  type RunRegistry,
} from '../run-registry';
import { startFacts, startObjectsSummary } from '../summaries/map-facts';
import { shorten } from '../summaries/budget';
import type { ConnectorToolArguments } from '../validator';
import { codePoints } from '../validator';
import { connectionMaps, connectionRuns, type ResolvedScript, type RunDetails } from './run-tools';

export const pictureToolCaps = Object.freeze({ text: 1_500 });

export const pictureLookNotes = Object.freeze({
  shown: "Terrain shows the preview's textures, so blending can be judged.",
  unavailable: "The preview's look is not available here, so this picture uses Texture colors.",
  shownUnavailable:
    "The preview's look is not available to pictures, so this picture uses Texture colors.",
});
export const contactSheetSeeds = Object.freeze({ minimum: 2, maximum: 9 });
const viewTimeoutMilliseconds = 5_000;
const inputTimeoutMilliseconds = 15_000;
const seedRange = 0x1_0000_0000;

export interface PictureSheetHost {
  withLease<T>(
    label: string,
    app: string,
    stop: () => Promise<void>,
    work: () => Promise<T>,
  ): Promise<T>;
  generate(
    input: Record<string, unknown>,
    seed: number,
    clientRequestId: string,
  ): Promise<PreviewGenerationResult>;
  cancel(clientRequestId: string): Promise<void>;
  stopAutomatic(): void;
}

export interface PictureToolDependencies {
  pictures: { render(request: PictureRequest, signal?: AbortSignal): Promise<PictureResult> };
  savePicture(png: Uint8Array): Promise<string>;
  bridge: {
    request(
      kind: 'pictureView' | 'pictureInput' | 'pictureTextures',
      payload: unknown,
      options: { timeoutMilliseconds: number; signal?: AbortSignal },
    ): Promise<unknown>;
  };
  lane: AppLane;
  leaseState(): RootExecutionState;
  sheets: PictureSheetHost;
  shownMap(requestHash: string): PictureMap | undefined;
  resolveScript(path: string, kind: 'map'): Promise<ResolvedScript>;
  relativePath(absolute: string): string | null;
  source(sourceId: string): CompactSource;
  pictureMap(result: PreviewGenerationResult): PictureMap;
  now(): number;
}

function invalid(message: string, hint?: string): ConnectorToolError {
  return new ConnectorToolError('invalid_arguments', message, hint ? { hint } : {});
}

function mapExpired(id: string): ConnectorToolError {
  return new ConnectorToolError('map_expired', `${id} is no longer available.`, {
    hint: 'Generate the map again; AoE2RMSIDE keeps the last 6 maps of a connection and the latest contact sheet.',
  });
}

function internalError(message = 'Something went wrong in AoE2RMSIDE.'): ConnectorToolError {
  return new ConnectorToolError('internal', message, {
    hint: 'Try again; if it keeps failing, ask the user to look at the Output in AoE2RMSIDE.',
  });
}

function pictureFailure(error: unknown): ConnectorToolError {
  if (error instanceof ConnectorToolError) return error;
  if (!(error instanceof PictureError)) return internalError('The picture could not be drawn.');
  switch (error.code) {
    case 'invalid-request':
      return invalid(`The picture cannot be drawn: ${error.message}.`);
    case 'busy':
      return new ConnectorToolError('busy', 'AoE2RMSIDE is drawing other pictures.', {
        hint: 'Try again in a moment.',
        retryAfterSeconds: 2,
      });
    case 'cancelled':
      return new ConnectorToolError('cancelled', 'The call was cancelled.');
    case 'too-large':
      return new ConnectorToolError('too_large', 'The picture does not fit the image size limit.', {
        hint: 'Ask for a smaller size or a smaller area.',
      });
    case 'timeout':
      return internalError('The picture took too long to draw.');
    default:
      return internalError('The picture could not be drawn.');
  }
}

function drawnLook(look: PictureLook, outcome: PictureTexturesOutcome): PictureLook {
  return outcome === 'unavailable' && look === 'terrain-textures' ? 'texture-colors' : look;
}

function drawnSecond(
  second: PictureOptions['second'],
  outcome: PictureTexturesOutcome,
): PictureOptions['second'] {
  return second?.look ? { ...second, look: drawnLook(second.look, outcome) } : second;
}

function lookNote(outcome: PictureTexturesOutcome, shownView: boolean): string | undefined {
  if (outcome === 'shown') return pictureLookNotes.shown;
  if (outcome === 'unavailable') {
    return shownView ? pictureLookNotes.shownUnavailable : pictureLookNotes.unavailable;
  }
  return undefined;
}

function isPictureMap(value: unknown): value is PictureMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { format?: unknown }).format === pictureMapFormat
  );
}

function stringArgument(args: ConnectorToolArguments, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function integerArgument(args: ConnectorToolArguments, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export function pictureText(
  value: Record<string, unknown>,
  cap: number = pictureToolCaps.text,
): string {
  const copy: Record<string, unknown> = { ...value };
  let text = connectorJsonText(copy);
  for (const key of ['shows', 'note']) {
    if (codePoints(text) <= cap) break;
    if (typeof copy[key] !== 'string') continue;
    const over = codePoints(text) - cap;
    const current = copy[key] as string;
    const kept = [...current].length - over - 1;
    if (kept >= 40) copy[key] = shorten(current, kept);
    else delete copy[key];
    text = connectorJsonText(copy);
  }
  return text;
}

export function sheetSeeds(args: ConnectorToolArguments): number[] {
  if (Array.isArray(args.seeds)) {
    const seeds = (args.seeds as number[]).map((seed) => unsignedSeed(seed));
    if (new Set(seeds).size !== seeds.length) {
      throw invalid('seeds names one seed twice (a signed seed is the same as its unsigned form).');
    }
    if (seeds.length < contactSheetSeeds.minimum || seeds.length > contactSheetSeeds.maximum) {
      throw invalid(
        `A contact sheet has ${contactSheetSeeds.minimum} to ${contactSheetSeeds.maximum} seeds.`,
      );
    }
    return seeds;
  }
  const count = integerArgument(args, 'count') ?? 6;
  if (count < contactSheetSeeds.minimum || count > contactSheetSeeds.maximum) {
    throw invalid(
      `A contact sheet has ${contactSheetSeeds.minimum} to ${contactSheetSeeds.maximum} seeds.`,
    );
  }
  const first = unsignedSeed(integerArgument(args, 'first_seed') ?? 1);
  return Array.from({ length: count }, (_, index) => (first + index) % seedRange);
}

export function findingMarks(
  result: MapTestRunResult,
  options: { seed: number; caseId?: string; map: Pick<PictureMap, 'width' | 'height'> },
): PictureMark[] {
  const report = result.report;
  if (!report) return [];
  const marks: PictureMark[] = [];
  const inside = (x: number, y: number) =>
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x <= options.map.width &&
    y <= options.map.height;
  const seen = new Set<string>();
  const add = (x: number, y: number, kind: PictureMark['kind']) => {
    const key = `${x},${y}`;
    if (!inside(x, y) || seen.has(key)) return;
    seen.add(key);
    marks.push({ map: 0, x, y, kind });
  };
  for (const item of report.quality?.items ?? []) {
    if (options.caseId !== undefined && item.case !== options.caseId) continue;
    for (const worst of item.worst) {
      if (worst.seed !== options.seed || !worst.tile) continue;
      add(worst.tile[0] + 0.5, worst.tile[1] + 0.5, item.level === 'failure' ? 'error' : 'warning');
    }
  }
  for (const finding of report.findings) {
    if (finding.seed !== options.seed) continue;
    if (options.caseId !== undefined && !(finding.code ?? '').startsWith(`${options.caseId}/`)) {
      continue;
    }
    const { x, y } = finding.measurements;
    if (typeof x === 'number' && typeof y === 'number') add(x, y, 'error');
  }
  return marks.slice(0, 256);
}

interface SheetSeed {
  id: string;
  seed: number;
  map?: CompactMap;
}

function seedNote(map: CompactMap): string | undefined {
  const differs = startObjectsSummary(startFacts(map)).differs[0];
  if (differs)
    return shorten(differs.note ?? `${differs.what} ${differs.per_player.join('/')}`, 90);
  const warning = map.warnings[0];
  return warning ? shorten(`${warning.code}: ${warning.message}`, 90) : undefined;
}

function sheetDetails(sheet: string, seeds: readonly SheetSeed[], part: string): string {
  if (part === 'warnings') {
    return pictureText(
      {
        sheet,
        seeds: seeds.map((entry) =>
          entry.map
            ? {
                id: entry.id,
                seed: entry.seed,
                warnings: entry.map.warnings.length,
                first: entry.map.warnings
                  .slice(0, 3)
                  .map((warning) => shorten(`${warning.code}: ${warning.message}`, 120)),
              }
            : { seed: entry.seed, status: 'failed' },
        ),
      },
      6_000,
    );
  }
  if (part === 'players') {
    return pictureText(
      {
        sheet,
        seeds: seeds.map((entry) =>
          entry.map
            ? {
                id: entry.id,
                seed: entry.seed,
                starts: entry.map.players.map((player) =>
                  player.start ? [Math.floor(player.start[0]), Math.floor(player.start[1])] : null,
                ),
                differs: startObjectsSummary(startFacts(entry.map)).differs.slice(0, 3),
              }
            : { seed: entry.seed, status: 'failed' },
        ),
      },
      6_000,
    );
  }
  const first = seeds.find((entry) => entry.map)?.id ?? `${sheet}.1`;
  throw invalid(
    `A contact sheet answers the parts warnings and players.`,
    `For one seed's map, use get_details {id:'${first}', part:'${part}'}.`,
  );
}

export class PictureTools {
  constructor(private readonly deps: PictureToolDependencies) {}

  private runs(context: ConnectorToolContext): RunRegistry {
    return connectionRuns(context, () => this.deps.now());
  }

  async picture(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const options = parsePictureOptions(args);
    if (options.view === 'as_shown') return this.shownPicture(options, args.save === true, context);
    const maps = connectionMaps(context);
    const id = stringArgument(args, 'map');
    const map = id === undefined ? maps.latest() : maps.get(id);
    if (!map) {
      if (id !== undefined) throw mapExpired(id);
      throw new ConnectorToolError('not_found', 'You have no generated map yet.', {
        hint: 'Call generate_map first, or get_picture view as_shown for the map in the preview.',
      });
    }
    const subjects: PictureSubject[] = [this.subject(map)];
    if (options.view === 'compare') {
      const otherId = stringArgument(args, 'compare_to')!;
      const other = maps.get(otherId);
      if (!other) throw mapExpired(otherId);
      subjects.push(this.subject(other));
    }
    const notes: string[] = [];
    let marks: PictureMark[] = [];
    if (args.findings_of !== undefined) {
      const found = this.marks(
        args.findings_of as ConnectorToolArguments,
        map,
        subjects[0]!.map,
        context,
      );
      marks = found.marks;
      if (found.note) notes.push(found.note);
    }
    let request: PictureRequest;
    try {
      request = appPictureRequest(options, subjects, marks);
    } catch (error) {
      throw pictureFailure(error);
    }
    const textured = await this.textures(request, context.signal);
    const note = lookNote(textured.outcome, false);
    if (note) notes.unshift(note);
    const result = await this.render(textured.request, context);
    return this.answer(
      {
        map: map.id,
        ...(options.view === 'compare' ? { compare_to: subjects[1]!.id } : {}),
        view: options.view,
        ...this.lookFields(
          drawnLook(options.look, textured.outcome),
          options.perspective,
          drawnSecond(options.second, textured.outcome),
        ),
        ...(marks.length > 0 || args.findings_of !== undefined ? { marks: marks.length } : {}),
      },
      result,
      notes,
      args.save === true,
      { file: (map.path ?? map.name).slice(0, 260) },
    );
  }

  private subject(map: CompactMap): PictureSubject {
    if (!isPictureMap(map.picture)) {
      throw internalError(`AoE2RMSIDE cannot draw ${map.id}; generate it again.`);
    }
    return { id: map.id, map: map.picture };
  }

  private lookFields(
    look: PictureLook,
    perspective: string,
    second: PictureOptions['second'],
  ): Record<string, unknown> {
    return {
      look: pictureLookWord(look),
      perspective,
      ...(second
        ? {
            beside: {
              ...(second.look ? { look: pictureLookWord(second.look) } : {}),
              ...(second.perspective ? { perspective: second.perspective } : {}),
            },
          }
        : {}),
    };
  }

  private marks(
    value: ConnectorToolArguments,
    map: CompactMap,
    picture: PictureMap,
    context: ConnectorToolContext,
  ): { marks: PictureMark[]; note?: string } {
    const runId = stringArgument(value, 'run')!;
    const run = this.runs(context).get(runId);
    if (!run) throw expired(runId);
    if (!run.settled) {
      throw new ConnectorToolError('busy', `${runId} is still running.`, {
        hint: `Wait for it with run_status {run:'${runId}'}.`,
        retryAfterSeconds: 5,
      });
    }
    const details = run.details as RunDetails | undefined;
    if (!details || (details.kind !== 'map-test' && details.kind !== 'quality')) {
      throw invalid(`${runId} has no findings to mark.`);
    }
    const askedSeed = integerArgument(value, 'seed');
    const seed = askedSeed === undefined ? map.seed : unsignedSeed(askedSeed);
    if (seed !== map.seed) {
      throw invalid(
        `${map.id} has seed ${map.seed}, not ${seed}.`,
        `Generate seed ${seed} first: generate_map {from_run:{run:'${runId}', seed:${seed}}}.`,
      );
    }
    const caseId = stringArgument(value, 'case');
    const marks = findingMarks(details.result, {
      seed,
      ...(caseId === undefined ? {} : { caseId }),
      map: picture,
    });
    return marks.length > 0
      ? { marks }
      : { marks, note: `${runId} has no findings with a position on seed ${seed}.` };
  }

  private async textures(
    request: PictureRequest,
    signal: AbortSignal,
  ): Promise<{ request: PictureRequest; outcome: PictureTexturesOutcome }> {
    try {
      return await resolvePictureTextures(request, this.deps.bridge, signal);
    } catch (error) {
      if (signal.aborted) throw new ConnectorToolError('cancelled', 'The call was cancelled.');
      throw pictureFailure(error);
    }
  }

  private async render(
    request: PictureRequest,
    context: ConnectorToolContext,
  ): Promise<PictureResult> {
    try {
      return await this.deps.pictures.render(request, context.signal);
    } catch (error) {
      if (context.signal.aborted)
        throw new ConnectorToolError('cancelled', 'The call was cancelled.');
      throw pictureFailure(error);
    }
  }

  private async answer(
    fields: Record<string, unknown>,
    result: PictureResult,
    notes: string[],
    save: boolean,
    facts: ConnectorOutputFacts,
  ): Promise<ConnectorToolResult> {
    let saved: string | undefined;
    if (save) {
      try {
        saved = await this.deps.savePicture(result.png);
      } catch {
        notes.push('The picture could not be saved.');
      }
    }
    const text = pictureText({
      ...fields,
      px_per_tile: result.pixelsPerTile,
      size: [result.width, result.height],
      shows: result.description,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      ...(saved ? { saved } : {}),
    });
    const content: ConnectorContent[] = [
      { type: 'text', text },
      { type: 'image', png: result.png, width: result.width, height: result.height },
    ];
    return { content, facts };
  }

  private async shownPicture(
    options: PictureOptions,
    save: boolean,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    let view: AppPictureView;
    try {
      view = validateAppPictureView(
        await this.deps.bridge.request(
          'pictureView',
          {},
          {
            timeoutMilliseconds: viewTimeoutMilliseconds,
            signal: context.signal,
          },
        ),
      );
    } catch (error) {
      if (error instanceof ConnectorToolError && error.code === 'cancelled') throw error;
      throw new ConnectorToolError('not_found', 'The preview in AoE2RMSIDE is not available.', {
        hint: 'Call show_map to show the map in the preview, then ask again.',
      });
    }
    if (!view.shown) {
      throw new ConnectorToolError('not_found', 'The preview in AoE2RMSIDE shows no map.', {
        hint: 'Call show_map to show the map in the preview, then ask again.',
      });
    }
    if (view.mapTest) {
      throw new ConnectorToolError(
        'not_found',
        "The preview shows a map test's map, which pictures do not draw.",
        {
          hint: 'Call show_map to show the script in the preview, then ask again.',
        },
      );
    }
    let map: PictureMap | undefined;
    try {
      map = this.deps.shownMap(view.requestHash);
    } catch {
      throw internalError('AoE2RMSIDE cannot draw the map in the preview.');
    }
    if (!map) {
      throw new ConnectorToolError(
        'not_found',
        'AoE2RMSIDE no longer holds the map the preview shows.',
        {
          hint: 'Call show_map to show it again (or ask the user to run it), then ask again.',
        },
      );
    }
    const settings = shownPictureSettings(view, map);
    let request: PictureRequest;
    try {
      request = shownPictureRequest(settings, map, options);
    } catch (error) {
      throw pictureFailure(error);
    }
    const textured = await this.textures(request, context.signal);
    const result = await this.render(textured.request, context);
    const notes: string[] = [];
    const note = lookNote(textured.outcome, true);
    if (note) notes.push(note);
    if (settings.region.kind === 'whole')
      notes.push('The preview framing was not available; this is the whole map.');
    return this.answer(
      {
        map: 'preview',
        view: 'as_shown',
        ...this.lookFields(
          drawnLook(settings.look, textured.outcome),
          settings.perspective,
          drawnSecond(options.second, textured.outcome),
        ),
      },
      result,
      notes,
      save,
      {},
    );
  }

  async contactSheet(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const seeds = sheetSeeds(args);
    const path = stringArgument(args, 'path');
    const resolved = path === undefined ? undefined : await this.deps.resolveScript(path, 'map');
    const settings = parseRunSettings(args.settings);
    const look = pictureLookFromWord(stringArgument(args, 'look'));
    const perspective = (stringArgument(args, 'perspective') ?? 'grid') as PicturePerspective;
    const size = integerArgument(args, 'size') ?? 960;
    const save = args.save === true;
    const wait = waitMilliseconds(
      args.wait_seconds,
      context.limits.defaultWaitSeconds,
      context.limits.maxWaitSeconds,
    );
    await this.admit(context.signal);
    const registry = this.runs(context);
    const app = context.app.displayName;
    const run = registry.start('s', async (runContext) => {
      const input = await this.sheetInput(resolved?.absolute ?? null, settings, runContext.signal);
      const file = (input.path ? this.deps.relativePath(input.path) : null) ?? input.name;
      const facts: ConnectorOutputFacts = { file: file.slice(0, 260), count: seeds.length };
      const entries = await this.generateSheet(runContext, input, seeds, app);
      const generated = entries.filter(
        (entry): entry is SheetSeed & { map: CompactMap } => entry.map !== undefined,
      );
      connectionMaps(context).putSheet(generated.map((entry) => entry.map));
      runContext.setDetails({
        kind: 'custom',
        details: (detailArgs) =>
          sheetDetails(runContext.id, entries, stringArgument(detailArgs, 'part') ?? ''),
      } satisfies RunDetails);
      const rows = entries.map((entry) => ({
        ...(entry.map ? { id: entry.id } : {}),
        seed: entry.seed,
        status: entry.map ? 'ok' : 'failed',
        ...(entry.map && seedNote(entry.map) ? { note: seedNote(entry.map) } : {}),
      }));
      const head = { sheet: runContext.id, path: file, settings: input.settings };
      if (generated.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: pictureText({
                ...head,
                status: 'failed',
                seeds: rows,
                hint: 'The script did not generate; call get_problems, or generate_map one seed for its errors.',
              }),
            },
          ],
          outcome: 'failed',
          facts,
        } satisfies ConnectorToolResult;
      }
      const pictures = generated.filter((entry) => isPictureMap(entry.map.picture));
      if (pictures.length === 0) throw internalError('AoE2RMSIDE could not draw the seeds.');
      const request = sheetPictureRequest(
        pictures.map((entry) => ({
          id: entry.id,
          seed: entry.seed,
          map: entry.map.picture as PictureMap,
        })),
        { look, perspective, size },
      );
      const textured = await this.textures(request, runContext.signal);
      let result: PictureResult;
      try {
        result = await this.deps.pictures.render(textured.request, runContext.signal);
      } catch (error) {
        throw pictureFailure(error);
      }
      const ask = `inspect_map {map:'${generated[0]!.id}'} · get_picture {map:'${generated[0]!.id}', view:'bases'}`;
      const note = lookNote(textured.outcome, false);
      return this.answer(
        {
          ...head,
          look: pictureLookWord(drawnLook(look, textured.outcome)),
          perspective,
          seeds: rows,
          more: { ask },
        },
        result,
        note ? [note] : [],
        save,
        facts,
      );
    });
    return this.wait(run, wait, context);
  }

  private async admit(signal: AbortSignal): Promise<void> {
    const admission = await this.deps.lane.admit(signal);
    if (admission === 'idle') return;
    this.deps.sheets.stopAutomatic();
    if ((await this.deps.lane.admit(signal)) !== 'idle') {
      throw busyError(this.deps.leaseState(), this.deps.now());
    }
  }

  private async sheetInput(
    path: string | null,
    settings: ReturnType<typeof parseRunSettings>,
    signal: AbortSignal,
  ): Promise<AppPictureInputReply> {
    const reply = await this.deps.bridge.request(
      'pictureInput',
      { path, ...(settings ? { settings } : {}) },
      { timeoutMilliseconds: inputTimeoutMilliseconds, signal },
    );
    try {
      return validateAppPictureInputReply(reply);
    } catch {
      throw internalError();
    }
  }

  private async generateSheet(
    run: RunContext,
    input: AppPictureInputReply,
    seeds: readonly number[],
    app: string,
  ): Promise<SheetSeed[]> {
    const prefix = `pictures-${randomUUID()}`;
    let current: string | null = null;
    let stoppedByUser = false;
    const cancelCurrent = async () => {
      if (current) await this.deps.sheets.cancel(current).catch(() => undefined);
    };
    const onAbort = () => void cancelCurrent();
    run.signal.addEventListener('abort', onAbort, { once: true });
    const entries: SheetSeed[] = [];
    try {
      await this.deps.sheets.withLease(
        appExecutionLabel(app, `Pictures · ${seeds.length} seeds`),
        app,
        async () => {
          stoppedByUser = true;
          await cancelCurrent();
        },
        async () => {
          for (const [index, seed] of seeds.entries()) {
            if (stoppedByUser || run.signal.aborted) break;
            run.progress(index, seeds.length, `Generating seed ${seed}`);
            current = `${prefix}-${index + 1}`;
            const id = `${run.id}.${index + 1}`;
            const started = this.deps.now();
            let result: PreviewGenerationResult;
            try {
              result = await this.deps.sheets.generate(input.input, seed, current);
            } catch {
              if (stoppedByUser || run.signal.aborted) break;
              entries.push({ id, seed });
              continue;
            } finally {
              current = null;
            }
            entries.push({ id, seed, map: this.compact(result, input, id, seed, started) });
          }
          run.progress(seeds.length, seeds.length, 'Drawing');
        },
      );
    } finally {
      run.signal.removeEventListener('abort', onAbort);
    }
    if (run.signal.aborted) {
      throw new ConnectorToolError('stopped', 'The run was stopped.', {
        details: { by: run.stoppedBy() === 'connection' ? 'connection' : 'app' },
      });
    }
    if (stoppedByUser) {
      throw new ConnectorToolError('stopped', 'The user stopped the contact sheet in AoE2RMSIDE.', {
        details: { by: 'user' },
        hint: 'Ask the user before running it again.',
      });
    }
    return entries;
  }

  private compact(
    result: PreviewGenerationResult,
    input: AppPictureInputReply,
    id: string,
    seed: number,
    started: number,
  ): CompactMap | undefined {
    const relative = input.path ? this.deps.relativePath(input.path) : null;
    let map: CompactMap;
    try {
      map = compactMapFromResult(
        result,
        {
          id,
          path: relative,
          name: input.name,
          seed,
          settings: input.settings,
          timeS: Math.max(0, (this.deps.now() - started) / 1000),
          teams: input.teams,
        },
        (sourceId) => this.deps.source(sourceId),
      );
    } catch {
      return undefined;
    }
    try {
      map.picture = this.deps.pictureMap(result);
    } catch {}
    return map;
  }

  private async wait(
    run: RegisteredRun,
    waitMs: number,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const registry = this.runs(context);
    try {
      const outcome = await registry.wait(run.id, waitMs, context.signal, (progress) =>
        context.progress(progress.done, progress.total, progress.message),
      );
      if (outcome.kind === 'finished') return outcome.result;
      return connectorTextResult(runningAnswer(outcome.run, this.deps.now()));
    } catch (error) {
      if (context.signal.aborted) registry.stop(run.id, 'app');
      throw error;
    }
  }
}

export function registerPictureTools(
  registry: ConnectorToolRegistry,
  deps: PictureToolDependencies,
): () => void {
  const tools = new PictureTools(deps);
  const removals = [
    registry.register('get_picture', (args, context) => tools.picture(args, context)),
    registry.register('contact_sheet', (args, context) => tools.contactSheet(args, context)),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}
