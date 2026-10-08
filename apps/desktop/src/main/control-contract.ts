import type {
  ControlCapabilities,
  ControlCatalog,
  ControlCleanEndResult,
  ControlDetachResult,
  ControlEndpointStatus,
  ControlEffectiveSetupContext,
  ControlEngineIdentity,
  ControlLobbyOptions,
  ControlRandomMapSource,
  ControlResetEvidence,
  ControlSafetyAttestation,
  ControlSetupContext,
  ControlSetupContextVersion,
  ControlStartRandomMapRequest,
  ControlStartRandomMapResult,
} from '../shared/api';
import {
  gameModeModifierOptions,
  liveComputerPlayerSlots,
  type GameModeModifier,
} from '../shared/lobby-options';
import { controlGameBuildVerification } from './control-game-builds';

export const controlContractVersion = '1.0.0' as const;
export const controlCapabilityRevision = 'rms-session-3' as const;
export const controlSafetyContract = 'rmside-multiplayer-refusal-1' as const;
export const maximumControlRequestBytes = 256 * 1024;
export const maximumControlResponseBytes = 64 * 1024 * 1024;
export const controlMaximumCivilizationId = 62;
export const controlLegacyMaximumCivilizationId = 59;

export class ControlContractError extends Error {
  constructor(
    readonly code: 'unsupported-game-version',
    message: string,
  ) {
    super(message);
    this.name = 'ControlContractError';
  }
}

const sha256Pattern = /^[0-9a-f]{64}$/u;
const identifierPattern = /^[A-Za-z0-9._:-]{1,96}$/u;
const engineIdentityPattern = /^[0-9a-f]{32}$/u;

export type ControlEndpointMethod =
  | 'get_capabilities'
  | 'refresh_catalog'
  | 'get_status'
  | 'clean_end'
  | 'detach'
  | 'start_random_map';

export interface ControlEndpointRequest {
  contractVersion: typeof controlContractVersion;
  requestId: string;
  method: ControlEndpointMethod;
  params: Record<string, unknown>;
}

export function createControlEndpointRequest(
  requestId: string,
  method: ControlEndpointMethod,
  params: Record<string, unknown> = {},
): ControlEndpointRequest {
  if (!identifierPattern.test(requestId)) throw new Error('Control request identity is invalid');
  const request = { contractVersion: controlContractVersion, requestId, method, params };
  const bytes = Buffer.byteLength(JSON.stringify(request));
  if (bytes > maximumControlRequestBytes) throw new Error('Control request exceeds its bound');
  return request;
}

export function validateControlCapabilities(value: unknown): ControlCapabilities {
  const record = requireRecord(value, 'Control capabilities');
  if (record.contractVersion !== controlContractVersion) {
    throw new Error('Control endpoint contract is incompatible');
  }
  const supported = requireRecord(record.supportedContract, 'Control supported contract');
  if (supported.minimumMajor !== 1 || supported.maximumMajor !== 1) {
    throw new Error('Control endpoint major-version range is incompatible');
  }
  if (record.safetyContract !== controlSafetyContract) {
    throw new Error('Control multiplayer-refusal safety contract is unavailable');
  }
  const safety = validateControlSafety(record.safety, [
    'single-player-ready',
    'single-player-active',
  ]);
  const features = requireRecord(record.features, 'Control features');
  const requiredTrue = [
    'typedStartTransaction',
    'managedLocalMod',
    'requestedEffectiveReadback',
    'transactionRollback',
    'explicitCleanEnd',
    'sourceCatalogRefresh',
    'managedSourceSelection',
    'typedSetup',
    'exactUnsignedSeed',
    'effectiveReadback',
    'cleanEnd',
    'freshMatchDispatch',
    'statusReadback',
    'matchEpochs',
    'reviewedFailClosedMultiplayerRefusal',
  ];
  if (requiredTrue.some((name) => features[name] !== true)) {
    throw new Error('Control endpoint is missing a required capability');
  }
  if (
    features.activeMatchAtomicReplacement !== false ||
    features.directPath !== false ||
    features.inlineSource !== false ||
    features.intermediateSemanticStages !== false
  ) {
    throw new Error('Control endpoint advertises a forbidden release surface');
  }
  if (features.lobbyOptions !== undefined && typeof features.lobbyOptions !== 'boolean') {
    throw new Error('Control lobby-options capability is invalid');
  }
  if (record.setupContextVersions !== undefined) {
    validateSetupContextVersions(record.setupContextVersions);
  }
  const identity = validateControlEngineIdentity(record.identity);
  validateControlProductVersion(identity.control.productVersion);
  if (!controlGameBuildVerification(identity.gameBuild.fileVersion)) {
    throw new ControlContractError(
      'unsupported-game-version',
      'Control is attached to an AoE2DE build that is not supported for live testing',
    );
  }
  return { ...(structuredClone(record) as unknown as ControlCapabilities), safety };
}

