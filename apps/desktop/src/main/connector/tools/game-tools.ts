import type { RootExecutionState } from '../../../shared/api';
import type { ConnectorOutputFacts } from '../../../shared/connector-api';
import {
  validateAppDeployReply,
  validateAppLiveTestReply,
  type AppDeployApplyRequest,
  type AppDeployPrepareRequest,
  type AppDeployReply,
  type AppGameMissing,
  type AppGameRunFailure,
  type AppLiveTestReply,
  type AppLiveTestRequest,
} from '../../../shared/connector-game-api';
import {
  validateConnectorPromptAnswer,
  type ConnectorPrompt,
  type ConnectorPromptAnswer,
} from '../../../shared/connector-prompts';
import { knownCrashFromText, withoutKnownCrashMarker } from '../../../shared/known-crashes';
import { withoutRefusalLocationMarker } from '../../../shared/refusal-location';
import {
  isPersistentModName,
  isReservedPersistentModName,
} from '../../../shared/persistent-mod-name';
import {
  ConnectorToolError,
  connectorTextResult,
  type ConnectorToolContext,
  type ConnectorToolRegistry,
  type ConnectorToolResult,
} from '../dispatcher';
import { busyError, type AppLane, type AppRunTickets } from '../lane';
import { unsignedSeed } from '../run-arguments';
import { runningAnswer, type RunContext, type RunPrefix } from '../run-registry';
import { failedRunSummary, sourceFile, type ScriptError } from '../summaries/map-summary';
import type { ConnectorJsonValue, ConnectorToolArguments } from '../validator';
import type { IdeStatusPart } from './workspace-tools';
import { connectionRuns, type ResolvedScript } from './run-tools';

export class GameSession {
  private readonly allowed = new Map<string, string>();
  private readonly denied = new Set<string>();

  liveTest(app: string, allowedSince: string | null): 'allowed' | 'denied' | 'ask' {
    if (this.denied.has(app)) return 'denied';
    const since = this.allowed.get(app);
    if (since !== undefined && since === allowedSince) return 'allowed';
    if (since !== undefined) this.allowed.delete(app);
    return 'ask';
  }

  allow(app: string, allowedSince: string | null): void {
    if (allowedSince !== null) this.allowed.set(app, allowedSince);
  }

  deny(app: string): void {
    this.allowed.delete(app);
    this.denied.add(app);
  }
}

export interface GameToolTiming {
  promptCloseAfterMs: number;
  deployTimeoutMs: number;
  liveTestTimeoutMs: number;
}

const defaultTiming: GameToolTiming = {
  promptCloseAfterMs: 30 * 60 * 1000,
  deployTimeoutMs: 30 * 60 * 1000,
  liveTestTimeoutMs: 30 * 60 * 1000,
};

export interface GameToolDependencies {
  bridge: {
    request(
      kind: 'deploy' | 'liveTest' | 'prompt',
      payload: unknown,
      options: { timeoutMilliseconds: number; signal?: AbortSignal },
    ): Promise<unknown>;
  };
  lane: AppLane;
  tickets: AppRunTickets;
  leaseState(): RootExecutionState;
  resolveScript(path: string, kind: 'map'): Promise<ResolvedScript>;
  relativePath(absolute: string): string | null;
  stopExecution(executionId: string): void;
  session: GameSession;
  allowedSince(app: string): string | null;
  scriptErrors?(absolutePath: string): ScriptError[];
  controlReady?(): Promise<boolean>;
  gameFolderLinked?(): boolean;
  freshSeed(): number;
  now(): number;
  timing?: Partial<GameToolTiming>;
}

type GameTool = 'deploy' | 'live';

class UserWait {
  reason: string | null = null;
  facts: ConnectorOutputFacts = {};
  private readonly listeners = new Set<() => void>();

