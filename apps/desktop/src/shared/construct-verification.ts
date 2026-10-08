import { activeTranslator, t } from './i18n/translator';

export interface ConstructReference {
  context: string;
  name: string;
  firstOperationIndex: number;
}

export type ConstructVerificationStatus = 'all-certified' | 'uncertified-constructs';

export interface ConstructVerification {
  status: ConstructVerificationStatus;
  uncertified: ConstructReference[];
  omittedUncertified: number;
  executedConstructs: number;
  tableId: string;
}

export const maximumNamedUncertifiedConstructs = 64;
const contextPattern = /^(?:|<[A-Z][A-Z_]{0,62}>|create_[a-z][a-z0-9_]{0,56})$/u;
const namePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const tableIdPattern = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const maximumCount = 1_000_000;

function isCount(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximumCount
  );
}

function isConstructReference(value: unknown): value is ConstructReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'context,firstOperationIndex,name' &&
    isCount(record.firstOperationIndex) &&
    typeof record.context === 'string' &&
    typeof record.name === 'string' &&
    contextPattern.test(record.context) &&
    namePattern.test(record.name)
  );
}

export function parseConstructVerification(value: unknown): ConstructVerification | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !==
      'executedConstructs,omittedUncertified,status,tableId,uncertified' ||
    (record.status !== 'all-certified' && record.status !== 'uncertified-constructs') ||
    !Array.isArray(record.uncertified) ||
    record.uncertified.length > maximumNamedUncertifiedConstructs ||
    !record.uncertified.every(isConstructReference) ||
    !isCount(record.omittedUncertified) ||
    !isCount(record.executedConstructs) ||
    typeof record.tableId !== 'string' ||
    !tableIdPattern.test(record.tableId)
  ) {
    return null;
  }
  const uncertified = record.uncertified as ConstructReference[];
  const sorted = uncertified.every((construct, index) => {
    if (index === 0) return true;
    const previous = uncertified[index - 1]!;
    return (
      previous.context < construct.context ||
      (previous.context === construct.context && previous.name < construct.name)
    );
  });
  const total = uncertified.length + record.omittedUncertified;
  const consistent =
    record.status === 'all-certified'
      ? total === 0
      : uncertified.length > 0 &&
        (record.omittedUncertified === 0 ||
          uncertified.length === maximumNamedUncertifiedConstructs) &&
        total <= record.executedConstructs;
  if (!sorted || !consistent) return null;
  return {
    status: record.status,
    uncertified: uncertified.map(({ context, name, firstOperationIndex }) => ({
      context,
      name,
      firstOperationIndex,
    })),
    omittedUncertified: record.omittedUncertified,
    executedConstructs: record.executedConstructs,
    tableId: record.tableId,
  };
}

export function withValidatedConstructVerification<T extends { constructVerification?: unknown }>(
  result: T,
): T {
  if (!result || typeof result !== 'object' || result.constructVerification === undefined) {
    return result;
  }
  const verification = parseConstructVerification(result.constructVerification);
  if (verification) result.constructVerification = verification;
  else delete result.constructVerification;
  return result;
}

export function constructLabel({
  context,
  name,
}: Pick<ConstructReference, 'context' | 'name'>): string {
  return context ? t('message.construct.in-context', { name, context }) : name;
}

function constructKey({ context, name }: Pick<ConstructReference, 'context' | 'name'>): string {
  return context ? `${name} in ${context}` : name;
}

export const constructsNamedInMessage = 6;

export function uncertifiedConstructList(
  verification: ConstructVerification,
  limit: number = constructsNamedInMessage,
): string {
  const named = verification.uncertified.slice(0, Math.max(1, limit));
  const more = uncertifiedConstructCount(verification) - named.length;
  const names = activeTranslator().formatList(named.map(constructLabel), 'unit');
  return more > 0 ? t('message.construct.list-more', { names, more }) : names;
}

export function uncertifiedConstructCount(verification: ConstructVerification): number {
  return verification.uncertified.length + verification.omittedUncertified;
}

export function uncertifiedConstructKey(verification: ConstructVerification | undefined): string {
  if (verification?.status !== 'uncertified-constructs') return '';
  return [
    ...verification.uncertified.map(constructKey),
    `+${verification.omittedUncertified}`,
  ].join('\n');
}