export function validateControlEndpointStatus(
  value: unknown,
  expectedIdentity: ControlEngineIdentity,
): ControlEndpointStatus {
  const record = requireRecord(value, 'Control status');
  assertSameControlIdentity(expectedIdentity, validateControlEngineIdentity(record.identity));
  const safety = validateControlSafety(record.safety, [
    'single-player-ready',
    'single-player-active',
  ]);
  const match = requireRecord(record.match, 'Control match');
  requireSafeUnsigned(match.observationSequence, 'match observation sequence');
  requireSafeUnsigned(match.matchEpoch, 'match epoch');
  requireBoolean(match.active, 'match active');
  requireBoolean(match.replay, 'match replay');
  requireBoolean(match.multiplayer, 'match multiplayer');
  if (
    match.multiplayer !== false ||
    match.replay !== false ||
    (match.active === true) !== (safety.sessionState === 'single-player-active') ||
    match.observationSequence !== safety.observationSequence
  ) {
    throw new Error('Control status safety attestation does not match live state');
  }
  validateResetEvidence(record.resetEvidence);
  requireNullableUint32(record.requestedSeed, 'requested seed');
  requireNullableUint32(record.effectiveSeed, 'effective seed');
  if (record.currentSetup !== null) validateControlSetup(record.currentSetup, true);
  if (record.currentLobbyOptions !== undefined) {
    if ((record.currentLobbyOptions === null) !== (record.currentSetup === null)) {
      throw new Error('Control current lobby options do not match the current setup');
    }
    if (record.currentLobbyOptions !== null) validateLobbyOptions(record.currentLobbyOptions);
  }
  if (record.currentGameMode !== undefined && record.currentGameMode !== null) {
    requireEnum(
      record.currentGameMode,
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
      ] as const,
      'current game mode',
    );
  }
  if (record.effectiveSource !== null) validateControlSource(record.effectiveSource);
  if (record.lastTransaction !== null) validateLastTransaction(record.lastTransaction);
  return structuredClone(record) as unknown as ControlEndpointStatus;
}

export function validateControlCatalog(
  value: unknown,
  expectedIdentity: ControlEngineIdentity,
): ControlCatalog {
  const record = requireRecord(value, 'Control catalog');
  assertSameControlIdentity(expectedIdentity, validateControlEngineIdentity(record.identity));
  const safety = validateControlSafety(record.safety, ['single-player-ready']);
  const generation = requirePositiveSafeInteger(record.catalogGeneration, 'catalog generation');
  if (!Array.isArray(record.sources) || record.sources.length > 4096) {
    throw new Error('Control source catalog is invalid or exceeds its bound');
  }
  const sources = record.sources.map(validateControlSource);
  if (sources.some((source) => source.catalogGeneration !== generation)) {
    throw new Error('Control source catalog mixes generations');
  }
  return {
    identity: structuredClone(expectedIdentity),
    safety,
    catalogGeneration: generation,
    sources,
  };
}