  set(reason: string | null): void {
    this.reason = reason;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

interface ConnectionGameState {
  deployed: Set<string>;
  pending: Map<GameTool, { runId: string; key: string }>;
  waits: Map<string, UserWait>;
}

const connectionStateKey = {};
const waitingText = 'Waiting for the user in AoE2RMSIDE';

const missingWords: Record<AppGameMissing, { message: string; hint: string }> = {
  'game-folder': {
    message: 'No game folder is linked in AoE2RMSIDE.',
    hint: 'Ask the user to link their AoE2DE game folder in AoE2RMSIDE.',
  },
  profile: {
    message: 'AoE2RMSIDE could not choose a game profile for the mod.',
    hint: 'Ask the user to deploy once with Deploy as Mod in AoE2RMSIDE and choose the profile.',
  },
  control: {
    message: 'No AoE2Control is selected in AoE2RMSIDE.',
    hint: 'Ask the user to select AoE2Control in the Run menu of AoE2RMSIDE.',
  },
  'run-menu': {
    message: 'The Run menu of AoE2RMSIDE is still loading.',
    hint: 'Try again in a moment.',
  },
};

export function deploymentTargetKey(profileId: string, modName: string): string {
  return `${profileId}\0${modName.toLowerCase()}`;
}

function textResult(
  text: string,
  options: { outcome?: 'done' | 'failed'; facts?: ConnectorOutputFacts } = {},
): ConnectorToolResult {
  return { content: [{ type: 'text', text }], ...options };
}

function internalError(message = 'Something went wrong in AoE2RMSIDE.'): ConnectorToolError {
  return new ConnectorToolError('internal', message, {
    hint: 'Try again; if it keeps failing, ask the user to look at the Output in AoE2RMSIDE.',
  });
}

function stoppedError(run: RunContext, what: string): ConnectorToolError {
  return new ConnectorToolError('stopped', `The ${what} was stopped.`, {
    details: { by: run.stoppedBy() === 'connection' ? 'connection' : 'app' },
  });
}

function stoppedByUser(what: string): ConnectorToolError {
  return new ConnectorToolError('stopped', `The user stopped the ${what} in AoE2RMSIDE.`, {
    details: { by: 'user' },
    hint: 'Ask the user before trying again.',
  });
}

function notReady(missing: AppGameMissing): ConnectorToolError {
  const words = missingWords[missing];
  return new ConnectorToolError('game_not_ready', words.message, {
    details: { missing },
    hint: words.hint,
  });
}

function noAnswer(): ConnectorToolError {
  return new ConnectorToolError('user_declined', 'No answer in AoE2RMSIDE.', {
    hint: 'Ask the user whether to try again.',
  });
}

export class GameTools {
  private readonly timing: GameToolTiming;

  constructor(private readonly deps: GameToolDependencies) {
    this.timing = { ...defaultTiming, ...deps.timing };
  }

  private state(context: ConnectorToolContext): ConnectionGameState {
    return context.connection.get(connectionStateKey, () => ({
      deployed: new Set<string>(),
      pending: new Map(),
      waits: new Map(),
    }));
  }

  async deploy(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const modName = typeof args.mod_name === 'string' ? args.mod_name : undefined;
    if (
      modName !== undefined &&
      (!isPersistentModName(modName) || isReservedPersistentModName(modName))
    ) {
      throw new ConnectorToolError(
        'invalid_arguments',
        'mod_name is not a usable mod folder name.',
        {
          hint: 'Use one folder name without \\ / : * ? " < > |, without a trailing dot or space; omit it for the script name.',
        },
      );
    }
    const enable = typeof args.enable === 'boolean' ? args.enable : null;
    const script = await this.script(args);
    const key = JSON.stringify(['deploy', script?.absolute ?? null, modName ?? null, enable]);
    return this.startRun(context, 'deploy', 'd', key, (run, wait) =>
      this.deployRun(run, wait, context, script, modName, enable),
    );
  }

  private async deployRun(
    run: RunContext,
    wait: UserWait,
    context: ConnectorToolContext,
    script: ResolvedScript | null,
    modName: string | undefined,
    enable: boolean | null,
  ): Promise<ConnectorToolResult> {
    const app = context.app.displayName;
    const connection = this.state(context);
    const accepted = new Set<string>();
    let confirmedReplace: string | null = null;
    wait.facts = script ? { file: script.relative } : {};
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.deps.lane.admit(run.signal);
      run.progress(0, 0, 'Preparing the deployment');
      const ticket = this.deps.tickets.issue('generate', app);
      const stop = () => {
        const executionId = this.deps.tickets.cancel(ticket.token);
        if (executionId) this.deps.stopExecution(executionId);
      };
      run.signal.addEventListener('abort', stop, { once: true });
      let prepared: AppDeployReply;
      try {
        const request: AppDeployPrepareRequest = {
          phase: 'prepare',
          token: ticket.token,
          app,
          path: script?.absolute ?? null,
          ...(modName === undefined ? {} : { modName }),
        };
        prepared = await this.request('deploy', request, validateAppDeployReply, run.signal);
      } finally {
        run.signal.removeEventListener('abort', stop);
        this.deps.tickets.finish(ticket.token);
      }
      if (prepared.outcome !== 'ready') {
        return this.unexpected(prepared, run, 'deployment', 'deploy it', wait.facts);
      }
      const file = this.fileOf(prepared.path, prepared.name);
      const facts: ConnectorOutputFacts = { file, mod: prepared.modName };
      wait.facts = facts;
      const target = deploymentTargetKey(prepared.profileId, prepared.modName);
      if (prepared.crashes.some((crash) => !accepted.has(crash.crashId))) {
        const answer = await this.ask(
          {
            prompt: 'deploy-known-crash',
            app,
            file,
            mod: prepared.modName,
            crashes: prepared.crashes,
          },
          run,
          wait,
          'The game can crash on this map with another seed or other lobby settings; the user must choose Deploy anyway in AoE2RMSIDE.',
        );
        this.declinedUnlessConfirmed(answer, 'The user chose not to deploy the map.', facts);
        for (const crash of prepared.crashes) accepted.add(crash.crashId);
      }
      if (
        prepared.targetExists &&
        !connection.deployed.has(target) &&
        confirmedReplace !== target
      ) {
        const answer = await this.ask(
          { prompt: 'deploy-replace', app, file, mod: prepared.modName },
          run,
          wait,
          `The mod "${prepared.modName}" exists and was not deployed by you; the user must confirm in AoE2RMSIDE that it may be replaced.`,
        );
        this.declinedUnlessConfirmed(
          answer,
          `The user chose not to replace the mod "${prepared.modName}".`,
          facts,
          'Ask the user for another mod_name.',
        );
        confirmedReplace = target;
      }
      run.progress(0, 0, 'Deploying');
      const apply: AppDeployApplyRequest = {
        phase: 'apply',
        app,
        previewToken: prepared.previewToken,
        confirmReplaceExisting: prepared.targetExists,
        enable,
      };
      const applied = await this.request('deploy', apply, validateAppDeployReply, run.signal);
      if (applied.outcome === 'stale') continue;
      if (applied.outcome !== 'deployed') {
        return this.unexpected(applied, run, 'deployment', 'deploy it', facts);
      }
      connection.deployed.add(deploymentTargetKey(applied.profileId, applied.modName));
      const note = applied.enableFailed
        ? 'Enabling the mod failed; the user can enable it in the game.'
        : !prepared.targetExists
          ? 'The game lists a new mod after it restarts.'
          : applied.gameRunning
            ? 'The game is running; it may need a restart to load the change.'
            : undefined;
      return connectorTextResult(
        {
          mod: applied.modName,
          files: applied.files,
          enabled: applied.enabled,
          ...(prepared.targetExists ? { replaced: true } : {}),
          note,
        },
        { facts: { file, mod: applied.modName } },
      );
    }
    throw internalError('The deployment kept changing while AoE2RMSIDE prepared it.');
  }

  async liveTest(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const appName = context.app.name;
    if (this.deps.session.liveTest(appName, this.deps.allowedSince(appName)) === 'denied') {
      throw new ConnectorToolError(
        'user_declined',
        "The user chose Don't Allow for live tests of this app; AoE2RMSIDE asks again after it restarts.",
        { hint: 'Do not ask for live tests again; ask the user to test in the game themselves.' },
      );
    }
    const script = await this.script(args);
    const given = typeof args.seed === 'number' ? unsignedSeed(args.seed) : undefined;
    const key = JSON.stringify(['live', script?.absolute ?? null, given ?? null]);
    return this.startRun(context, 'live', 'l', key, (run, wait) =>
      this.liveRun(run, wait, context, script, given ?? this.deps.freshSeed()),
    );
  }

  private async liveRun(
    run: RunContext,
    wait: UserWait,
    context: ConnectorToolContext,
    script: ResolvedScript | null,
    seed: number,
  ): Promise<ConnectorToolResult> {
    const app = context.app.displayName;
    const appName = context.app.name;
    let file = script?.relative ?? 'the active script';
    wait.facts = { ...(script ? { file: script.relative } : {}), seed };
    const permission = this.deps.session.liveTest(appName, this.deps.allowedSince(appName));
    if (permission === 'denied') throw this.liveDenied();
    if (permission === 'ask') {
      const answer = await this.ask(
        { prompt: 'live-test', app, file, seed },
        run,
        wait,
        'The user must confirm the live test in AoE2RMSIDE.',
      );
      if (answer.decision === 'cancel') {
        this.deps.session.deny(appName);
        throw this.liveDenied();
      }
      if (answer.decision !== 'confirm') throw noAnswer();
      if (answer.allowForSession) {
        this.deps.session.allow(appName, this.deps.allowedSince(appName));
      }
    }
    let accepted: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.deps.lane.admit(run.signal);
      run.progress(0, 0, 'Starting the live test');
      const generation = this.deps.tickets.issue('generate', app);
      const live = this.deps.tickets.issue('live-test', app);
      const stop = () => {
        for (const ticket of [generation, live]) {
          const executionId = this.deps.tickets.cancel(ticket.token);
          if (executionId) this.deps.stopExecution(executionId);
        }
      };
      run.signal.addEventListener('abort', stop, { once: true });
      let reply: AppLiveTestReply;
      try {
        const request: AppLiveTestRequest = {
          token: generation.token,
          liveToken: live.token,
          app,
          path: script?.absolute ?? null,
          seed,
          acceptedCrashes: accepted,
        };
        reply = await this.request(
          'liveTest',
          request,
          validateAppLiveTestReply,
          run.signal,
          this.timing.liveTestTimeoutMs,
        );
      } finally {
        run.signal.removeEventListener('abort', stop);
        this.deps.tickets.finish(generation.token);
        this.deps.tickets.finish(live.token);
      }
      switch (reply.outcome) {
        case 'started':
          return connectorTextResult(
            {
              status: 'started',
              seed: reply.seed,
              verified: 'seed and settings verified',
              ...(reply.unverifiedVersion
                ? { game_version: 'not yet compared with AoE2RMSIDE' }
                : {}),
              note: 'Look at the game; this tool cannot see it. Ask the user what they see.',
            },
            { facts: { file, seed: reply.seed } },
          );
        case 'crash-warning': {
          file = this.fileOf(reply.path, reply.name);
          wait.facts = { file, seed };
          if (attempt > 0) break;
          const answer = await this.ask(
            { prompt: 'live-test', app, file, seed, crashes: reply.crashes },
            run,
            wait,
            'The game can crash on this map with another seed or other lobby settings; the user must choose whether to start the live test in AoE2RMSIDE.',
          );
          this.declinedUnlessConfirmed(answer, 'The user chose not to start the live test.', {
            file,
            seed,
          });
          accepted = reply.crashes.map((crash) => crash.crashId);
          continue;
        }
        case 'live-failed':
          throw new ConnectorToolError(
            'game_not_ready',
            `The live test did not start: ${withoutRefusalLocationMarker(withoutKnownCrashMarker(reply.message)).slice(0, 300)}`,
            {
              hint: 'Ask the user to look at the Output in AoE2RMSIDE and at the game.',
              facts: { file, seed },
            },
          );
        default:
          return this.unexpected(reply, run, 'live test', 'start it', wait.facts);
      }
    }
    throw internalError('The live test map kept changing while AoE2RMSIDE prepared it.');
  }

