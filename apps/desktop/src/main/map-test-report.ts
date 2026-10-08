import { createHash } from 'node:crypto';
import type { MapTestFinding, MapTestReport, PreviewGenerationInput } from '../shared/api';

export const maximumMapTestReportBytes = 16 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/u;
const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\:]+$/u;

export function validateMapTestReportJson(json: string): MapTestReport {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > maximumMapTestReportBytes) {
    throw new Error('map-test report exceeds the 16 MiB limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('map-test report is not valid JSON');
  }
  const report = record(value, 'map-test report');
  exactKeys(report, [
    '$schema',
    'schemaVersion',
    'compatibility',
    'semanticApiMajor',
    'reportIdentity',
    'status',
    'script',
    'workspaceName',
    'engineVersion',
    'protocolVersion',
    'profile',
    'content',
    'settings',
    'generatedMaps',
    'assertionCount',
    'findings',
    'output',
    'preview',
  ]);
  equal(report.$schema, 'https://rmside.invalid/schemas/map-test-report/v1', '$schema');
  oneOf(report.schemaVersion, ['1.0.0', '1.1.0'], 'schema version');
  equal(report.semanticApiMajor, 2, 'semantic API major');
  const compatibility = record(report.compatibility, 'compatibility');
  exactKeys(compatibility, ['minimumMajor', 'maximumMajor']);
  equal(compatibility.minimumMajor, 1, 'minimum report major');
  equal(compatibility.maximumMajor, 1, 'maximum report major');
  hash(report.reportIdentity, 'report identity');
  oneOf(report.status, ['passed', 'failed'], 'report status');
  const script = record(report.script, 'script identity');
  exactKeys(script, ['name', 'semanticHash']);
  boundedString(script.name, 'script name', 512);
  hash(script.semanticHash, 'script semantic hash');
  boundedString(report.workspaceName, 'workspace name', 256);
  boundedString(report.engineVersion, 'engine version', 64);
  if (
    typeof report.protocolVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(report.protocolVersion)
  ) {
    throw new Error('map-test report protocol version is invalid');
  }
  artifact(report.profile, 'profile');
  artifact(report.content, 'content');
  settings(report.settings);
  boundedInteger(report.generatedMaps, 'generated map count', 0, 4096);
  boundedInteger(report.assertionCount, 'assertion count', 0, 4096);
  if (!Array.isArray(report.findings) || report.findings.length > 4096) {
    throw new Error('map-test report findings are invalid');
  }
  report.findings.forEach((finding, index) =>
    validateFinding(finding, index, report.schemaVersion === '1.1.0'),
  );
  if (!Array.isArray(report.output) || report.output.length > 10_000) {
    throw new Error('map-test report output is invalid');
  }
  report.output.forEach((line, index) => boundedString(line, `output ${index}`, 8192, true));
  if (report.preview !== null) {
    const preview = record(report.preview, 'preview identity');
    exactKeys(preview, ['seed', 'requestHash', 'mapHash']);
    boundedInteger(preview.seed, 'preview seed', 0, 0xffff_ffff);
    hash(preview.requestHash, 'preview request hash');
    hash(preview.mapHash, 'preview map hash');
  }
  const identityCandidate = structuredClone(report);
  identityCandidate.reportIdentity = '';
  const computed = createHash('sha256').update(JSON.stringify(identityCandidate)).digest('hex');
  if (computed !== report.reportIdentity) {
    throw new Error('map-test report identity does not match its bounded contents');
  }
  return structuredClone(report) as unknown as MapTestReport;
}

function validateFinding(
  value: unknown,
  index: number,
  recordsRevision: boolean,
): asserts value is MapTestFinding {
  const finding = record(value, `finding ${index}`);
  exactKeys(finding, [
    'findingId',
    'assertionId',
    'code',
    'message',
    'scriptLine',
    'scriptColumn',
    'seed',
    'sourcePath',
    'sourceGraphHash',
    ...(recordsRevision ? ['requestDocumentRevision'] : []),
    'requestHash',
    'mapHash',
    'measurements',
  ]);
  hash(finding.findingId, 'finding identity');
  hash(finding.assertionId, 'assertion identity');
  if (finding.code !== null) boundedString(finding.code, 'finding code', 256);
  boundedString(finding.message, 'finding message', 8192);
  boundedInteger(finding.scriptLine, 'finding line', 1, 0xffff_ffff);
  boundedInteger(finding.scriptColumn, 'finding column', 1, 0xffff_ffff);
  boundedInteger(finding.seed, 'finding seed', 0, 0xffff_ffff);
  boundedString(finding.sourcePath, 'finding source path', 512);
  if (!relativePathPattern.test(finding.sourcePath as string)) {
    throw new Error('finding source path is not redacted and relative');
  }
  hash(finding.sourceGraphHash, 'finding source graph hash');
  if (recordsRevision) requestRevision(finding.requestDocumentRevision);
  hash(finding.requestHash, 'finding request hash');
  hash(finding.mapHash, 'finding map hash');
  const measurements = record(finding.measurements, 'finding measurements');
  if (Object.keys(measurements).length > 32) throw new Error('finding measurements are excessive');
  for (const [name, measurement] of Object.entries(measurements)) {
    boundedString(name, 'measurement name', 256);
    if (
      measurement !== null &&
      typeof measurement !== 'boolean' &&
      typeof measurement !== 'number' &&
      typeof measurement !== 'string'
    ) {
      throw new Error('finding measurement is not a bounded scalar');
    }
    if (typeof measurement === 'number' && !Number.isFinite(measurement)) {
      throw new Error('finding measurement number is invalid');
    }
    if (typeof measurement === 'string' && measurement.length > 1024) {
      throw new Error('finding measurement string is excessive');
    }
  }
}