export function validateControlCleanEnd(
  value: unknown,
  expectedIdentity: ControlEngineIdentity,
): ControlCleanEndResult {
  const record = requireRecord(value, 'Control clean-end response');
  assertSameControlIdentity(expectedIdentity, validateControlEngineIdentity(record.identity));
  const safety = validateControlSafety(record.safety, [
    'single-player-ready',
    'single-player-active',
  ]);
  if (record.status !== 'already-inactive' && record.status !== 'queued') {
    throw new Error('Control clean-end status is invalid');
  }
  return {
    status: record.status,
    identity: structuredClone(expectedIdentity),
    safety,
    resetEvidence: validateResetEvidence(record.resetEvidence),
  };
}

export function validateControlDetach(
  value: unknown,
  expectedIdentity: ControlEngineIdentity,
): ControlDetachResult {
  const record = requireRecord(value, 'Control detach response');
  if (record.status !== 'accepted') throw new Error('Control detach status is invalid');
  assertSameControlIdentity(expectedIdentity, validateControlEngineIdentity(record.identity));
  return {
    status: 'accepted',
    identity: structuredClone(expectedIdentity),
    safety: validateControlSafety(record.safety, ['single-player-ready', 'single-player-active']),
  };
}

export function validateControlStartRequest(value: unknown): ControlStartRandomMapRequest {
  const record = requireRecord(value, 'Control start request');
  const allowed = new Set(['requestId', 'setup', 'mapSize', 'endingAge', 'seed', 'source']);
  if (Object.keys(record).some((key) => !allowed.has(key)) || Object.keys(record).length !== 6) {
    throw new Error('Control start request fields are invalid');
  }
  const requestId = requireString(record.requestId, 'request identity', 96);
  if (!identifierPattern.test(requestId)) throw new Error('Control request identity is invalid');
  const setup = validateControlSetup(record.setup);
  if (
    setup.computerPlayerSlots !== undefined &&
    setup.computerPlayerSlots.join(',') !==
      liveComputerPlayerSlots(setup.players.map((player) => player.slot)).join(',')
  ) {
    throw new Error('Control computer player slots must be every player slot except 1');
  }
  const mapSize = requireEnum(
    record.mapSize,
    ['tiny', 'small', 'medium', 'normal', 'large', 'huge', 'ludicrous'] as const,
    'map size',
  );
  const endingAge = requireAge(record.endingAge, 'ending age');
  const seed = requireUint32(record.seed, 'seed');
  const source = requireRecord(record.source, 'managed source');
  const catalogGeneration = requirePositiveSafeInteger(
    source.catalogGeneration,
    'catalog generation',
  );
  const sourceIdentity = requireSha256(source.sourceIdentity, 'source identity');
  const authoredSourceSha256 = requireSha256(source.authoredSourceSha256, 'authored source hash');
  const modIdentity = requireString(source.modIdentity, 'mod identity', 4096);
  if (ageRank(endingAge) < ageRank(setup.startingAge)) {
    throw new Error('Control ending age precedes the starting age');
  }
  return {
    requestId,
    setup,
    mapSize,
    endingAge,
    seed,
    source: { catalogGeneration, sourceIdentity, authoredSourceSha256, modIdentity },
  };
}

export function validateControlStartResult(
  value: unknown,
  expectedIdentity: ControlEngineIdentity,
  expectedRequestId?: string,
): ControlStartRandomMapResult {
  const record = requireRecord(value, 'Control start response');
  assertSameControlIdentity(expectedIdentity, validateControlEngineIdentity(record.identity));
  validateControlSafety(record.safety, ['single-player-ready']);
  if (!identifierPattern.test(record.requestId as string))
    throw new Error('Control request identity is invalid');
  if (expectedRequestId !== undefined && record.requestId !== expectedRequestId) {
    throw new Error('Control start response request identity is stale');
  }
  requireSha256(record.setupIdentity, 'setup identity');
  if (record.capabilityRevision !== controlCapabilityRevision) {
    throw new Error('Control start capability revision is incompatible');
  }
  requireString(record.route, 'start route', 128);
  requireString(record.detail, 'start detail', 256, true);
  requireBoolean(record.rollbackComplete, 'rollback status');
  requireBoolean(record.dispatchAccepted, 'dispatch status');
  validateControlSetup(record.requestedSetup, true);
  if (record.effectiveSetup !== null) validateControlSetup(record.effectiveSetup, true);
  requireUint32(record.requestedSeed, 'requested seed');
  if (record.source !== null) validateControlSource(record.source);
  requirePositiveSafeInteger(record.catalogGeneration, 'catalog generation');
  validateResetEvidence(record.resetEvidence);
  return structuredClone(record) as unknown as ControlStartRandomMapResult;
}

