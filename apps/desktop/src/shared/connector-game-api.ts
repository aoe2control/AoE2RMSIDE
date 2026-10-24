import { knownCrashReference, type KnownCrashReference } from './known-crashes';

export const appGameLimits = Object.freeze({
  token: 64,
  app: 128,
  path: 4096,
  name: 512,
  modName: 120,
  profileId: 32,
  previewToken: 64,
  stage: 32,
  message: 2048,
  crashes: 16,
  files: 100_000,
});

export const appGameMissing = ['game-folder', 'profile', 'control', 'run-menu'] as const;
export type AppGameMissing = (typeof appGameMissing)[number];

export interface AppDeployPrepareRequest {
  phase: 'prepare';
  token: string;
  app: string;
  path: string | null;
  modName?: string;
}

export interface AppDeployApplyRequest {
  phase: 'apply';
  app: string;
  previewToken: string;
  confirmReplaceExisting: boolean;
  enable: boolean | null;
}

export type AppDeployRequest = AppDeployPrepareRequest | AppDeployApplyRequest;

export interface AppGameRunFailure {
  outcome: 'failed';
  path: string | null;
  name: string;
  stage: string;
  message: string;
}

export type AppDeployReply =
  | {
      outcome: 'ready';
      path: string | null;
      name: string;
      previewToken: string;
      modName: string;
      profileId: string;
      targetExists: boolean;
      files: number;
      crashes: KnownCrashReference[];
    }
  | {
      outcome: 'deployed';
      modName: string;
      profileId: string;
      files: number;
      enabled: boolean;
      enableFailed: boolean;
      gameRunning: boolean;
    }
  | { outcome: 'stale' }
  | { outcome: 'deploy-failed'; message: string }
  | AppGameRunFailure
  | { outcome: 'not-ready'; missing: AppGameMissing }
  | { outcome: 'cancelled' }
  | { outcome: 'busy' };

export interface AppLiveTestRequest {
  token: string;
  liveToken: string;
  app: string;
  path: string | null;
  seed?: number;
  acceptedCrashes: string[];
}

export type AppLiveTestReply =
  | { outcome: 'started'; seed: number; unverifiedVersion: boolean }
  | { outcome: 'crash-warning'; path: string | null; name: string; crashes: KnownCrashReference[] }
  | AppGameRunFailure
  | { outcome: 'live-failed'; message: string }
  | { outcome: 'not-ready'; missing: AppGameMissing }
  | { outcome: 'cancelled' }
  | { outcome: 'busy' };

