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
  oneOf(report.schemaVersion, ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0'], 'schema version');
  const recordsRevision = report.schemaVersion !== '1.0.0';
  const recordsQuality = report.schemaVersion === '1.4.0';
  const recordsGameCrashes =
    report.schemaVersion === '1.2.0' || report.schemaVersion === '1.3.0' || recordsQuality;
  const recordsXsConstants =
    report.schemaVersion === '1.3.0' || (recordsQuality && Object.hasOwn(report, 'xsConstants'));
  const qualityKeys = recordsQuality
    ? qualityReportKeys.filter((key) => Object.hasOwn(report, key))
    : [];
  if (recordsQuality && qualityKeys.length === 0) {
    throw new Error('map-test report 1.4 carries no quality data');
  }
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
    ...(recordsGameCrashes ? ['gameCrashes'] : []),
    ...(recordsXsConstants ? ['xsConstants'] : []),
    ...qualityKeys,
  ]);
  equal(report.$schema, 'https://rmside.invalid/schemas/map-test-report/v1', '$schema');
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
  const settingsVariantCount = recordsQuality ? settingsVariants(report.settingsVariants) : null;
  report.findings.forEach((finding, index) =>
    validateFinding(finding, index, recordsRevision, settingsVariantCount),
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
  if (recordsGameCrashes) gameCrashes(report.gameCrashes);
  if (recordsXsConstants) {
    const constants = record(report.xsConstants, 'XS constants');
    exactKeys(constants, ['sha256']);
    hash(constants.sha256, 'XS constants SHA-256');
  }
  if (recordsQuality) {
    if (Object.hasOwn(report, 'qualityLibrary')) {
      const library = record(report.qualityLibrary, 'quality library');
      exactKeys(library, ['version', 'sha256']);
      boundedString(library.version, 'quality library version', 32);
      if (!/^\d+\.\d+\.\d+$/u.test(library.version as string)) {
        throw new Error('quality library version is invalid');
      }
      hash(library.sha256, 'quality library SHA-256');
    }
    if (Object.hasOwn(report, 'walkRules')) qualityId(report.walkRules, 'walk rules');
    if (Object.hasOwn(report, 'quality')) quality(report.quality, settingsVariantCount ?? 0);
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
  settingsVariantCount: number | null,
): asserts value is MapTestFinding {
  const finding = record(value, `finding ${index}`);
  const recordsSettingsIndex =
    settingsVariantCount !== null && Object.hasOwn(finding, 'settingsIndex');
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
    ...(recordsSettingsIndex ? ['settingsIndex'] : []),
  ]);
  hash(finding.findingId, 'finding identity');
  if (recordsSettingsIndex) settingsIndex(finding.settingsIndex, settingsVariantCount ?? 0);
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

const crashIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function gameCrashes(value: unknown): void {
  const crashes = record(value, 'game crashes');
  exactKeys(crashes, ['sources']);
  if (!Array.isArray(crashes.sources) || crashes.sources.length > 64) {
    throw new Error('game crash sources are invalid');
  }
  let previousPath: string | null = null;
  for (const [index, sourceValue] of crashes.sources.entries()) {
    const source = record(sourceValue, `game crash source ${index}`);
    exactKeys(source, ['sourcePath', 'sampledMaps', 'crashedMaps', 'crashes']);
    boundedString(source.sourcePath, 'game crash source path', 512);
    const sourcePath = source.sourcePath as string;
    if (!relativePathPattern.test(sourcePath)) {
      throw new Error('game crash source path is not redacted and relative');
    }
    if (previousPath !== null && !(previousPath < sourcePath)) {
      throw new Error('game crash sources are not sorted and unique');
    }
    previousPath = sourcePath;
    boundedInteger(source.sampledMaps, 'game crash sampled maps', 1, 4096);
    boundedInteger(source.crashedMaps, 'game crash crashed maps', 0, 4096);
    if (!Array.isArray(source.crashes) || source.crashes.length > 256) {
      throw new Error('game crash entries are invalid');
    }
    let previousId: string | null = null;
    let crashedMaps = 0;
    for (const crashValue of source.crashes) {
      const crash = record(crashValue, 'game crash');
      exactKeys(crash, ['crashId', 'maps', 'seeds', 'omittedSeeds']);
      boundedString(crash.crashId, 'game crash id', 64);
      const crashId = crash.crashId as string;
      if (!crashIdPattern.test(crashId)) throw new Error('game crash id is invalid');
      if (previousId !== null && !(previousId < crashId)) {
        throw new Error('game crashes are not sorted and unique');
      }
      previousId = crashId;
      boundedInteger(crash.maps, 'game crash maps', 1, 4096);
      boundedInteger(crash.omittedSeeds, 'game crash omitted seeds', 0, 4096);
      if (!Array.isArray(crash.seeds) || crash.seeds.length > 32) {
        throw new Error('game crash seeds are invalid');
      }
      let previousSeed = -1;
      for (const seed of crash.seeds) {
        boundedInteger(seed, 'game crash seed', 0, 0xffff_ffff);
        if ((seed as number) <= previousSeed) {
          throw new Error('game crash seeds are not ascending and unique');
        }
        previousSeed = seed as number;
      }
      if (crash.seeds.length + (crash.omittedSeeds as number) > (crash.maps as number)) {
        throw new Error('game crash seeds exceed its maps');
      }
      crashedMaps += crash.maps as number;
    }
    if (crashedMaps !== source.crashedMaps || crashedMaps > (source.sampledMaps as number)) {
      throw new Error('game crash counts are inconsistent');
    }
  }
}

function settings(value: unknown): void {
  const setting = record(value, 'report settings');
  exactKeys(setting, ['width', 'height', 'mapSize', 'players', 'setupContext']);
  lobby(setting);
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

function lobby(setting: Record<string, unknown>): void {
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
}

const qualityReportKeys = ['settingsVariants', 'qualityLibrary', 'walkRules', 'quality'];
const maximumQualityBlockBytes = 16 * 1024;
const maximumSettingsVariants = 16;
const qualityLevels = ['failure', 'warning', 'advice'] as const;
const qualityIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const oneLinePattern = /^[^\u0000-\u001f\u007f-\u009f]+$/u;

function settingsVariants(value: unknown): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumSettingsVariants) {
    throw new Error('report settings variants are invalid');
  }
  for (const [index, variantValue] of value.entries()) {
    const variant = record(variantValue, `settings variant ${index}`);
    exactKeys(variant, ['width', 'height', 'mapSize', 'players']);
    lobby(variant);
  }
  return value.length;
}

function settingsIndex(value: unknown, variants: number): void {
  if (variants === 0) throw new Error('settings index names no settings variant');
  boundedInteger(value, 'settings index', 0, variants - 1);
}

function qualityId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 48 || !qualityIdPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function qualityIds(value: unknown, label: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 32) {
    throw new Error(`${label} are invalid`);
  }
  const ids = value.map((id) => qualityId(id, label));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} are not unique`);
  return ids;
}

function oneLine(value: unknown, label: string, maximumBytes: number): void {
  if (
    typeof value !== 'string' ||
    !oneLinePattern.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function qualityValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is invalid`);
  return value as number;
}