export function validateControlEngineIdentity(value: unknown): ControlEngineIdentity {
  const record = requireRecord(value, 'Control engine identity');
  const control = requireRecord(record.control, 'Control product identity');
  const gameBuild = requireRecord(record.gameBuild, 'Control game build');
  const engine = requireRecord(record.engine, 'Control engine instance');
  const productVersion = requireString(control.productVersion, 'Control product version', 64);
  if (control.capabilityRevision !== controlCapabilityRevision) {
    throw new Error('Control capability revision is incompatible');
  }
  if (control.buildFlavor !== 'release' && control.buildFlavor !== 'release-packed') {
    throw new Error('Control build is not an ordinary public Release artifact');
  }
  const fileVersion = requireString(gameBuild.fileVersion, 'game file version', 64);
  const peTimestamp = requireString(gameBuild.peTimestamp, 'game build timestamp', 32);
  const gameProcessId = requirePositiveInteger(engine.gameProcessId, 'game process identity');
  const injectionId = requireString(engine.injectionId, 'Control injection identity', 32);
  const endpointInstanceId = requireString(
    engine.endpointInstanceId,
    'Control endpoint instance identity',
    32,
  );
  if (!engineIdentityPattern.test(injectionId) || !engineIdentityPattern.test(endpointInstanceId)) {
    throw new Error('Control engine instance identity is invalid');
  }
  return {
    control: {
      productVersion,
      capabilityRevision: controlCapabilityRevision,
      buildFlavor: control.buildFlavor,
    },
    gameBuild: { fileVersion, peTimestamp },
    engine: { gameProcessId, injectionId, endpointInstanceId },
  };
}

export function assertSameControlIdentity(
  expected: ControlEngineIdentity,
  actual: ControlEngineIdentity,
): void {
  if (
    expected.control.productVersion !== actual.control.productVersion ||
    expected.control.capabilityRevision !== actual.control.capabilityRevision ||
    expected.control.buildFlavor !== actual.control.buildFlavor ||
    expected.gameBuild.fileVersion !== actual.gameBuild.fileVersion ||
    expected.gameBuild.peTimestamp !== actual.gameBuild.peTimestamp ||
    expected.engine.gameProcessId !== actual.engine.gameProcessId ||
    expected.engine.injectionId !== actual.engine.injectionId ||
    expected.engine.endpointInstanceId !== actual.engine.endpointInstanceId
  ) {
    throw new Error('Control launcher and injected-engine identities do not match');
  }
}

export function validateControlSafety(
  value: unknown,
  allowedStates: ControlSafetyAttestation['sessionState'][],
): ControlSafetyAttestation {
  const record = requireRecord(value, 'Control safety attestation');
  if (
    record.contract !== controlSafetyContract ||
    record.verified !== true ||
    typeof record.sessionState !== 'string' ||
    !allowedStates.includes(record.sessionState as ControlSafetyAttestation['sessionState'])
  ) {
    throw new Error('Control live-session safety attestation failed closed');
  }
  return {
    contract: controlSafetyContract,
    verified: true,
    sessionState: record.sessionState as ControlSafetyAttestation['sessionState'],
    observationSequence: requireSafeUnsigned(
      record.observationSequence,
      'safety observation sequence',
    ),
  };
}

function validateControlProductVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) throw new Error('Control product version is malformed');
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 1 || minor < 1) throw new Error('Control product version is incompatible');
}

function validateControlSetup(value: unknown): ControlSetupContext;
function validateControlSetup(value: unknown, complete: true): ControlEffectiveSetupContext;
function validateControlSetup(
  value: unknown,
  complete = false,
): ControlSetupContext | ControlEffectiveSetupContext {
  const record = requireRecord(value, 'Control setup');
  const allowed = new Set([
    '$schema',
    'schemaVersion',
    'compatibility',
    'gameMode',
    'startingResources',
    'startingAge',
    'revealMap',
    'positionPolicy',
    'players',
    ...setupContextExtensionFields,
    ...(complete ? ['mapSize', 'endingAge'] : []),
  ]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    (complete && (!('mapSize' in record) || !('endingAge' in record)))
  ) {
    throw new Error('Control setup fields are invalid');
  }
  if (
    record.$schema !== undefined &&
    record.$schema !== 'https://rmside.invalid/schemas/setup-context/v1'
  ) {
    throw new Error('Control setup schema is incompatible');
  }
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== '1.0.0' && schemaVersion !== '1.1.0' && schemaVersion !== '1.2.0') {
    throw new Error('Control setup version is incompatible');
  }
  const compatibility = requireRecord(record.compatibility, 'Control setup compatibility');
  if (
    Object.keys(compatibility).length !== 2 ||
    compatibility.minimumMajor !== 1 ||
    compatibility.maximumMajor !== 1
  ) {
    throw new Error('Control setup compatibility is invalid');
  }
  const gameMode = requireEnum(
    record.gameMode,
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
    ] as const,
    'game mode',
  );
  const startingResources = requireEnum(
    record.startingResources,
    ['standard', 'low', 'medium', 'high', 'ultra-high', 'infinite', 'random'] as const,
    'starting resources',
  );
  const startingAge = requireAge(record.startingAge, 'starting age');
  if (record.revealMap !== 'all-visible') {
    throw new Error('Control reveal-map policy is incompatible');
  }
  const positionPolicy = requireEnum(
    record.positionPolicy,
    ['random', 'fixed', 'team-together'] as const,
    'position policy',
  );
  if (!Array.isArray(record.players) || record.players.length < 1 || record.players.length > 8) {
    throw new Error('Control player list is invalid');
  }
  const slots = new Set<number>();
  const colors = new Set<number>();
  const players = record.players.map((value) => {
    const player = requireRecord(value, 'Control player');
    if (
      Object.keys(player).length !== 4 ||
      ['slot', 'team', 'civilizationId', 'color'].some((key) => !(key in player))
    ) {
      throw new Error('Control player fields are invalid');
    }
    const slot = requireInteger(player.slot, 1, 8, 'player slot');
    const team = requireInteger(player.team, 0, 4, 'player team');
    const civilizationId = requireInteger(
      player.civilizationId,
      0,
      controlMaximumCivilizationId,
      'player civilization',
    );
    const color = requireInteger(player.color, 0, 7, 'player color');
    if (slots.has(slot) || colors.has(color))
      throw new Error('Control player slots or colors repeat');
    slots.add(slot);
    colors.add(color);
    return { slot, team, civilizationId, color };
  });
  players.sort((left, right) => left.slot - right.slot);
  const extensions = validateSetupExtensions(record, schemaVersion, slots);
  const completeFields = complete
    ? {
        mapSize: requireEnum(
          record.mapSize,
          ['tiny', 'small', 'medium', 'normal', 'large', 'huge', 'ludicrous'] as const,
          'map size',
        ),
        endingAge: requireAge(record.endingAge, 'ending age'),
      }
    : undefined;
  if (completeFields && ageRank(completeFields.endingAge) < ageRank(startingAge)) {
    throw new Error('Control ending age precedes the starting age');
  }
  return {
    ...(record.$schema === undefined ? {} : { $schema: record.$schema }),
    schemaVersion,
    compatibility: { minimumMajor: 1, maximumMajor: 1 },
    gameMode,
    startingResources,
    startingAge,
    revealMap: 'all-visible',
    positionPolicy,
    players,
    ...extensions,
    ...(completeFields ?? {}),
  };
}