const tokenPattern = /^[A-Za-z0-9-]{8,64}$/u;
const profilePattern = /^[0-9]{1,32}$/u;
const stagePattern = /^[a-z][a-z0-9_-]{0,31}$/u;
const crashIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

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

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is not a boolean`);
  return value;
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !tokenPattern.test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is not an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function nullablePath(value: unknown, label: string): string | null {
  return value === null ? null : text(value, 1, appGameLimits.path, label);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`${label} is not one of ${values.join(', ')}`);
  }
  return value as T;
}

function crashes(value: unknown, label: string): KnownCrashReference[] {
  if (!Array.isArray(value) || value.length > appGameLimits.crashes) {
    throw new Error(`${label} is not a list of at most ${appGameLimits.crashes}`);
  }
  return value.map((entry, index) => {
    const reference = knownCrashReference(entry);
    if (!reference) throw new Error(`${label}[${index}] is not a known crash`);
    return reference;
  });
}

function crashIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > appGameLimits.crashes) {
    throw new Error(`${label} is not a list of at most ${appGameLimits.crashes}`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length > 64 || !crashIdPattern.test(entry)) {
      throw new Error(`${label}[${index}] is not a crash id`);
    }
    return entry;
  });
}

function failure(reply: Record<string, unknown>, label: string): AppGameRunFailure {
  knownKeys(reply, ['outcome', 'path', 'name', 'stage', 'message'], label);
  const stage = reply.stage;
  if (typeof stage !== 'string' || !stagePattern.test(stage)) {
    throw new Error(`${label} stage is invalid`);
  }
  return {
    outcome: 'failed',
    path: nullablePath(reply.path, `${label} path`),
    name: text(reply.name, 1, appGameLimits.name, `${label} name`),
    stage,
    message: text(reply.message, 1, appGameLimits.message, `${label} message`),
  };
}

export function validateAppDeployRequest(value: unknown): AppDeployRequest {
  const request = record(value, 'app deploy request');
  if (request.phase === 'prepare') {
    knownKeys(request, ['phase', 'token', 'app', 'path', 'modName'], 'app deploy request');
    return {
      phase: 'prepare',
      token: token(request.token, 'app deploy token'),
      app: text(request.app, 1, appGameLimits.app, 'app deploy app'),
      path: nullablePath(request.path, 'app deploy path'),
      ...(request.modName === undefined
        ? {}
        : { modName: text(request.modName, 1, appGameLimits.modName, 'app deploy mod name') }),
    };
  }
  if (request.phase === 'apply') {
    knownKeys(
      request,
      ['phase', 'app', 'previewToken', 'confirmReplaceExisting', 'enable'],
      'app deploy request',
    );
    return {
      phase: 'apply',
      app: text(request.app, 1, appGameLimits.app, 'app deploy app'),
      previewToken: token(request.previewToken, 'app deploy preview token'),
      confirmReplaceExisting: bool(request.confirmReplaceExisting, 'app deploy confirmation'),
      enable: request.enable === null ? null : bool(request.enable, 'app deploy enable'),
    };
  }
  throw new Error('app deploy phase is not prepare or apply');
}

export function validateAppDeployReply(value: unknown): AppDeployReply {
  const reply = record(value, 'app deploy reply');
  const label = 'app deploy reply';
  switch (reply.outcome) {
    case 'ready': {
      knownKeys(
        reply,
        [
          'outcome',
          'path',
          'name',
          'previewToken',
          'modName',
          'profileId',
          'targetExists',
          'files',
          'crashes',
        ],
        label,
      );
      const profileId = reply.profileId;
      if (typeof profileId !== 'string' || !profilePattern.test(profileId)) {
        throw new Error(`${label} profile is invalid`);
      }
      return {
        outcome: 'ready',
        path: nullablePath(reply.path, `${label} path`),
        name: text(reply.name, 1, appGameLimits.name, `${label} name`),
        previewToken: token(reply.previewToken, `${label} preview token`),
        modName: text(reply.modName, 1, appGameLimits.modName, `${label} mod name`),
        profileId,
        targetExists: bool(reply.targetExists, `${label} targetExists`),
        files: integer(reply.files, 0, appGameLimits.files, `${label} files`),
        crashes: crashes(reply.crashes, `${label} crashes`),
      };
    }
    case 'deployed': {
      knownKeys(
        reply,
        ['outcome', 'modName', 'profileId', 'files', 'enabled', 'enableFailed', 'gameRunning'],
        label,
      );
      const profileId = reply.profileId;
      if (typeof profileId !== 'string' || !profilePattern.test(profileId)) {
        throw new Error(`${label} profile is invalid`);
      }
      return {
        outcome: 'deployed',
        modName: text(reply.modName, 1, appGameLimits.modName, `${label} mod name`),
        profileId,
        files: integer(reply.files, 0, appGameLimits.files, `${label} files`),
        enabled: bool(reply.enabled, `${label} enabled`),
        enableFailed: bool(reply.enableFailed, `${label} enableFailed`),
        gameRunning: bool(reply.gameRunning, `${label} gameRunning`),
      };
    }
    case 'failed':
      return failure(reply, label);
    case 'deploy-failed':
      knownKeys(reply, ['outcome', 'message'], label);
      return {
        outcome: 'deploy-failed',
        message: text(reply.message, 1, appGameLimits.message, `${label} message`),
      };
    case 'not-ready':
      knownKeys(reply, ['outcome', 'missing'], label);
      return { outcome: 'not-ready', missing: oneOf(reply.missing, appGameMissing, label) };
    case 'stale':
    case 'cancelled':
    case 'busy':
      knownKeys(reply, ['outcome'], label);
      return { outcome: reply.outcome };
    default:
      throw new Error(`${label} outcome is unknown`);
  }
}

export function validateAppLiveTestRequest(value: unknown): AppLiveTestRequest {
  const request = record(value, 'app live test request');
  knownKeys(
    request,
    ['token', 'liveToken', 'app', 'path', 'seed', 'acceptedCrashes'],
    'app live test request',
  );
  return {
    token: token(request.token, 'app live test token'),
    liveToken: token(request.liveToken, 'app live test live token'),
    app: text(request.app, 1, appGameLimits.app, 'app live test app'),
    path: nullablePath(request.path, 'app live test path'),
    ...(request.seed === undefined
      ? {}
      : { seed: integer(request.seed, 0, 0xffff_ffff, 'app live test seed') }),
    acceptedCrashes: crashIds(request.acceptedCrashes, 'app live test accepted crashes'),
  };
}

export function validateAppLiveTestReply(value: unknown): AppLiveTestReply {
  const reply = record(value, 'app live test reply');
  const label = 'app live test reply';
  switch (reply.outcome) {
    case 'started':
      knownKeys(reply, ['outcome', 'seed', 'unverifiedVersion'], label);
      return {
        outcome: 'started',
        seed: integer(reply.seed, 0, 0xffff_ffff, `${label} seed`),
        unverifiedVersion: bool(reply.unverifiedVersion, `${label} unverifiedVersion`),
      };
    case 'crash-warning': {
      knownKeys(reply, ['outcome', 'path', 'name', 'crashes'], label);
      const list = crashes(reply.crashes, `${label} crashes`);
      if (list.length === 0) throw new Error(`${label} names no crash`);
      return {
        outcome: 'crash-warning',
        path: nullablePath(reply.path, `${label} path`),
        name: text(reply.name, 1, appGameLimits.name, `${label} name`),
        crashes: list,
      };
    }
    case 'failed':
      return failure(reply, label);
    case 'live-failed':
      knownKeys(reply, ['outcome', 'message'], label);
      return {
        outcome: 'live-failed',
        message: text(reply.message, 1, appGameLimits.message, `${label} message`),
      };
    case 'not-ready':
      knownKeys(reply, ['outcome', 'missing'], label);
      return { outcome: 'not-ready', missing: oneOf(reply.missing, appGameMissing, label) };
    case 'cancelled':
    case 'busy':
      knownKeys(reply, ['outcome'], label);
      return { outcome: reply.outcome };
    default:
      throw new Error(`${label} outcome is unknown`);
  }
}