function settings(value: unknown): void {
  const setting = record(value, 'report settings');
  exactKeys(setting, ['width', 'height', 'mapSize', 'players', 'setupContext']);
  boundedInteger(setting.width, 'map width', 1, 512);
  boundedInteger(setting.height, 'map height', 1, 512);
  boundedString(setting.mapSize, 'map size', 64);
  if (!Array.isArray(setting.players) || setting.players.length < 1 || setting.players.length > 8) {
    throw new Error('report player settings are invalid');
  }
  for (const playerValue of setting.players) {
    const player = record(playerValue, 'report player');
    exactKeys(player, ['slot', 'team', 'civilizationId', 'color']);
    boundedInteger(player.slot, 'player slot', 1, 255);
    boundedInteger(player.team, 'player team', 0, 255);
    boundedInteger(player.civilizationId, 'player civilization', 0, 0xffff_ffff);
    boundedInteger(player.color, 'player color', 0, 255);
  }
  const setup = record(setting.setupContext, 'setup context');
  exactKeys(setup, [
    'contractVersion',
    'gameMode',
    'startingResources',
    'startingAge',
    'positionPolicy',
  ]);
  const version = record(setup.contractVersion, 'setup version');
  exactKeys(version, ['major', 'minor', 'patch']);
  equal(version.major, 1, 'setup major');
  equal(version.minor, 0, 'setup minor');
  equal(version.patch, 0, 'setup patch');
  oneOf(
    setup.gameMode,
    [
      'random-map',
      'regicide',
      'death-match',
      'king-of-the-hill',
      'wonder-race',
      'defend-the-wonder',
      'turbo-random-map',
      'capture-the-relic',
      'sudden-death',
      'battle-royale',
      'empire-wars',
    ],
    'game mode',
  );
  oneOf(
    setup.startingResources,
    ['standard', 'low', 'medium', 'high', 'ultra-high', 'infinite', 'random'],
    'starting resources',
  );
  oneOf(
    setup.startingAge,
    ['standard', 'dark-age', 'feudal-age', 'castle-age', 'imperial-age', 'post-imperial-age'],
    'starting age',
  );
  oneOf(setup.positionPolicy, ['random', 'fixed', 'team-together'], 'position policy');
}

function artifact(value: unknown, label: string): void {
  const identity = record(value, label);
  exactKeys(identity, ['id', 'version', 'hash']);
  boundedString(identity.id, `${label} id`, 256);
  boundedString(identity.version, `${label} version`, 128);
  hash(identity.hash, `${label} hash`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('map-test report contains missing or unsupported fields');
  }
}

function boundedString(value: unknown, label: string, maximum: number, empty = false): void {
  if (typeof value !== 'string' || (!empty && value.length < 1) || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is invalid`);
  }
}

function hash(value: unknown, label: string): void {
  if (typeof value !== 'string' || !hashPattern.test(value)) throw new Error(`${label} is invalid`);
}

function oneOf(value: unknown, values: readonly string[], label: string): void {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${label} is invalid`);
}

function equal(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`${label} is unsupported`);
}

function requestRevision(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) {
    throw new Error('map-test finding request revision is not canonical unsigned decimal');
  }
  const revision = BigInt(value);
  if (revision > 18_446_744_073_709_551_615n) {
    throw new Error('map-test finding request revision exceeds u64');
  }
  return revision;
}

export function mapTestReplayGenerationInput(
  currentSource: PreviewGenerationInput,
  currentCatalogRevision: number,
  report: MapTestReport,
  finding: MapTestFinding,
): PreviewGenerationInput {
  let revision = currentCatalogRevision;
  if (report.schemaVersion === '1.1.0') {
    const historical = requestRevision(finding.requestDocumentRevision);
    if (historical > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        'the recorded finding request revision exceeds the desktop replay integer range',
      );
    }
    revision = Number(historical);
  }
  return { ...currentSource, documentRevision: revision };
}

export function currentMapTestReplaySourceInput(
  source: PreviewGenerationInput,
  latestDocument: { version: number; text: string } | undefined,
): PreviewGenerationInput {
  return latestDocument
    ? { ...source, documentRevision: latestDocument.version, source: latestDocument.text }
    : source;
}