const lobbyOptionFlagFields = ['turboMode', 'fullTechTree', 'antiquityMode', 'solidFarms'] as const;
const setupContextExtensionFields = [
  'computerPlayerSlots',
  'gameModeModifiers',
  ...lobbyOptionFlagFields,
] as const;

function validateSetupExtensions(
  record: Record<string, unknown>,
  schemaVersion: ControlSetupContextVersion,
  slots: ReadonlySet<number>,
): Partial<ControlSetupContext> {
  const minor = Number(schemaVersion.split('.')[1]);
  const result: Partial<ControlSetupContext> = {};
  if (record.computerPlayerSlots !== undefined) {
    if (minor < 1) throw new Error('Control setup computer slots need setup context 1.1');
    result.computerPlayerSlots = validateComputerPlayerSlots(record.computerPlayerSlots, slots);
  }
  if (record.gameModeModifiers !== undefined) {
    if (minor < 2) throw new Error('Control setup modifiers need setup context 1.2');
    result.gameModeModifiers = validateGameModeModifiers(record.gameModeModifiers);
  }
  for (const flag of lobbyOptionFlagFields) {
    if (record[flag] === undefined) continue;
    if (minor < 2) throw new Error('Control setup lobby options need setup context 1.2');
    result[flag] = requireBoolean(record[flag], `setup ${flag}`);
  }
  return result;
}

function validateComputerPlayerSlots(value: unknown, slots?: ReadonlySet<number>): number[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error('Control computer player slots are invalid');
  }
  return value.map((entry, index) => {
    const slot = requireInteger(entry, 1, 8, 'computer player slot');
    if (index > 0 && slot <= (value[index - 1] as number)) {
      throw new Error('Control computer player slots are not ascending');
    }
    if (slots && !slots.has(slot)) throw new Error('Control computer player slot is not a player');
    return slot;
  });
}

function validateGameModeModifiers(value: unknown): GameModeModifier[] {
  const order = gameModeModifierOptions.map((option) => option.value) as string[];
  if (!Array.isArray(value) || value.length > order.length) {
    throw new Error('Control game mode modifiers are invalid');
  }
  return value.map((entry, index) => {
    const position = typeof entry === 'string' ? order.indexOf(entry) : -1;
    if (position < 0 || (index > 0 && position <= order.indexOf(value[index - 1] as string))) {
      throw new Error('Control game mode modifiers are unknown, repeated, or out of order');
    }
    return entry as GameModeModifier;
  });
}

function validateLobbyOptions(value: unknown): ControlLobbyOptions {
  const record = requireRecord(value, 'Control current lobby options');
  const fields = ['computerPlayerSlots', 'gameModeModifiers', ...lobbyOptionFlagFields];
  if (Object.keys(record).length !== fields.length || fields.some((field) => !(field in record))) {
    throw new Error('Control current lobby options fields are invalid');
  }
  return {
    computerPlayerSlots: validateComputerPlayerSlots(record.computerPlayerSlots),
    gameModeModifiers: validateGameModeModifiers(record.gameModeModifiers),
    turboMode: requireBoolean(record.turboMode, 'current turbo mode'),
    fullTechTree: requireBoolean(record.fullTechTree, 'current full tech tree'),
    antiquityMode: requireBoolean(record.antiquityMode, 'current antiquity mode'),
    solidFarms: requireBoolean(record.solidFarms, 'current solid farms'),
  };
}

function validateSetupContextVersions(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 16 ||
    value.some(
      (entry) => typeof entry !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error('Control setup context versions are invalid');
  }
  return value as string[];
}

