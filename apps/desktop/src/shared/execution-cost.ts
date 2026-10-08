export const executionCostContractMajor = 1;
export const maximumExecutionGroups = 16;
export const maximumExecutionSteps = 32;
export const maximumStepCounters = 8;

export const executionGroupIds = [
  'parse',
  'setup',
  'land',
  'elevation',
  'cliffs',
  'terrain',
  'connections',
  'objects',
  'finalize',
] as const;
export type ExecutionGroupId = (typeof executionGroupIds)[number];

export const executionStepIds = [
  'parse.script',
  'setup.players',
  'land.generate',
  'elevation.generate',
  'cliffs.generate',
  'terrain.generate',
  'connections.generate',
  'objects.generate',
  'finalize.game-mode',
  'finalize.object-order',
  'finalize.composite-terrain',
] as const;
export type ExecutionStepId = (typeof executionStepIds)[number];

export const executionCounterIds = [
  'operations',
  'rng-draws',
  'candidates-examined',
  'tiles-accepted',
  'path-searches',
  'path-work',
  'placement-rejections',
  'objects-placed',
] as const;
export type ExecutionCounterId = (typeof executionCounterIds)[number];

export type ExecutionCostContext = 'isolated' | 'map-test';

export interface ExecutionCostCounter {
  counter: ExecutionCounterId;
  value: number;
}

export interface ExecutionCostStep {
  step: ExecutionStepId;
  durationUs: number;
  counters: ExecutionCostCounter[];
}

export interface ExecutionCostGroup {
  group: ExecutionGroupId;
  durationUs: number;
  steps: ExecutionCostStep[];
}

export interface ExecutionCostSummary {
  contractMajor: 1;
  contractMinor: number;
  totalUs: number;
  groups: ExecutionCostGroup[];
  context: ExecutionCostContext;
}

export type ExecutionProgressEvent =
  | {
      requestId: string;
      kind: 'started';
      plan: ExecutionStepId[];
    }
  | {
      requestId: string;
      kind: 'step-completed';
      step: ExecutionCostStep;
      completedSteps: number;
      measuredTotalUs: number;
      elapsedUs: number;
    };

export function executionStepGroup(step: ExecutionStepId): ExecutionGroupId {
  return step.slice(0, step.indexOf('.')) as ExecutionGroupId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`execution-cost ${label} is not a bounded list`);
  }
  return value;
}

function microseconds(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`execution-cost ${label} is not a non-negative safe integer`);
  }
  return value;
}

function allowlisted<T extends string>(
  value: unknown,
  allowlist: readonly T[],
  label: string,
): { id: T; index: number } {
  const index = typeof value === 'string' ? allowlist.indexOf(value as T) : -1;
  if (index < 0) throw new Error(`execution-cost ${label} is unknown`);
  return { id: allowlist[index]!, index };
}

export function validateExecutionCostStep(value: unknown): ExecutionCostStep {
  if (!isRecord(value)) throw new Error('execution-cost step is invalid');
  const step = allowlisted(value.step, executionStepIds, 'step').id;
  const counters: ExecutionCostCounter[] = [];
  let previousCounter = -1;
  for (const entry of boundedArray(value.counters, maximumStepCounters, 'counters')) {
    if (!isRecord(entry)) throw new Error('execution-cost counter is invalid');
    const counter = allowlisted(entry.counter, executionCounterIds, 'counter');
    if (counter.index <= previousCounter) {
      throw new Error('execution-cost counters are not unique and ordered');
    }
    previousCounter = counter.index;
    counters.push({ counter: counter.id, value: microseconds(entry.value, 'counter value') });
  }
  return { step, durationUs: microseconds(value.durationUs, 'step duration'), counters };
}

export function validateExecutionCostSummary(value: unknown): ExecutionCostSummary {
  if (!isRecord(value)) throw new Error('execution-cost summary is invalid');
  if (value.contractMajor !== executionCostContractMajor) {
    throw new Error('execution-cost contract major is unsupported');
  }
  const contractMinor = microseconds(value.contractMinor, 'contract minor');
  if (value.context !== 'isolated' && value.context !== 'map-test') {
    throw new Error('execution-cost context is unsupported');
  }
  const rawGroups = boundedArray(value.groups, maximumExecutionGroups, 'groups');
  if (rawGroups.length === 0) throw new Error('execution-cost summary has no groups');
  const groups: ExecutionCostGroup[] = [];
  let stepCount = 0;
  let previousGroup = -1;
  let previousStep = -1;
  let total = 0;
  for (const rawGroup of rawGroups) {
    if (!isRecord(rawGroup)) throw new Error('execution-cost group is invalid');
    const group = allowlisted(rawGroup.group, executionGroupIds, 'group');
    if (group.index <= previousGroup) {
      throw new Error('execution-cost groups are not unique and ordered');
    }
    previousGroup = group.index;
    const rawSteps = boundedArray(rawGroup.steps, maximumExecutionSteps, 'steps');
    stepCount += rawSteps.length;
    if (rawSteps.length === 0 || stepCount > maximumExecutionSteps) {
      throw new Error('execution-cost step count is out of bounds');
    }
    const steps = rawSteps.map(validateExecutionCostStep);
    let sum = 0;
    for (const step of steps) {
      const index = executionStepIds.indexOf(step.step);
      if (index <= previousStep || executionStepGroup(step.step) !== group.id) {
        throw new Error('execution-cost steps are not ordered within their groups');
      }
      previousStep = index;
      sum += step.durationUs;
    }
    const durationUs = microseconds(rawGroup.durationUs, 'group duration');
    if (!Number.isSafeInteger(sum) || sum !== durationUs) {
      throw new Error('execution-cost group duration differs from its steps');
    }
    total += durationUs;
    groups.push({ group: group.id, durationUs, steps });
  }
  const totalUs = microseconds(value.totalUs, 'total');
  if (!Number.isSafeInteger(total) || total !== totalUs) {
    throw new Error('execution-cost total differs from its groups');
  }
  return { contractMajor: 1, contractMinor, totalUs, groups, context: value.context };
}

export function parseExecutionCostSummary(value: unknown): ExecutionCostSummary | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return validateExecutionCostSummary(value);
  } catch {
    return undefined;
  }
}

export function validateExecutionProgressEvent(value: unknown): ExecutionProgressEvent {
  if (!isRecord(value)) throw new Error('execution progress is invalid');
  const requestId = value.requestId;
  if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 512) {
    throw new Error('execution progress request identity is invalid');
  }
  if (value.kind === 'started') {
    const plan = boundedArray(value.plan, maximumExecutionSteps, 'plan').map((step) =>
      allowlisted(step, executionStepIds, 'plan step'),
    );
    if (
      plan.length === 0 ||
      plan.some((step, index) => index > 0 && step.index <= plan[index - 1]!.index)
    ) {
      throw new Error('execution progress plan is not ordered');
    }
    return { requestId, kind: 'started', plan: plan.map((step) => step.id) };
  }
  if (value.kind === 'step-completed') {
    const completedSteps = microseconds(value.completedSteps, 'completed steps');
    if (completedSteps < 1 || completedSteps > maximumExecutionSteps) {
      throw new Error('execution progress completed steps is out of bounds');
    }
    return {
      requestId,
      kind: 'step-completed',
      step: validateExecutionCostStep(value.step),
      completedSteps,
      measuredTotalUs: microseconds(value.measuredTotalUs, 'measured total'),
      elapsedUs: microseconds(value.elapsedUs, 'elapsed time'),
    };
  }
  throw new Error('execution progress kind is unsupported');
}