  private liveDenied(): ConnectorToolError {
    return new ConnectorToolError(
      'user_declined',
      "The user chose Don't Allow for live tests of this app; AoE2RMSIDE asks again after it restarts.",
      { hint: 'Ask the user to test the map in the game themselves.' },
    );
  }

  async statusPart(context: ConnectorToolContext): Promise<Record<string, ConnectorJsonValue>> {
    const appName = context.app.name;
    const permission = this.deps.session.liveTest(appName, this.deps.allowedSince(appName));
    let live: string;
    if (permission === 'denied') live = 'not allowed until AoE2RMSIDE restarts';
    else if (this.deps.gameFolderLinked && !this.deps.gameFolderLinked()) {
      live = 'needs a game folder';
    } else if (this.deps.controlReady && !(await this.deps.controlReady())) {
      live = 'needs AoE2Control';
    } else live = permission === 'allowed' ? 'session allowed' : 'available, the user confirms';
    return { live_test: live };
  }

  private async script(args: ConnectorToolArguments): Promise<ResolvedScript | null> {
    return typeof args.path === 'string' ? this.deps.resolveScript(args.path, 'map') : null;
  }

  private fileOf(path: string | null, name: string): string {
    return ((path ? this.deps.relativePath(path) : null) ?? name).slice(0, 260);
  }