function validateControlSource(value: unknown): ControlRandomMapSource {
  const source = requireRecord(value, 'Control source');
  return {
    displayName: requireString(source.displayName, 'source display name', 4096),
    nativeMapId: requireUnsigned(source.nativeMapId, 'native map identity'),
    sourceKind: requireString(source.sourceKind, 'source kind', 64),
    modIdentity:
      source.modIdentity === null ? null : requireString(source.modIdentity, 'mod identity', 4096),
    sourceIdentity: requireSha256(source.sourceIdentity, 'source identity'),
    authoredSourceSha256:
      source.authoredSourceSha256 === null
        ? null
        : requireSha256(source.authoredSourceSha256, 'authored source hash'),
    catalogGeneration: requirePositiveSafeInteger(source.catalogGeneration, 'catalog generation'),
  };
}

function validateResetEvidence(value: unknown): ControlResetEvidence {
  const reset = requireRecord(value, 'Control reset evidence');
  return {
    sequence: requireSafeUnsigned(reset.sequence, 'reset sequence'),
    previousMatchEpoch: requireSafeUnsigned(reset.previousMatchEpoch, 'previous match epoch'),
    requested: requireBoolean(reset.requested, 'reset requested'),
    dispatchAccepted: requireBoolean(reset.dispatchAccepted, 'reset dispatch'),
    inactiveBoundaryObserved: requireBoolean(
      reset.inactiveBoundaryObserved,
      'inactive reset boundary',
    ),
    completed: requireBoolean(reset.completed, 'reset completion'),
  };
}

function validateLastTransaction(value: unknown): void {
  const transaction = requireRecord(value, 'Control last transaction');
  if (!identifierPattern.test(transaction.requestId as string))
    throw new Error('Control transaction ID is invalid');
  requireSha256(transaction.setupIdentity, 'setup identity');
  requireEnum(
    transaction.state,
    ['dispatched', 'active-verifying', 'active-verified', 'active-readback-mismatch'] as const,
    'transaction state',
  );
  validateControlSetup(transaction.requestedSetup, true);
  if (transaction.effectiveSetup !== null) validateControlSetup(transaction.effectiveSetup, true);
  requireUint32(transaction.requestedSeed, 'requested seed');
  requireNullableUint32(transaction.effectiveSeed, 'effective seed');
  requireSha256(transaction.sourceIdentity, 'source identity');
  requireSha256(transaction.authoredSourceSha256, 'authored source hash');
  requirePositiveSafeInteger(transaction.catalogGeneration, 'catalog generation');
  if (transaction.matchEpoch !== null) requireSafeUnsigned(transaction.matchEpoch, 'match epoch');
  requireString(transaction.route, 'transaction route', 128);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length < 1) || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid`);
  return value;
}

function requireInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function requireUnsigned(value: unknown, label: string): number {
  return requireInteger(value, 0, 0xffff_ffff, label);
}

function requirePositiveInteger(value: unknown, label: string): number {
  return requireInteger(value, 1, 0xffff_ffff, label);
}

function requireSafeUnsigned(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`);
  return value as number;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const validated = requireSafeUnsigned(value, label);
  if (validated < 1) throw new Error(`${label} is invalid`);
  return validated;
}

function requireUint32(value: unknown, label: string): number {
  return requireUnsigned(value, label);
}

function requireNullableUint32(value: unknown, label: string): number | null {
  return value === null ? null : requireUint32(value, label);
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !sha256Pattern.test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label} is invalid`);
  return value as T[number];
}

function requireAge(value: unknown, label: string) {
  return requireEnum(
    value,
    [
      'standard',
      'dark-age',
      'feudal-age',
      'castle-age',
      'imperial-age',
      'post-imperial-age',
    ] as const,
    label,
  );
}

function ageRank(age: ReturnType<typeof requireAge>): number {
  return [
    'standard',
    'dark-age',
    'feudal-age',
    'castle-age',
    'imperial-age',
    'post-imperial-age',
  ].indexOf(age);
}
