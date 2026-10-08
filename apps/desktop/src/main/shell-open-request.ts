import { basename, isAbsolute, resolve } from 'node:path';
import type { WorkspaceDocument, WorkspaceFolder, WorkspaceOpenResult } from '../shared/api';
import type { OutputText } from '../shared/output-message';

export const shellOpenLimits = Object.freeze({
  maximumArguments: 256,
  maximumTargets: 64,
  maximumTargetLength: 32_768,
  maximumAggregateLength: 262_144,
  maximumPendingRequests: 16,
  maximumReportedRejections: 8,
  maximumDisplayLength: 1024,
});

export type ShellOpenRefusal = 'too-many-targets' | 'too-long' | 'too-many-requests';

export interface ShellOpenRequest {
  workingDirectory: string;
  targets: string[];
  refusal: ShellOpenRefusal | null;
}

export interface ForwardedOpenRequest extends ShellOpenRequest {
  kind: 'rmside-open-request';
  version: 1;
}

export interface CommandLineOptions {
  skipLeadingPositional: boolean;
}

export function commandLineOpenRequest(
  argv: readonly unknown[],
  workingDirectory: string,
  options: CommandLineOptions,
): ShellOpenRequest {
  const targets: string[] = [];
  if (!Array.isArray(argv) || argv.length > shellOpenLimits.maximumArguments + 1) {
    return { workingDirectory, targets, refusal: 'too-many-targets' };
  }
  let switchesEnded = false;
  let applicationPathSkipped = !options.skipLeadingPositional;
  let aggregate = 0;
  for (const argument of argv.slice(1)) {
    if (typeof argument !== 'string' || argument.length === 0) continue;
    if (!switchesEnded) {
      if (argument === '--') {
        switchesEnded = true;
        continue;
      }
      if (argument.startsWith('-') || /^\/[A-Za-z?]/u.test(argument)) continue;
    }
    if (!applicationPathSkipped) {
      applicationPathSkipped = true;
      continue;
    }
    if (argument.length > shellOpenLimits.maximumTargetLength) {
      return { workingDirectory, targets: [], refusal: 'too-long' };
    }
    aggregate += argument.length;
    if (aggregate > shellOpenLimits.maximumAggregateLength) {
      return { workingDirectory, targets: [], refusal: 'too-long' };
    }
    if (targets.length >= shellOpenLimits.maximumTargets) {
      return { workingDirectory, targets: [], refusal: 'too-many-targets' };
    }
    targets.push(argument);
  }
  return { workingDirectory, targets, refusal: null };
}

export function forwardedOpenRequest(request: ShellOpenRequest): ForwardedOpenRequest {
  return {
    kind: 'rmside-open-request',
    version: 1,
    workingDirectory: request.workingDirectory,
    targets: [...request.targets],
    refusal: request.refusal,
  };
}

export function parseForwardedOpenRequest(value: unknown): ShellOpenRequest | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'rmside-open-request' || record.version !== 1) return null;
  const { workingDirectory, targets, refusal } = record;
  if (
    typeof workingDirectory !== 'string' ||
    workingDirectory.length > shellOpenLimits.maximumTargetLength ||
    !Array.isArray(targets) ||
    targets.length > shellOpenLimits.maximumTargets ||
    !(
      refusal === null ||
      refusal === 'too-many-targets' ||
      refusal === 'too-long' ||
      refusal === 'too-many-requests'
    )
  ) {
    return null;
  }
  let aggregate = 0;
  for (const target of targets) {
    if (
      typeof target !== 'string' ||
      target.length < 1 ||
      target.length > shellOpenLimits.maximumTargetLength
    ) {
      return null;
    }
    aggregate += target.length;
  }
  if (aggregate > shellOpenLimits.maximumAggregateLength) return null;
  return { workingDirectory, targets: [...(targets as string[])], refusal };
}