  private async request<T>(
    kind: 'deploy' | 'liveTest',
    payload: unknown,
    validate: (value: unknown) => T,
    signal: AbortSignal,
    timeoutMilliseconds = this.timing.deployTimeoutMs,
  ): Promise<T> {
    const reply = await this.deps.bridge.request(kind, payload, { timeoutMilliseconds, signal });
    try {
      return validate(reply);
    } catch {
      throw internalError();
    }
  }

  private async ask(
    prompt: ConnectorPrompt,
    run: RunContext,
    wait: UserWait,
    reason: string,
  ): Promise<ConnectorPromptAnswer> {
    run.progress(0, 0, waitingText);
    wait.set(reason);
    try {
      const reply = await this.deps.bridge.request(
        'prompt',
        { ...prompt, closeAfterMs: this.timing.promptCloseAfterMs },
        { timeoutMilliseconds: this.timing.promptCloseAfterMs + 60_000, signal: run.signal },
      );
      try {
        return validateConnectorPromptAnswer(reply);
      } catch {
        throw internalError();
      }
    } finally {
      wait.set(null);
      run.progress(0, 0, 'Working');
    }
  }

  private declinedUnlessConfirmed(
    answer: ConnectorPromptAnswer,
    message: string,
    facts: ConnectorOutputFacts,
    hint = 'Ask the user what to change.',
  ): void {
    if (answer.decision === 'confirm') return;
    if (answer.decision === 'no-answer') throw noAnswer();
    throw new ConnectorToolError('user_declined', message, { hint, facts });
  }

