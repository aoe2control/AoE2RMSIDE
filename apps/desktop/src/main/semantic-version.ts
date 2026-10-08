export const maximumSemanticVersionLength = 128;

export interface SemanticVersion {
  readonly core: readonly [string, string, string];
  readonly prerelease: readonly string[];
  readonly build: readonly string[];
}

const numericIdentifier = /^(?:0|[1-9][0-9]*)$/u;
const prereleaseIdentifier = /^(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)$/u;
const buildIdentifier = /^[0-9A-Za-z-]+$/u;

export function parseSemanticVersion(text: unknown): SemanticVersion | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (text.length > maximumSemanticVersionLength) return null;
  const plus = text.indexOf('+');
  const withoutBuild = plus === -1 ? text : text.slice(0, plus);
  const buildText = plus === -1 ? null : text.slice(plus + 1);
  const dash = withoutBuild.indexOf('-');
  const coreText = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prereleaseText = dash === -1 ? null : withoutBuild.slice(dash + 1);
  const core = coreText.split('.');
  if (core.length !== 3 || !core.every((part) => numericIdentifier.test(part))) return null;
  const prerelease = prereleaseText === null ? [] : prereleaseText.split('.');
  if (prereleaseText !== null && !prerelease.every((part) => prereleaseIdentifier.test(part))) {
    return null;
  }
  const build = buildText === null ? [] : buildText.split('.');
  if (buildText !== null && !build.every((part) => buildIdentifier.test(part))) return null;
  return {
    core: [core[0]!, core[1]!, core[2]!],
    prerelease: Object.freeze(prerelease),
    build: Object.freeze(build),
  };
}

export function parseReleaseTag(tag: unknown): SemanticVersion | null {
  if (typeof tag !== 'string') return null;
  return parseSemanticVersion(tag.startsWith('v') ? tag.slice(1) : tag);
}

export function isPrerelease(version: SemanticVersion): boolean {
  return version.prerelease.length > 0;
}

export function formatSemanticVersion(version: SemanticVersion): string {
  const core = version.core.join('.');
  return version.prerelease.length === 0 ? core : `${core}-${version.prerelease.join('.')}`;
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = numericIdentifier.test(left);
  const rightNumeric = numericIdentifier.test(right);
  if (leftNumeric && rightNumeric) return compareNumeric(left, right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumeric(left.core[index]!, right.core[index]!);
    if (order !== 0) return order;
  }
  const leftPre = left.prerelease;
  const rightPre = right.prerelease;
  if (leftPre.length === 0 || rightPre.length === 0) {
    return leftPre.length === rightPre.length ? 0 : leftPre.length === 0 ? 1 : -1;
  }
  const shared = Math.min(leftPre.length, rightPre.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifiers(leftPre[index]!, rightPre[index]!);
    if (order !== 0) return order;
  }
  return leftPre.length === rightPre.length ? 0 : leftPre.length < rightPre.length ? -1 : 1;
}