export function absoluteTargetSpelling(target: string, workingDirectory: string): string | null {
  let spelling = target.replace(/^"+/u, '').replace(/"+$/u, '');
  if (spelling.length === 0 || spelling.includes('"') || spelling.includes('\0')) return null;
  if (/^[\\/]{2}[.?][\\/]/u.test(spelling)) return null;
  if (/^[A-Za-z]:$/u.test(spelling)) spelling = `${spelling}\\`;
  if (isAbsolute(spelling) && !/^[\\/](?![\\/])/u.test(spelling)) return resolve(spelling);
  if (/^[\\/]/u.test(spelling) || /^[A-Za-z]:(?![\\/])/u.test(spelling)) return null;
  if (!isAbsolute(workingDirectory) || /^[\\/](?![\\/])/u.test(workingDirectory)) return null;
  return resolve(workingDirectory, spelling);
}

export type ShellOpenRejectionReason =
  'invalid' | 'missing' | 'unsupported' | 'second-folder' | 'unreadable';

export interface ShellOpenRejection {
  target: string;
  reason: ShellOpenRejectionReason;
  detail?: string;
}

export interface ShellOpenPlan {
  folder: string | null;
  files: string[];
  rejected: ShellOpenRejection[];
  refusal: ShellOpenRefusal | null;
}

export interface ShellOpenFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}

export async function planShellOpen(
  request: ShellOpenRequest,
  fileSystem: ShellOpenFileSystem,
  isSupportedFile: (path: string) => boolean,
): Promise<ShellOpenPlan | null> {
  if (request.refusal) {
    return { folder: null, files: [], rejected: [], refusal: request.refusal };
  }
  if (request.targets.length === 0) return null;
  const plan: ShellOpenPlan = { folder: null, files: [], rejected: [], refusal: null };
  const seen = new Set<string>();
  for (const target of request.targets) {
    const spelling = absoluteTargetSpelling(target, request.workingDirectory);
    if (!spelling) {
      plan.rejected.push({ target: displayTarget(target), reason: 'invalid' });
      continue;
    }
    let canonical: string;
    let kind: 'file' | 'folder' | 'other';
    try {
      canonical = resolve(await fileSystem.realpath(spelling));
      const metadata = await fileSystem.stat(canonical);
      kind = metadata.isDirectory() ? 'folder' : metadata.isFile() ? 'file' : 'other';
    } catch {
      plan.rejected.push({ target: displayTarget(spelling), reason: 'missing' });
      continue;
    }
    const key = canonical.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === 'folder') {
      if (plan.folder === null) plan.folder = canonical;
      else plan.rejected.push({ target: displayTarget(canonical), reason: 'second-folder' });
    } else if (kind === 'file' && isSupportedFile(canonical)) {
      plan.files.push(canonical);
    } else {
      plan.rejected.push({ target: displayTarget(canonical), reason: 'unsupported' });
    }
  }
  return plan;
}

function displayTarget(target: string): string {
  return target.length <= shellOpenLimits.maximumDisplayLength
    ? target
    : `${target.slice(0, shellOpenLimits.maximumDisplayLength - 1)}…`;
}

export interface ShellOpenOutcome {
  opened: WorkspaceOpenResult | null;
  rejected: ShellOpenRejection[];
  refusal: ShellOpenRefusal | null;
}