  private unexpected(
    reply: AppDeployReply | AppLiveTestReply,
    run: RunContext,
    what: string,
    action: string,
    facts: ConnectorOutputFacts,
  ): ConnectorToolResult {
    switch (reply.outcome) {
      case 'deploy-failed':
        return textResult(`The deployment failed: ${reply.message.slice(0, 600)}`.slice(0, 1_400), {
          outcome: 'failed',
          facts,
        });
      case 'failed': {
        const failure: AppGameRunFailure = reply;
        const crash = knownCrashFromText(failure.message);
        const file = this.fileOf(failure.path, failure.name);
        if (crash) {
          throw new ConnectorToolError(
            'blocked_known_crash',
            `The game crashes on this map with the selected setup, so AoE2RMSIDE does not ${action}.`,
            {
              details: { crash: crash.crashId },
              hint: "Fix the script: get_problems shows where, read_guide {topic:'known-crashes'} explains the cause.",
              facts: { file },
            },
          );
        }
        const errors = failure.path ? (this.deps.scriptErrors?.(failure.path) ?? []) : [];
        return textResult(
          failedRunSummary(
            {
              path: file,
              name: failure.name,
              stage: failure.stage,
              message: failure.message,
              fileOf: (sourceId) => sourceFile(sourceId, this.deps.relativePath),
            },
            errors,
            1_500,
          ),
          { outcome: 'failed', facts: { file } },
        );
      }
      case 'not-ready':
        throw notReady(reply.missing);
      case 'busy':
        throw busyError(this.deps.leaseState(), this.deps.now());
      case 'cancelled':
        if (run.signal.aborted) throw stoppedError(run, what);
        throw stoppedByUser(what);
      default:
        throw internalError();
    }
  }