function quality(value: unknown, variants: number): void {
  const block = record(value, 'quality');
  exactKeys(block, [
    'catalog',
    'seedStart',
    'seedCount',
    'samples',
    'failedSamples',
    'cases',
    'skipped',
    'result',
    'counts',
    'items',
    'passed',
    'omittedItems',
  ]);
  if (Buffer.byteLength(JSON.stringify(block), 'utf8') > maximumQualityBlockBytes) {
    throw new Error('quality block exceeds 16 KiB');
  }
  boundedString(block.catalog, 'quality catalogue version', 32);
  if (!/^1\.\d+\.\d+$/u.test(block.catalog as string)) {
    throw new Error('quality catalogue version is unsupported');
  }
  boundedInteger(block.seedStart, 'quality seed start', 0, 0xffff_ffff);
  boundedInteger(block.seedCount, 'quality seed count', 1, 4096);
  boundedInteger(block.samples, 'quality samples', 1, 4096);
  const samples = block.samples as number;
  boundedInteger(block.failedSamples, 'quality failed samples', 0, samples);
  const cases = qualityIds(block.cases, 'quality cases', 1);
  if (!cases.includes('generation')) throw new Error('quality cases lack generation');
  if (!Array.isArray(block.skipped) || block.skipped.length > 32) {
    throw new Error('skipped quality cases are invalid');
  }
  const skipped = block.skipped.map((skipValue, index) => {
    const skip = record(skipValue, `skipped quality case ${index}`);
    exactKeys(skip, ['case', 'reason']);
    oneOf(skip.reason, ['not-selected', 'not-applicable', 'no-samples'], 'quality skip reason');
    return qualityId(skip.case, 'skipped quality case');
  });
  if (new Set([...cases, ...skipped]).size !== cases.length + skipped.length) {
    throw new Error('a quality case is both run and skipped');
  }
  const passed = qualityIds(block.passed, 'passed quality cases', 0);
  if (passed.some((id) => !cases.includes(id)))
    throw new Error('a passed quality case did not run');
  oneOf(block.result, ['passed', 'warnings', 'failed'], 'quality result');
  const counts = record(block.counts, 'quality counts');
  exactKeys(counts, ['failures', 'warnings', 'advice']);
  boundedInteger(counts.failures, 'quality failures', 0, 0xffff_ffff);
  boundedInteger(counts.warnings, 'quality warnings', 0, 0xffff_ffff);
  boundedInteger(counts.advice, 'quality advice', 0, 0xffff_ffff);
  boundedInteger(block.omittedItems, 'omitted quality items', 0, 0xffff_ffff);
  if (!Array.isArray(block.items) || block.items.length > 32 * 6) {
    throw new Error('quality items are invalid');
  }
  const kept = { failure: 0, warning: 0, advice: 0 };
  const perCase = new Map<string, number>();
  const codes = new Set<string>();
  let previousRank = 0;
  for (const [index, itemValue] of block.items.entries()) {
    const item = record(itemValue, `quality item ${index}`);
    const hasMetric = Object.hasOwn(item, 'metric');
    exactKeys(item, [
      'case',
      'code',
      'level',
      'message',
      ...(hasMetric ? ['metric'] : []),
      'bad',
      'of',
      'worst',
    ]);
    const caseId = qualityId(item.case, 'quality item case');
    const code = `${caseId}/${qualityId(item.code, 'quality item code')}`;
    if (!cases.includes(caseId))
      throw new Error('a quality item belongs to a case that did not run');
    if (codes.has(code)) throw new Error('quality items are not unique');
    codes.add(code);
    const caseItems = (perCase.get(caseId) ?? 0) + 1;
    if (caseItems > 6) throw new Error('a quality case has more than six items');
    perCase.set(caseId, caseItems);
    oneOf(item.level, qualityLevels, 'quality item level');
    const level = item.level as (typeof qualityLevels)[number];
    const rank = qualityLevels.indexOf(level);
    if (rank < previousRank) throw new Error('quality items are not sorted by level');
    previousRank = rank;
    kept[level] += 1;
    if (level !== 'advice' && passed.includes(caseId)) {
      throw new Error('a passed quality case has a failure or warning');
    }
    oneLine(item.message, 'quality item message', 120);
    if (hasMetric) {
      const metric = record(item.metric, 'quality metric');
      exactKeys(metric, ['label', 'unit', 'p5', 'p50', 'p95', 'max']);
      oneLine(metric.label, 'quality metric label', 80);
      oneLine(metric.unit, 'quality metric unit', 16);
      const values = [metric.p5, metric.p50, metric.p95, metric.max].map((entry) =>
        qualityValue(entry, 'quality percentile'),
      );
      if (values.some((entry, position) => entry > (values[position + 1] ?? entry))) {
        throw new Error('quality percentiles are not ascending');
      }
    }
    boundedInteger(item.of, 'quality item samples', 1, samples);
    boundedInteger(item.bad, 'quality item bad samples', 0, item.of as number);
    if (!Array.isArray(item.worst) || item.worst.length > 3) {
      throw new Error('quality worst samples are invalid');
    }
    for (const worstValue of item.worst) {
      const worst = record(worstValue, 'quality worst sample');
      const optional = ['settingsIndex', 'value', 'players', 'tile'].filter((key) =>
        Object.hasOwn(worst, key),
      );
      exactKeys(worst, ['seed', ...optional]);
      boundedInteger(worst.seed, 'quality worst seed', 0, 0xffff_ffff);
      if (optional.includes('settingsIndex')) settingsIndex(worst.settingsIndex, variants);
      if (optional.includes('value') !== hasMetric) {
        throw new Error("a quality worst sample's value does not match its item");
      }
      if (hasMetric) qualityValue(worst.value, 'quality worst value');
      if (optional.includes('players')) {
        if (!Array.isArray(worst.players) || worst.players.length < 1 || worst.players.length > 8) {
          throw new Error('quality worst player values are invalid');
        }
        worst.players.forEach((entry) => qualityValue(entry, 'quality worst player value'));
      }
      if (optional.includes('tile')) {
        if (!Array.isArray(worst.tile) || worst.tile.length !== 2) {
          throw new Error('quality worst tile is invalid');
        }
        worst.tile.forEach((entry) => boundedInteger(entry, 'quality worst tile', 0, 511));
      }
    }
  }
  const failures = counts.failures as number;
  const warnings = counts.warnings as number;
  const advice = counts.advice as number;
  if (
    kept.failure > failures ||
    kept.warning > warnings ||
    kept.advice > advice ||
    failures + warnings + advice - block.items.length !== block.omittedItems
  ) {
    throw new Error('quality counts do not match the items and omitted items');
  }
  const result = failures > 0 ? 'failed' : warnings > 0 ? 'warnings' : 'passed';
  if (block.result !== result) throw new Error('the quality result does not match its counts');
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

export function mapTestFindingSettings(
  report: MapTestReport,
  finding: MapTestFinding,
): Pick<MapTestReport['settings'], 'width' | 'height' | 'mapSize' | 'players'> | undefined {
  return finding.settingsIndex === undefined
    ? report.settings
    : report.settingsVariants?.[finding.settingsIndex];
}

export function mapTestReplayModeContext(
  report: MapTestReport,
  settings: Pick<MapTestReport['settings'], 'players'>,
): string {
  const setup = report.settings.setupContext;
  const gameMode: Record<string, number> = {
    'random-map': 0,
    regicide: 1,
    'death-match': 2,
    'king-of-the-hill': 5,
    'wonder-race': 6,
    'defend-the-wonder': 7,
    'turbo-random-map': 8,
    'capture-the-relic': 10,
    'sudden-death': 11,
    'battle-royale': 12,
    'empire-wars': 13,
  };
  const resources: Record<string, number> = {
    standard: 0,
    low: 1,
    medium: 2,
    high: 3,
    'ultra-high': 4,
    infinite: 5,
    random: 6,
  };
  const age: Record<string, number> = {
    standard: 0,
    'dark-age': 2,
    'feudal-age': 3,
    'castle-age': 4,
    'imperial-age': 5,
    'post-imperial-age': 6,
  };
  const position: Record<string, number> = { random: 0, fixed: 1, 'team-together': 2 };
  return `aoe2:gm=${gameMode[setup.gameMode]};r=${resources[setup.startingResources]};a=${age[setup.startingAge]};p=${position[setup.positionPolicy]};c=${settings.players.map((player) => player.color).join(',')}`;
}

export function mapTestReplayGenerationInput(
  currentSource: PreviewGenerationInput,
  currentCatalogRevision: number,
  report: MapTestReport,
  finding: MapTestFinding,
): PreviewGenerationInput {
  let revision = currentCatalogRevision;
  if (report.schemaVersion !== '1.0.0') {
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