export async function executeShellOpenPlan(
  plan: ShellOpenPlan,
  open: (paths: string[]) => Promise<WorkspaceOpenResult>,
): Promise<ShellOpenOutcome> {
  const rejected = [...plan.rejected];
  if (plan.refusal) return { opened: null, rejected, refusal: plan.refusal };
  const documents: WorkspaceDocument[] = [];
  let folder: WorkspaceFolder | null = null;
  for (const file of plan.files) {
    try {
      documents.push(...(await open([file])).documents);
    } catch (error) {
      rejected.push({ target: displayTarget(file), reason: 'unreadable', detail: message(error) });
    }
  }
  if (plan.folder) {
    try {
      folder = (await open([plan.folder])).folder;
    } catch (error) {
      rejected.push({
        target: displayTarget(plan.folder),
        reason: 'unreadable',
        detail: message(error),
      });
    }
  }
  const opened = documents.length > 0 || folder ? { documents, folder } : null;
  return { opened, rejected, refusal: null };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ShellOpenQueue {
  private readonly pending: Array<Promise<ShellOpenPlan | null>> = [];
  private overflowed = false;

  enqueue(plan: Promise<ShellOpenPlan | null>): boolean {
    const settled = plan.catch(() => null);
    if (this.pending.length >= shellOpenLimits.maximumPendingRequests) {
      this.overflowed = true;
      return false;
    }
    this.pending.push(settled);
    return true;
  }

  async take(): Promise<ShellOpenPlan | null> {
    while (this.pending.length > 0) {
      const plan = await this.pending.shift()!;
      if (plan) return plan;
    }
    if (this.overflowed) {
      this.overflowed = false;
      return { folder: null, files: [], rejected: [], refusal: 'too-many-requests' };
    }
    return null;
  }

  get size(): number {
    return this.pending.length;
  }
}

export interface ShellOpenNotice {
  code: 'files.shell-open-rejected' | 'files.shell-open-refused';
  headline: OutputText;
  cause: OutputText;
  detail?: string;
}

export function shellOpenNotices(
  outcome: Pick<ShellOpenOutcome, 'rejected' | 'refusal' | 'opened'>,
  mapTests: boolean,
): ShellOpenNotice[] {
  if (outcome.refusal) {
    const cause: OutputText =
      outcome.refusal === 'too-many-targets'
        ? {
            id: 'file-actions.shell-open.refused.too-many-targets',
            args: { count: shellOpenLimits.maximumTargets },
          }
        : outcome.refusal === 'too-long'
          ? { id: 'file-actions.shell-open.refused.too-long' }
          : { id: 'file-actions.shell-open.refused.too-many-requests' };
    return [
      {
        code: 'files.shell-open-refused',
        headline: { id: 'file-actions.shell-open.refused' },
        cause,
      },
    ];
  }
  const notices: ShellOpenNotice[] = [];
  const openedFolder = outcome.opened?.folder?.path;
  for (const rejection of outcome.rejected.slice(0, shellOpenLimits.maximumReportedRejections)) {
    const name = basename(rejection.target) || rejection.target;
    const cause: OutputText =
      rejection.reason === 'missing'
        ? { id: 'file-actions.shell-open.rejected.missing' }
        : rejection.reason === 'invalid'
          ? { id: 'file-actions.shell-open.rejected.invalid' }
          : rejection.reason === 'unsupported'
            ? {
                id: mapTests
                  ? 'file-actions.shell-open.rejected.unsupported.map-tests'
                  : 'file-actions.shell-open.rejected.unsupported',
              }
            : rejection.reason === 'second-folder'
              ? openedFolder
                ? {
                    id: 'file-actions.shell-open.rejected.second-folder.opened',
                    args: { folder: basename(openedFolder) || openedFolder },
                  }
                : { id: 'file-actions.shell-open.rejected.second-folder' }
              : { id: 'file-actions.shell-open.rejected.unreadable' };
    notices.push({
      code: 'files.shell-open-rejected',
      headline: { id: 'file-actions.shell-open.rejected', args: { name } },
      cause,
      detail: rejection.detail ? `${rejection.target}\n${rejection.detail}` : rejection.target,
    });
  }
  const remaining = outcome.rejected.length - shellOpenLimits.maximumReportedRejections;
  if (remaining > 0) {
    notices.push({
      code: 'files.shell-open-rejected',
      headline: { id: 'file-actions.shell-open.rejected.more', args: { count: remaining } },
      cause: { id: 'file-actions.shell-open.rejected.more.cause' },
    });
  }
  return notices;
}