  private async startRun(
    context: ConnectorToolContext,
    tool: GameTool,
    prefix: RunPrefix,
    key: string,
    work: (run: RunContext, wait: UserWait) => Promise<ConnectorToolResult>,
  ): Promise<ConnectorToolResult> {
    const connection = this.state(context);
    const registry = connectionRuns(context, () => this.deps.now());
    const previous = connection.pending.get(tool);
    if (previous) {
      const run = registry.get(previous.runId);
      const wait = connection.waits.get(previous.runId);
      if (run && !run.settled && wait) {
        if (previous.key === key) return this.answer(run.id, wait, context);
        if (wait.reason !== null) registry.stop(run.id, 'app');
      }
      connection.pending.delete(tool);
    }
    await this.deps.lane.admit(context.signal);
    const wait = new UserWait();
    const what = tool === 'deploy' ? 'deployment' : 'live test';
    const run = registry.start(prefix, async (runContext) => {
      try {
        return await work(runContext, wait);
      } catch (error) {
        if (
          runContext.signal.aborted &&
          !(error instanceof ConnectorToolError && error.code === 'stopped')
        ) {
          throw stoppedError(runContext, what);
        }
        if (error instanceof ConnectorToolError && error.facts === undefined) {
          throw new ConnectorToolError(error.code, error.message, {
            ...(error.hint === undefined ? {} : { hint: error.hint }),
            ...(error.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: error.retryAfterSeconds }),
            ...(error.details === undefined ? {} : { details: { ...error.details } }),
            facts: wait.facts,
          });
        }
        throw error;
      } finally {
        connection.waits.delete(runContext.id);
      }
    });
    connection.waits.set(run.id, wait);
    connection.pending.set(tool, { runId: run.id, key });
    return this.answer(run.id, wait, context, true);
  }

  private async answer(
    runId: string,
    wait: UserWait,
    context: ConnectorToolContext,
    stopOnCancel = false,
  ): Promise<ConnectorToolResult> {
    const registry = connectionRuns(context, () => this.deps.now());
    const waiter = new AbortController();
    let needsUser: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const reason = wait.reason;
      if (reason === null) return;
      timer = setTimeout(() => {
        needsUser = reason;
        waiter.abort();
      }, context.limits.pairingWaitSeconds * 1000);
    };
    const unsubscribe = wait.subscribe(watch);
    watch();
    const forward = () => waiter.abort();
    context.signal.addEventListener('abort', forward, { once: true });
    try {
      const outcome = await registry.wait(
        runId,
        context.limits.defaultWaitSeconds * 1000,
        waiter.signal,
        (progress) => context.progress(progress.done, progress.total, progress.message),
      );
      if (outcome.kind === 'finished') return outcome.result;
      return connectorTextResult(runningAnswer(outcome.run, this.deps.now()));
    } catch (error) {
      if (needsUser !== null && !context.signal.aborted) {
        throw new ConnectorToolError('needs_user_at_pc', needsUser, {
          details: { run: runId },
          hint: `The question stays open in AoE2RMSIDE. After the user answers, run_status {run:'${runId}'} gives the result.`,
          facts: wait.facts,
        });
      }
      if (stopOnCancel && context.signal.aborted) registry.stop(runId, 'app');
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      context.signal.removeEventListener('abort', forward);
    }
  }
}

export function registerGameTools(
  registry: ConnectorToolRegistry,
  deps: GameToolDependencies,
  addStatusPart?: (part: IdeStatusPart) => () => void,
): () => void {
  const tools = new GameTools(deps);
  const removals = [
    registry.register('deploy_mod', (args, context) => tools.deploy(args, context)),
    registry.register('live_test', (args, context) => tools.liveTest(args, context)),
    ...(addStatusPart ? [addStatusPart((context) => tools.statusPart(context))] : []),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}
