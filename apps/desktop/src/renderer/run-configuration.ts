import type {
  BehaviorProfileDescriptor,
  ConfigurationCatalog,
  ContentPackDescriptor,
  GenerationCertification,
  LanguageContentSelection,
  LanguageServerPreviewContext,
  PreviewGenerationInput,
  PreviewPlayerConfiguration,
  PreviewVersionOrigin,
  SelectedMinimapPalette,
  SelectedTexturePalette,
  StandardIncludeAccess,
} from '../shared/api';
import {
  compactSetupSuffix,
  effectiveGameModeModifiers,
  gameModeModifierOptions,
  isGameModeModifier,
  lobbyOptionFields,
  liveComputerPlayerSlots,
  setupContextMinor,
  type GameModeModifier,
  type LobbyOptions,
} from '../shared/lobby-options';
import { availableLanguages, t, translatorFor, type MessageId } from '../shared/i18n/translator';
import { isMapTestWorkerSetting, type MapTestWorkerSetting } from '../shared/map-test-contract';
import { wordOutputText, type OutputText } from '../shared/output-message';
import { civilizationName, packedCivilizationOptions } from './packed-game-options';

export const runConfigurationStorageKey = 'rmside.run-configuration.v1';
export const maximumRecentSeeds = 16;
export function defaultRunPresetName(): string {
  return t('run-menu.preset.default-name');
}
export const livePreviewEditDebounceMilliseconds = 250;

export const runMapSizeOptions = [
  {
    value: 'tiny',
    get label() {
      return t('game-options.map-size.tiny');
    },
    width: 120,
    height: 120,
  },
  {
    value: 'small',
    get label() {
      return t('game-options.map-size.small');
    },
    width: 144,
    height: 144,
  },
  {
    value: 'medium',
    get label() {
      return t('game-options.map-size.medium');
    },
    width: 168,
    height: 168,
  },
  {
    value: 'normal',
    get label() {
      return t('game-options.map-size.normal');
    },
    width: 200,
    height: 200,
  },
  {
    value: 'large',
    get label() {
      return t('game-options.map-size.large');
    },
    width: 220,
    height: 220,
  },
  {
    value: 'huge',
    get label() {
      return t('game-options.map-size.huge');
    },
    width: 240,
    height: 240,
  },
  {
    value: 'ludicrous',
    get label() {
      return t('game-options.map-size.ludicrous');
    },
    width: 480,
    height: 480,
  },
] as const;

export type RunMapSize = (typeof runMapSizeOptions)[number]['value'];

export const runGameModeOptions = [
  {
    value: 'random-map',
    get label() {
      return t('game-options.game-mode.random-map');
    },
    nativeValue: 0,
  },
  {
    value: 'regicide',
    get label() {
      return t('game-options.game-mode.regicide');
    },
    nativeValue: 1,
  },
  {
    value: 'death-match',
    get label() {
      return t('game-options.game-mode.death-match');
    },
    nativeValue: 2,
  },
  {
    value: 'king-of-the-hill',
    get label() {
      return t('game-options.game-mode.king-of-the-hill');
    },
    nativeValue: 5,
  },
  {
    value: 'wonder-race',
    get label() {
      return t('game-options.game-mode.wonder-race');
    },
    nativeValue: 6,
  },
  {
    value: 'defend-the-wonder',
    get label() {
      return t('game-options.game-mode.defend-the-wonder');
    },
    nativeValue: 7,
  },
  {
    value: 'turbo-random-map',
    get label() {
      return t('game-options.game-mode.turbo-random-map');
    },
    nativeValue: 8,
  },
  {
    value: 'capture-the-relic',
    get label() {
      return t('game-options.game-mode.capture-the-relic');
    },
    nativeValue: 10,
  },
  {
    value: 'sudden-death',
    get label() {
      return t('game-options.game-mode.sudden-death');
    },
    nativeValue: 11,
  },
  {
    value: 'battle-royale',
    get label() {
      return t('game-options.game-mode.battle-royale');
    },
    nativeValue: 12,
  },
  {
    value: 'empire-wars',
    get label() {
      return t('game-options.game-mode.empire-wars');
    },
    nativeValue: 13,
  },
] as const;

export const runStartingResourceOptions = [
  {
    value: 'standard',
    get label() {
      return t('game-options.resources.standard');
    },
    nativeValue: 0,
  },
  {
    value: 'low',
    get label() {
      return t('game-options.resources.low');
    },
    nativeValue: 1,
  },
  {
    value: 'medium',
    get label() {
      return t('game-options.resources.medium');
    },
    nativeValue: 2,
  },
  {
    value: 'high',
    get label() {
      return t('game-options.resources.high');
    },
    nativeValue: 3,
  },
  {
    value: 'ultra-high',
    get label() {
      return t('game-options.resources.ultra-high');
    },
    nativeValue: 4,
  },
  {
    value: 'infinite',
    get label() {
      return t('game-options.resources.infinite');
    },
    nativeValue: 5,
  },
  {
    value: 'random',
    get label() {
      return t('game-options.resources.random');
    },
    nativeValue: 6,
  },
] as const;

export const runStartingAgeOptions = [
  {
    value: 'standard',
    get label() {
      return t('game-options.age.standard');
    },
    nativeValue: 0,
  },
  {
    value: 'dark-age',
    get label() {
      return t('game-options.age.dark-age');
    },
    nativeValue: 2,
  },
  {
    value: 'feudal-age',
    get label() {
      return t('game-options.age.feudal-age');
    },
    nativeValue: 3,
  },
  {
    value: 'castle-age',
    get label() {
      return t('game-options.age.castle-age');
    },
    nativeValue: 4,
  },
  {
    value: 'imperial-age',
    get label() {
      return t('game-options.age.imperial-age');
    },
    nativeValue: 5,
  },
  {
    value: 'post-imperial-age',
    get label() {
      return t('game-options.age.post-imperial-age');
    },
    nativeValue: 6,
  },
] as const;

export const runPositionPolicyOptions = [
  {
    value: 'random',
    get label() {
      return t('game-options.positions.random');
    },
    nativeValue: 0,
  },
  {
    value: 'fixed',
    get label() {
      return t('game-options.positions.fixed');
    },
    nativeValue: 1,
  },
  {
    value: 'team-together',
    get label() {
      return t('game-options.positions.team-together');
    },
    nativeValue: 2,
  },
] as const;

export const runPlayerColorOptions = [
  {
    value: 0,
    get label() {
      return t('game-options.color.blue');
    },
    color: 'rgb(0 0 255)',
  },
  {
    value: 1,
    get label() {
      return t('game-options.color.red');
    },
    color: 'rgb(255 0 0)',
  },
  {
    value: 2,
    get label() {
      return t('game-options.color.green');
    },
    color: 'rgb(0 169 27)',
  },
  {
    value: 3,
    get label() {
      return t('game-options.color.yellow');
    },
    color: 'rgb(214 214 27)',
  },
  {
    value: 4,
    get label() {
      return t('game-options.color.cyan');
    },
    color: 'rgb(123 239 240)',
  },
  {
    value: 5,
    get label() {
      return t('game-options.color.purple');
    },
    color: 'rgb(138 19 247)',
  },
  {
    value: 6,
    get label() {
      return t('game-options.color.gray');
    },
    color: 'rgb(102 102 102)',
  },
  {
    value: 7,
    get label() {
      return t('game-options.color.orange');
    },
    color: 'rgb(255 146 5)',
  },
] as const;

export type RunGameMode = (typeof runGameModeOptions)[number]['value'];
export type RunStartingResources = (typeof runStartingResourceOptions)[number]['value'];
export type RunStartingAge = (typeof runStartingAgeOptions)[number]['value'];
export type RunPositionPolicy = (typeof runPositionPolicyOptions)[number]['value'];

export interface RunConfiguration {
  seed: number;
  seedLocked: boolean;
  recentSeeds: number[];
  runOnSave: boolean;
  runOnEdit: boolean;
  mapSize: RunMapSize;
  width: number;
  height: number;
  playerCount: number;
  playerSlots: number[];
  playerColors: number[];
  teamIds: number[];
  civilizationIds: number[];
  computerPlayers: boolean[];
  modeContext: RunGameMode;
  gameModeModifiers: GameModeModifier[];
  turboMode: boolean;
  fullTechTree: boolean;
  antiquityMode: boolean;
  solidFarms: boolean;
  startingResources: RunStartingResources;
  startingAge: RunStartingAge;
  endingAge: RunStartingAge;
  positionPolicy: RunPositionPolicy;
  profileId: string;
  profileInstallation: string | null;
  traceLevel: 'off' | 'summary' | 'full';
  mapTestWorkers: MapTestWorkerSetting;
}

export interface RunPreset {
  name: string;
  configuration: Omit<RunConfiguration, 'recentSeeds'>;
}

export function nextRunPresetName(presets: readonly Pick<RunPreset, 'name'>[]): string {
  const occupied = new Set(presets.map((preset) => preset.name.toLowerCase()));
  const defaultName = defaultRunPresetName();
  if (!occupied.has(defaultName.toLowerCase())) return defaultName;
  for (let suffix = 1; suffix <= 64; suffix += 1) {
    const candidate = t('run-menu.preset.numbered-name', { number: suffix });
    if (!occupied.has(candidate.toLowerCase())) return candidate;
  }
  return t('run-menu.preset.numbered-name', { number: 65 });
}

function automaticPresetNames(): Map<string, number> {
  const names = new Map<string, number>();
  for (const { tag } of availableLanguages({ pseudo: true })) {
    const translator = translatorFor(tag);
    if (!translator) continue;
    if (!names.has(translator.t('run-menu.preset.default-name'))) {
      names.set(translator.t('run-menu.preset.default-name'), 0);
    }
    for (let number = 1; number <= 65; number += 1) {
      const name = translator.t('run-menu.preset.numbered-name', { number });
      if (!names.has(name)) names.set(name, number);
    }
  }
  return names;
}

export function localizeAutomaticPresetNames<Preset extends Pick<RunPreset, 'name'>>(
  presets: readonly Preset[],
  activePresetName: string | null,
): { presets: Preset[]; activePresetName: string | null } {
  const automatic = automaticPresetNames();
  const occupied = new Set(presets.map((preset) => preset.name.toLowerCase()));
  let changed = false;
  let active = activePresetName;
  const next = presets.map((preset) => {
    const number = automatic.get(preset.name);
    if (number === undefined) return preset;
    const name =
      number === 0 ? defaultRunPresetName() : t('run-menu.preset.numbered-name', { number });
    if (name === preset.name || occupied.has(name.toLowerCase())) return preset;
    occupied.delete(preset.name.toLowerCase());
    occupied.add(name.toLowerCase());
    if (active === preset.name) active = name;
    changed = true;
    return { ...preset, name };
  });
  return changed
    ? { presets: next, activePresetName: active }
    : { presets: presets as Preset[], activePresetName };
}

export interface StoredRunConfiguration {
  version: 2;
  current: RunConfiguration;
  presets: RunPreset[];
  activePresetName: string;
}

export function profileGameVersion(profile: BehaviorProfileDescriptor): string {
  return (
    [...profile.productVersions].sort(compareProductVersionsNewestFirst)[0] ??
    profile.behaviorVersion
  );
}

export function profilesNewestFirst(
  profiles: readonly BehaviorProfileDescriptor[],
): BehaviorProfileDescriptor[] {
  return [...profiles].sort((left, right) => {
    const versionOrder = compareProductVersionsNewestFirst(
      profileGameVersion(left),
      profileGameVersion(right),
    );
    return versionOrder || right.profileId.localeCompare(left.profileId);
  });
}

export function isVerifiedLocalProductVersion(
  catalog: ConfigurationCatalog,
  localProductVersion: string,
): boolean {
  return catalog.behaviorProfiles.some((profile) =>
    profile.productVersions.includes(localProductVersion),
  );
}

export function localProductVersionLabel(
  catalog: ConfigurationCatalog,
  localProductVersion: string | null,
): string {
  if (!localProductVersion) return t('run-menu.version.local-folder');
  return isVerifiedLocalProductVersion(catalog, localProductVersion)
    ? t('run-menu.version.local', { version: localProductVersion })
    : t('run-menu.version.not-verified', { version: localProductVersion });
}

export const maximumInstallationSelectionKeyLength = 4_200;

export function installationSelectionKey(
  installationRoot: string | null,
  productVersion: string | null,
): string | null {
  if (!installationRoot) return null;
  const root = installationRoot.replaceAll('\\', '/').toLocaleLowerCase('en-US');
  const key = `${root}|${productVersion ?? ''}`;
  return key.length <= maximumInstallationSelectionKeyLength ? key : null;
}

export function effectiveProfileSelection(
  configuration: Pick<RunConfiguration, 'profileId' | 'profileInstallation'>,
  installationKey: string | null,
): string {
  if (configuration.profileId === 'auto') return 'auto';
  return configuration.profileInstallation === installationKey ? configuration.profileId : 'auto';
}

export function profileSelectionChange(
  profileId: string,
  installationKey: string | null,
): Pick<RunConfiguration, 'profileId' | 'profileInstallation'> {
  return profileId === 'auto'
    ? { profileId: 'auto', profileInstallation: null }
    : { profileId, profileInstallation: installationKey };
}

export function generationCertificationLabel(
  certification: GenerationCertification | undefined,
  options: { reused?: boolean } = {},
): string | null {
  if (certification !== 'version-mapped' && certification !== 'unverified-product-version') {
    return null;
  }
  return wordOutputText(generatedResultLabel(certification, options));
}

export function generatedResultLabel(
  certification: GenerationCertification | undefined,
  { reused = false }: { reused?: boolean } = {},
): OutputText {
  const unverified = certification === 'unverified-product-version';
  if (reused) {
    return {
      id: unverified
        ? 'run-menu.result.generated-reused-unverified'
        : 'run-menu.result.generated-reused',
    };
  }
  return {
    id: unverified ? 'run-menu.result.generated-unverified' : 'message.generation-result.generated',
  };
}

export type StandardIncludeRecoveryAction = 'use-local-version' | 'link-game-folder';

export interface StandardIncludeRecovery {
  access: Exclude<StandardIncludeAccess, 'authorized'>;
  cause: string;
  action: StandardIncludeRecoveryAction | null;
}

export function isStandardIncludeUnavailableMessage(message: string): boolean {
  return /Standard game include '[^'\n]+' requires a linked game folder/u.test(message);
}

export function standardIncludeRecovery(
  access: StandardIncludeAccess,
  localInstallationUsable: boolean,
): StandardIncludeRecovery | null {
  const effective =
    access === 'packaged-selection' && !localInstallationUsable ? 'no-linked-installation' : access;
  switch (effective) {
    case 'authorized':
      return null;
    case 'packaged-selection':
      return {
        access: effective,
        cause: t('run-menu.standard-include.cause.packaged-selection'),
        action: 'use-local-version',
      };
    case 'no-linked-installation':
      return {
        access: effective,
        cause: t('run-menu.standard-include.cause.no-linked-installation'),
        action: 'link-game-folder',
      };
    case 'missing-gamedata':
      return {
        access: effective,
        cause: t('run-menu.standard-include.cause.missing-gamedata'),
        action: null,
      };
  }
}

export function isUnverifiedNewerLocalProductVersion(
  catalog: ConfigurationCatalog,
  localProductVersion: string | null,
): boolean {
  if (!localProductVersion || isVerifiedLocalProductVersion(catalog, localProductVersion)) {
    return false;
  }
  const newestVerifiedVersion = catalog.behaviorProfiles
    .flatMap((profile) => profile.productVersions)
    .sort(compareProductVersionsNewestFirst)[0];
  return newestVerifiedVersion
    ? compareProductVersionsNewestFirst(localProductVersion, newestVerifiedVersion) < 0
    : false;
}

export function resolvePreviewProfile(
  catalog: ConfigurationCatalog,
  selectedProfileId: string,
  localProductVersion: string | null,
): BehaviorProfileDescriptor | null {
  if (selectedProfileId !== 'auto') {
    return (
      catalog.behaviorProfiles.find((profile) => profile.profileId === selectedProfileId) ?? null
    );
  }
  const localMatch = localProductVersion
    ? catalog.behaviorProfiles.find((profile) =>
        profile.productVersions.includes(localProductVersion),
      )
    : null;
  return localMatch ?? profilesNewestFirst(catalog.behaviorProfiles)[0] ?? null;
}

export function resolveMinimapPalette(
  profile: BehaviorProfileDescriptor,
  localProductVersion: string | null,
): SelectedMinimapPalette | null {
  const exact = localProductVersion
    ? profile.minimapPalettes.find((palette) => palette.productVersion === localProductVersion)
    : undefined;
  const palette =
    exact ??
    [...profile.minimapPalettes].sort((left, right) =>
      compareProductVersionsNewestFirst(left.productVersion, right.productVersion),
    )[0];
  return palette
    ? {
        ...structuredClone(palette),
        selection: exact ? 'exact-version' : 'latest-fallback',
      }
    : null;
}

export function resolveTexturePalette(
  profile: BehaviorProfileDescriptor,
  localProductVersion: string | null,
): SelectedTexturePalette | null {
  const palettes = profile.texturePalettes ?? [];
  const exact = localProductVersion
    ? palettes.find((palette) => palette.productVersion === localProductVersion)
    : undefined;
  const palette =
    exact ??
    [...palettes].sort((left, right) =>
      compareProductVersionsNewestFirst(left.productVersion, right.productVersion),
    )[0];
  return palette
    ? { ...structuredClone(palette), selection: exact ? 'exact-version' : 'latest-fallback' }
    : null;
}

export function resolvePreviewContentPack(
  catalog: ConfigurationCatalog,
  profileId: string,
  preferredSourceFingerprint: string | null = null,
): ContentPackDescriptor | null {
  const compatible = catalog.contentPacks.filter((pack) =>
    pack.compatibleProfileIds.includes(profileId),
  );
  compatible.sort((left, right) => {
    const leftPreferred = left.sourceFingerprint === preferredSourceFingerprint;
    const rightPreferred = right.sourceFingerprint === preferredSourceFingerprint;
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
    if (left.packagedBundle !== right.packagedBundle) return left.packagedBundle ? -1 : 1;
    if (left.synthetic !== right.synthetic) return left.synthetic ? 1 : -1;
    const versionOrder = compareProductVersionsNewestFirst(left.packVersion, right.packVersion);
    return versionOrder || left.packId.localeCompare(right.packId);
  });
  return compatible[0] ?? null;
}

function compareProductVersionsNewestFirst(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  if (
    leftParts.every((part) => /^\d+$/u.test(part)) &&
    rightParts.every((part) => /^\d+$/u.test(part))
  ) {
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const leftPart = Number(leftParts[index] ?? 0);
      const rightPart = Number(rightParts[index] ?? 0);
      if (leftPart !== rightPart) return rightPart - leftPart;
    }
    return 0;
  }
  return right.localeCompare(left, 'en-US', { numeric: true });
}

export function createRunConfiguration(seed = randomSeed()): RunConfiguration {
  return {
    seed,
    seedLocked: false,
    recentSeeds: [seed],
    runOnSave: false,
    runOnEdit: false,
    mapSize: 'medium',
    width: 168,
    height: 168,
    playerCount: 2,
    playerSlots: playerSequence(1),
    playerColors: playerSequence(0),
    teamIds: defaultTeamIds(),
    civilizationIds: Array.from({ length: 8 }, () => 0),
    computerPlayers: Array.from({ length: 8 }, () => false),
    modeContext: 'random-map',
    ...defaultLobbyOptions(),
    startingResources: 'standard',
    startingAge: 'dark-age',
    endingAge: 'post-imperial-age',
    positionPolicy: 'random',
    profileId: 'auto',
    profileInstallation: null,
    traceLevel: 'off',
    mapTestWorkers: 'auto',
  };
}

export function randomSeed(randomSource: Pick<Crypto, 'getRandomValues'> = crypto): number {
  const value = new Uint32Array(1);
  randomSource.getRandomValues(value);
  return value[0] ?? 0;
}

export function withSeed(configuration: RunConfiguration, seed: number): RunConfiguration {
  const normalized = validateSeed(seed);
  return {
    ...configuration,
    seed: normalized,
    recentSeeds: [
      normalized,
      ...configuration.recentSeeds.filter((value) => value !== normalized),
    ].slice(0, maximumRecentSeeds),
  };
}

export function withMapSize(
  configuration: RunConfiguration,
  mapSize: RunConfiguration['mapSize'],
): RunConfiguration {
  const dimensions = runMapSizeOptions.find((option) => option.value === mapSize);
  if (!dimensions) return configuration;
  return { ...configuration, mapSize, width: dimensions.width, height: dimensions.height };
}

export function withPlayerCount(
  configuration: RunConfiguration,
  playerCount: number,
): RunConfiguration {
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > 8) return configuration;
  return {
    ...configuration,
    playerCount,
    playerSlots: normalizeActiveUniqueValues(configuration.playerSlots, playerCount, 1),
    playerColors: normalizeActiveUniqueValues(configuration.playerColors, playerCount, 0),
  };
}

export function validateRunConfiguration(configuration: RunConfiguration): string[] {
  const errors: string[] = [];
  if (typeof configuration.seedLocked !== 'boolean') errors.push(t('run-menu.invalid.seed-lock'));
  if (typeof configuration.runOnSave !== 'boolean') errors.push(t('run-menu.invalid.run-on-save'));
  if (typeof configuration.runOnEdit !== 'boolean') errors.push(t('run-menu.invalid.run-on-edit'));
  if (
    !Number.isSafeInteger(configuration.seed) ||
    configuration.seed < 0 ||
    configuration.seed > 0xffff_ffff
  ) {
    errors.push(t('run-menu.invalid.seed'));
  }
  const mapSize = runMapSizeOptions.find((option) => option.value === configuration.mapSize);
  if (
    !mapSize ||
    configuration.width !== mapSize.width ||
    configuration.height !== mapSize.height
  ) {
    errors.push(t('run-menu.invalid.map-size'));
  }
  if (
    !Number.isInteger(configuration.playerCount) ||
    configuration.playerCount < 1 ||
    configuration.playerCount > 8
  ) {
    errors.push(t('run-menu.invalid.player-count'));
  }
  validatePlayerValues(configuration.playerSlots, configuration.playerCount, 1, true, errors, {
    invalid: 'run-menu.invalid.player-slots',
    duplicate: 'run-menu.invalid.duplicate-slots',
  });
  validatePlayerValues(configuration.playerColors, configuration.playerCount, 0, true, errors, {
    invalid: 'run-menu.invalid.player-colors',
    duplicate: 'run-menu.invalid.duplicate-colors',
  });
  if (
    !Array.isArray(configuration.teamIds) ||
    configuration.teamIds.length !== 8 ||
    configuration.teamIds.some((value) => !Number.isInteger(value) || value < 0 || value > 4)
  ) {
    errors.push(t('run-menu.invalid.teams'));
  }
  if (
    !Array.isArray(configuration.civilizationIds) ||
    configuration.civilizationIds.length !== 8 ||
    configuration.civilizationIds.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 0xffff_ffff,
    )
  ) {
    errors.push(t('run-menu.invalid.civilizations'));
  }
  if (!isPlayerControllerArray(configuration.computerPlayers)) {
    errors.push(t('run-menu.invalid.controllers'));
  }
  if (
    typeof configuration.profileId !== 'string' ||
    configuration.profileId.length < 1 ||
    configuration.profileId.length > 64
  ) {
    errors.push(t('run-menu.invalid.profile'));
  }
  if (
    configuration.profileInstallation !== null &&
    (typeof configuration.profileInstallation !== 'string' ||
      configuration.profileInstallation.length < 1 ||
      configuration.profileInstallation.length > maximumInstallationSelectionKeyLength ||
      configuration.profileId === 'auto')
  ) {
    errors.push(t('run-menu.invalid.version-scope'));
  }
  if (!runGameModeOptions.some((option) => option.value === configuration.modeContext)) {
    errors.push(t('run-menu.invalid.game-mode'));
  }
  if (!isGameModeModifierList(configuration.gameModeModifiers)) {
    errors.push(t('run-menu.invalid.modifiers'));
  }
  if (
    [
      configuration.turboMode,
      configuration.fullTechTree,
      configuration.antiquityMode,
      configuration.solidFarms,
    ].some((value) => typeof value !== 'boolean')
  ) {
    errors.push(t('run-menu.invalid.lobby-options'));
  }
  if (
    !runStartingResourceOptions.some((option) => option.value === configuration.startingResources)
  ) {
    errors.push(t('run-menu.invalid.starting-resources'));
  }
  if (!runStartingAgeOptions.some((option) => option.value === configuration.startingAge)) {
    errors.push(t('run-menu.invalid.starting-age'));
  }
  if (!runStartingAgeOptions.some((option) => option.value === configuration.endingAge)) {
    errors.push(t('run-menu.invalid.ending-age'));
  } else if (ageRank(configuration.endingAge) < ageRank(configuration.startingAge)) {
    errors.push(t('run-menu.invalid.age-order'));
  }
  if (!runPositionPolicyOptions.some((option) => option.value === configuration.positionPolicy)) {
    errors.push(t('run-menu.invalid.position-policy'));
  }
  if (!['off', 'summary', 'full'].includes(configuration.traceLevel)) {
    errors.push(t('run-menu.invalid.trace-level'));
  }
  if (!isMapTestWorkerSetting(configuration.mapTestWorkers)) {
    errors.push(t('run-menu.invalid.test-cores'));
  }
  return errors;
}

export function buildPreviewGenerationInput(
  configuration: RunConfiguration,
  catalog: ConfigurationCatalog,
  document: { uri: string; content: string },
  documentRevision: number,
  versionOrigin: PreviewVersionOrigin,
  preferredContentSourceFingerprint: string | null = null,
  localProductVersion: string | null = null,
): PreviewGenerationInput {
  const errors = validateRunConfiguration(configuration);
  if (!document.content) errors.push(t('run-menu.blocked.source-empty'));
  const profile = catalog.behaviorProfiles.find(
    (candidate) => candidate.profileId === configuration.profileId,
  );
  const contentPack = profile
    ? resolvePreviewContentPack(catalog, profile.profileId, preferredContentSourceFingerprint)
    : null;
  if (!profile) errors.push(t('run-menu.blocked.profile-unavailable'));
  if (!contentPack) errors.push(t('run-menu.blocked.content-pack-unavailable-profile'));
  if (errors.length > 0 || !profile || !contentPack) throw new Error(errors.join(' '));
  return {
    documentUri: document.uri,
    documentRevision,
    source: document.content,
    profile,
    contentPack,
    versionOrigin,
    backend: 'exact',
    width: configuration.width,
    height: configuration.height,
    mapSize: configuration.mapSize,
    seed: configuration.seed,
    players: previewPlayers(configuration),
    modeContext: serializeModeContext(configuration),
    traceLevel: 'off',
    minimapPalette: resolveMinimapPalette(profile, localProductVersion),
    texturePalette: resolveTexturePalette(profile, localProductVersion),
  };
}

export function languageServerPreviewContext(
  configuration: RunConfiguration,
  contentSelection?: LanguageContentSelection,
): LanguageServerPreviewContext {
  const errors = validateRunConfiguration(configuration);
  if (errors.length > 0) throw new Error(errors.join(' '));
  const computerSlots = computerPlayerSlots(configuration);
  const options = selectedLobbyOptions(configuration);
  return {
    contractVersion: { major: 1, minor: setupContextMinor(options, computerSlots), patch: 0 },
    ...(computerSlots.length > 0 ? { computerPlayerSlots: computerSlots } : {}),
    ...lobbyOptionFields(options),
    ...(contentSelection ? { contentSelection } : {}),
    seed: configuration.seed,
    width: configuration.width,
    height: configuration.height,
    mapSize: configuration.mapSize,
    players: previewPlayers(configuration),
    gameMode: configuration.modeContext,
    startingResources: configuration.startingResources,
    startingAge: configuration.startingAge,
    positionPolicy: configuration.positionPolicy,
  };
}

export function samePreviewContext(
  ambient: LanguageServerPreviewContext | null,
  requested: LanguageServerPreviewContext | null,
): boolean {
  return (
    ambient !== null && requested !== null && JSON.stringify(ambient) === JSON.stringify(requested)
  );
}

export function selectedLobbyOptions(configuration: RunConfiguration): LobbyOptions {
  return {
    gameModeModifiers: activeGameModeModifiers(configuration),
    turboMode: configuration.turboMode === true,
    fullTechTree: configuration.fullTechTree === true,
    antiquityMode: configuration.antiquityMode === true,
    solidFarms: configuration.solidFarms === true,
  };
}

export function activeGameModeModifiers(configuration: RunConfiguration): GameModeModifier[] {
  return effectiveGameModeModifiers(
    configuration.modeContext,
    Array.isArray(configuration.gameModeModifiers) ? configuration.gameModeModifiers : [],
  );
}

export function runSetupContextMinor(configuration: RunConfiguration): 0 | 1 | 2 {
  return setupContextMinor(selectedLobbyOptions(configuration), computerPlayerSlots(configuration));
}

export function withGameModeModifier(
  configuration: RunConfiguration,
  modifier: GameModeModifier,
  enabled: boolean,
): RunConfiguration {
  const current = new Set(configuration.gameModeModifiers);
  if (enabled) current.add(modifier);
  else current.delete(modifier);
  return {
    ...configuration,
    gameModeModifiers: gameModeModifierOptions
      .map((option) => option.value)
      .filter((value) => current.has(value)),
  };
}

export function withRandomMapTurbo(configuration: RunConfiguration): RunConfiguration {
  return { ...configuration, modeContext: 'random-map', turboMode: true };
}

export function withLiveComputerPlayers(configuration: RunConfiguration): RunConfiguration {
  const computerPlayers = configuration.computerPlayers.map((current, index) =>
    index < configuration.playerCount
      ? (configuration.playerSlots[index] ?? index + 1) !== 1
      : current,
  );
  return computerPlayers.every((value, index) => value === configuration.computerPlayers[index])
    ? configuration
    : { ...configuration, computerPlayers };
}

export function liveForcedComputerRows(configuration: RunConfiguration): number[] {
  return Array.from({ length: configuration.playerCount }, (_, index) => index).filter(
    (index) =>
      (configuration.playerSlots[index] ?? index + 1) !== 1 &&
      configuration.computerPlayers[index] !== true,
  );
}

export function liveTestComputerPlayerSlots(configuration: RunConfiguration): number[] {
  return liveComputerPlayerSlots(configuration.playerSlots.slice(0, configuration.playerCount));
}

export function computerPlayerSlots(configuration: RunConfiguration): number[] {
  return Array.from({ length: configuration.playerCount }, (_, index) => index)
    .filter((index) => configuration.computerPlayers[index] === true)
    .map((index) => configuration.playerSlots[index] ?? index + 1)
    .sort((left, right) => left - right);
}

function previewPlayers(configuration: RunConfiguration): PreviewPlayerConfiguration[] {
  return Array.from({ length: configuration.playerCount }, (_, index) => {
    const slot = configuration.playerSlots[index] ?? index + 1;
    const civilizationId = configuration.civilizationIds[index] ?? 0;
    return {
      slot,
      team: configuration.teamIds[index] ?? index + 1,
      civilizationId:
        civilizationId === 0
          ? resolvedRandomCivilization(configuration.profileId, configuration.seed, slot)
          : civilizationId,
    };
  });
}

function resolvedRandomCivilization(profileId: string, seed: number, slot: number): number {
  const civilizations = packedCivilizationOptions(profileId).filter((option) => option.id !== 0);
  if (civilizations.length === 0) return 0;
  let value = (seed ^ Math.imul(slot, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return civilizations[value % civilizations.length]!.id;
}

export function randomCivilizationResolutions(configuration: RunConfiguration): {
  playerIndex: number;
  civilizationId: number;
  name: OutputText;
  readonly label: string;
}[] {
  return previewPlayers(configuration).flatMap((player, playerIndex) => {
    if ((configuration.civilizationIds[playerIndex] ?? 0) !== 0 || player.civilizationId === 0) {
      return [];
    }
    const name = civilizationName(player.civilizationId);
    return [
      {
        playerIndex,
        civilizationId: player.civilizationId,
        name,
        get label() {
          return wordOutputText(name);
        },
      },
    ];
  });
}

export function generationCacheKey(input: PreviewGenerationInput): string {
  return JSON.stringify({
    documentUri: input.documentUri,
    documentRevision: input.documentRevision,
    source: input.source,
    profileId: input.profile.profileId,
    profileHash: input.profile.profileHash,
    contentPackId: input.contentPack.packId,
    contentPackVersion: input.contentPack.packVersion,
    contentHash: input.contentPack.contentHash,
    contentSourceFingerprint: input.contentPack.sourceFingerprint,
    versionOrigin: input.versionOrigin,
    backend: input.backend,
    width: input.width,
    height: input.height,
    mapSize: input.mapSize,
    seed: input.seed,
    players: input.players,
    modeContext: input.modeContext,
    traceLevel: input.traceLevel,
  });
}

export function generationSettingsKey(input: PreviewGenerationInput): string {
  return JSON.stringify({
    profileId: input.profile.profileId,
    profileHash: input.profile.profileHash,
    contentPackId: input.contentPack.packId,
    contentPackVersion: input.contentPack.packVersion,
    contentHash: input.contentPack.contentHash,
    contentSourceFingerprint: input.contentPack.sourceFingerprint,
    versionOrigin: input.versionOrigin,
    width: input.width,
    height: input.height,
    mapSize: input.mapSize,
    seed: input.seed,
    players: input.players,
    modeContext: input.modeContext,
    traceLevel: input.traceLevel,
  });
}

export function parseGenerationSettingsKey(settingsKey: string): GenerationSettings | null {
  let value: unknown;
  try {
    value = JSON.parse(settingsKey);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const settings = value as Record<string, unknown>;
  const strings = [
    'profileId',
    'profileHash',
    'contentPackId',
    'contentPackVersion',
    'contentHash',
    'contentSourceFingerprint',
    'versionOrigin',
    'mapSize',
    'modeContext',
    'traceLevel',
  ] as const;
  if (strings.some((field) => typeof settings[field] !== 'string')) return null;
  if (
    !Number.isSafeInteger(settings.width) ||
    !Number.isSafeInteger(settings.height) ||
    !Number.isSafeInteger(settings.seed) ||
    !Array.isArray(settings.players)
  ) {
    return null;
  }
  return settings as unknown as GenerationSettings;
}

export interface GenerationSettings {
  profileId: string;
  profileHash: string;
  contentPackId: string;
  contentPackVersion: string;
  contentHash: string;
  contentSourceFingerprint: string;
  versionOrigin: PreviewVersionOrigin;
  width: number;
  height: number;
  mapSize: string;
  seed: number;
  players: PreviewPlayerConfiguration[];
  modeContext: string;
  traceLevel: string;
}

export function generationSettingsMatchConfiguration(
  settings: GenerationSettings,
  configuration: RunConfiguration,
): boolean {
  return (
    settings.profileId === configuration.profileId &&
    settings.width === configuration.width &&
    settings.height === configuration.height &&
    settings.mapSize === configuration.mapSize &&
    settings.seed === configuration.seed &&
    settings.modeContext === serializeModeContext(configuration) &&
    JSON.stringify(settings.players) === JSON.stringify(previewPlayers(configuration))
  );
}

export function readStoredRunConfiguration(
  storage: Pick<Storage, 'getItem'>,
  catalog: ConfigurationCatalog,
  sessionSeed = randomSeed(),
): StoredRunConfiguration {
  const fallbackConfiguration = createRunConfiguration(sessionSeed);
  const defaultName = defaultRunPresetName();
  const fallback: StoredRunConfiguration = {
    version: 2,
    current: fallbackConfiguration,
    presets: [runPreset(defaultName, fallbackConfiguration)],
    activePresetName: defaultName,
  };
  try {
    const raw = storage.getItem(runConfigurationStorageKey);
    if (!raw || raw.length > 1024 * 1024) return fallback;
    const parsed = JSON.parse(raw) as Omit<Partial<StoredRunConfiguration>, 'version'> & {
      version?: unknown;
    };
    if (
      (parsed.version !== 1 && parsed.version !== 2) ||
      !parsed.current ||
      !Array.isArray(parsed.presets)
    ) {
      return fallback;
    }
    const storedVersion = parsed.version;
    const current = withSeed(
      validateStoredConfiguration(parsed.current, catalog, storedVersion),
      sessionSeed,
    );
    let presets = parsed.presets
      .slice(0, 64)
      .map((preset) => validatePreset(preset, catalog, storedVersion));
    if (new Set(presets.map((preset) => preset.name)).size !== presets.length) {
      throw new Error('run preset names must be unique');
    }
    const storedActivePresetName =
      typeof parsed.activePresetName === 'string' &&
      presets.some((preset) => preset.name === parsed.activePresetName)
        ? parsed.activePresetName
        : null;
    const localized = localizeAutomaticPresetNames(presets, storedActivePresetName);
    presets = localized.presets;
    let activePresetName = localized.activePresetName;
    if (!activePresetName) {
      if (!presets.some((preset) => preset.name === defaultName)) {
        presets = [runPreset(defaultName, current), ...presets].slice(0, 64);
      }
      activePresetName = defaultName;
    }
    return { version: 2, current, presets, activePresetName };
  } catch {
    return fallback;
  }
}

export function writeStoredRunConfiguration(
  storage: Pick<Storage, 'setItem'>,
  value: StoredRunConfiguration,
): void {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 1024 * 1024) {
    throw new Error('run configuration storage exceeds its bounded size');
  }
  storage.setItem(runConfigurationStorageKey, serialized);
}

export function cliArguments(input: PreviewGenerationInput): string[] {
  return [
    'generate',
    '--document-uri',
    input.documentUri,
    '--document-revision',
    String(input.documentRevision),
    '--profile',
    input.profile.profileId,
    '--content-pack',
    input.contentPack.packId,
    '--backend',
    input.backend,
    '--seed',
    String(input.seed),
    '--width',
    String(input.width),
    '--height',
    String(input.height),
    '--map-size',
    input.mapSize,
    '--players',
    String(input.players.length),
    '--teams',
    input.players.map((player) => player.team).join(','),
    '--civilizations',
    input.players.map((player) => player.civilizationId).join(','),
    '--mode-context',
    input.modeContext,
    '--trace-level',
    input.traceLevel,
  ];
}

function validateStoredConfiguration(
  value: RunConfiguration,
  catalog: ConfigurationCatalog,
  storedVersion: 1 | 2,
): RunConfiguration {
  const configuration = structuredClone(value) as RunConfiguration & {
    backend?: unknown;
    contentPackId?: unknown;
    mapSize: unknown;
    playerSlots?: unknown;
    playerColors?: unknown;
    teamIds?: unknown;
    teamMode?: unknown;
    startingResources?: unknown;
    startingAge?: unknown;
    positionPolicy?: unknown;
    rerollOnSuccessfulEdit?: unknown;
    traceLevel: unknown;
  };
  if (typeof configuration.runOnSave !== 'boolean') configuration.runOnSave = false;
  if (typeof configuration.runOnEdit !== 'boolean') configuration.runOnEdit = false;
  if (!isBoundedPlayerArray(configuration.playerSlots, 1)) {
    configuration.playerSlots = playerSequence(1);
  }
  if (!isBoundedPlayerArray(configuration.playerColors, 0)) {
    configuration.playerColors = playerSequence(0);
  }
  if (!isBoundedTeamArray(configuration.teamIds)) {
    configuration.teamIds = legacyTeamIds(configuration.teamMode);
  }
  if (!isPlayerControllerArray(configuration.computerPlayers)) {
    configuration.computerPlayers = Array.from({ length: 8 }, () => false);
  }
  configuration.gameModeModifiers = isGameModeModifierList(configuration.gameModeModifiers)
    ? gameModeModifierOptions
        .map((option) => option.value)
        .filter((value) => configuration.gameModeModifiers.includes(value))
    : [];
  for (const flag of ['turboMode', 'fullTechTree', 'antiquityMode', 'solidFarms'] as const) {
    if (typeof configuration[flag] !== 'boolean') configuration[flag] = false;
  }
  if (
    !runStartingResourceOptions.some((option) => option.value === configuration.startingResources)
  ) {
    configuration.startingResources = 'standard';
  }
  if (!runStartingAgeOptions.some((option) => option.value === configuration.startingAge)) {
    configuration.startingAge = 'dark-age';
  }
  if (!runStartingAgeOptions.some((option) => option.value === configuration.endingAge)) {
    configuration.endingAge = 'post-imperial-age';
  }
  if (!runPositionPolicyOptions.some((option) => option.value === configuration.positionPolicy)) {
    configuration.positionPolicy = 'random';
  }
  if (storedVersion === 1) configuration.profileId = 'auto';
  if (configuration.profileId === 'auto') {
    configuration.profileInstallation = null;
  } else if (configuration.profileInstallation === undefined) {
    throw new Error('stored version selection scope is missing');
  }
  delete configuration.teamMode;
  delete configuration.backend;
  configuration.traceLevel = 'off';
  if (!isMapTestWorkerSetting(configuration.mapTestWorkers)) configuration.mapTestWorkers = 'auto';
  delete configuration.contentPackId;
  delete configuration.rerollOnSuccessfulEdit;
  const storedMapSize = configuration.mapSize;
  if (isRunMapSize(storedMapSize)) {
    Object.assign(configuration, withMapSize(configuration, storedMapSize));
  } else if (storedMapSize === 'custom') {
    Object.assign(
      configuration,
      withMapSize(configuration, nearestRunMapSize(configuration.width, configuration.height)),
    );
  }
  if (
    validateRunConfiguration(configuration).length > 0 ||
    (configuration.profileId !== 'auto' &&
      !catalog.behaviorProfiles.some((profile) => profile.profileId === configuration.profileId))
  ) {
    throw new Error('stored run configuration is invalid');
  }
  configuration.recentSeeds = configuration.recentSeeds
    .filter((seed) => Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffff_ffff)
    .slice(0, maximumRecentSeeds);
  return configuration;
}

function isRunMapSize(value: unknown): value is RunMapSize {
  return runMapSizeOptions.some((option) => option.value === value);
}

function nearestRunMapSize(width: number, height: number): RunMapSize {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 'medium';
  return runMapSizeOptions.reduce((nearest, option) => {
    const nearestDistance = Math.abs(width - nearest.width) + Math.abs(height - nearest.height);
    const optionDistance = Math.abs(width - option.width) + Math.abs(height - option.height);
    return optionDistance < nearestDistance ? option : nearest;
  }).value;
}

function validatePreset(
  value: RunPreset,
  catalog: ConfigurationCatalog,
  storedVersion: 1 | 2,
): RunPreset {
  if (!value || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 64) {
    throw new Error('run preset name is invalid');
  }
  const configuration = validateStoredConfiguration(
    { ...value.configuration, recentSeeds: [] },
    catalog,
    storedVersion,
  );
  const { recentSeeds: _recentSeeds, ...presetConfiguration } = configuration;
  return { name: value.name, configuration: presetConfiguration };
}

export function runPreset(name: string, configuration: RunConfiguration): RunPreset {
  const { recentSeeds: _recentSeeds, ...presetConfiguration } = configuration;
  return { name, configuration: presetConfiguration };
}

function validateSeed(seed: number): number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error('seed is outside the unsigned 32-bit range');
  }
  return seed;
}

export function serializeModeContext(configuration: RunConfiguration): string {
  const gameMode = nativeOptionValue(runGameModeOptions, configuration.modeContext);
  const resources = nativeOptionValue(runStartingResourceOptions, configuration.startingResources);
  const age = nativeOptionValue(runStartingAgeOptions, configuration.startingAge);
  const positions = nativeOptionValue(runPositionPolicyOptions, configuration.positionPolicy);
  const colors = configuration.playerColors.slice(0, configuration.playerCount).join(',');
  const suffix = compactSetupSuffix(
    computerPlayerSlots(configuration),
    selectedLobbyOptions(configuration),
  );
  return `aoe2:gm=${gameMode};r=${resources};a=${age};p=${positions};c=${colors}${suffix}`;
}

function nativeOptionValue(
  options: readonly { value: string; nativeValue: number }[],
  value: string,
): number {
  return options.find((option) => option.value === value)?.nativeValue ?? 0;
}

function ageRank(age: RunStartingAge): number {
  return runStartingAgeOptions.findIndex((option) => option.value === age);
}

function playerSequence(start: number): number[] {
  return Array.from({ length: 8 }, (_, index) => index + start);
}

function defaultTeamIds(): number[] {
  return Array.from({ length: 8 }, (_, index) => (index % 4) + 1);
}

function normalizeActiveUniqueValues(values: number[], count: number, minimum: number): number[] {
  const normalized =
    Array.isArray(values) && values.length === 8 ? [...values] : playerSequence(minimum);
  const occupied = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const candidate = normalized[index];
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= minimum &&
      candidate < minimum + 8 &&
      !occupied.has(candidate)
    ) {
      occupied.add(candidate);
      continue;
    }
    const available = playerSequence(minimum).find((value) => !occupied.has(value));
    normalized[index] = available ?? minimum;
    occupied.add(normalized[index]!);
  }
  return normalized;
}

function validatePlayerValues(
  values: number[],
  playerCount: number,
  minimum: number,
  unique: boolean,
  errors: string[],
  words: { invalid: MessageId; duplicate: MessageId },
): void {
  if (
    !Array.isArray(values) ||
    values.length !== 8 ||
    values.some((value) => !Number.isInteger(value) || value < minimum || value >= minimum + 8)
  ) {
    errors.push(t(words.invalid));
    return;
  }
  if (unique && new Set(values.slice(0, playerCount)).size !== playerCount) {
    errors.push(t(words.duplicate));
  }
}

function isBoundedPlayerArray(value: unknown, minimum: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 8 &&
    value.every((entry) => Number.isInteger(entry) && entry >= minimum && entry < minimum + 8)
  );
}

function isPlayerControllerArray(value: unknown): value is boolean[] {
  return (
    Array.isArray(value) && value.length === 8 && value.every((entry) => typeof entry === 'boolean')
  );
}

function defaultLobbyOptions(): LobbyOptions {
  return {
    gameModeModifiers: [],
    turboMode: false,
    fullTechTree: false,
    antiquityMode: false,
    solidFarms: false,
  };
}

function isGameModeModifierList(value: unknown): value is GameModeModifier[] {
  return (
    Array.isArray(value) &&
    value.length <= gameModeModifierOptions.length &&
    value.every(isGameModeModifier) &&
    new Set(value).size === value.length
  );
}

function isBoundedTeamArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 8 &&
    value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 4)
  );
}

function legacyTeamIds(value: unknown): number[] {
  if (value === 'allied') return Array.from({ length: 8 }, () => 1);
  if (value === 'two-teams') return Array.from({ length: 8 }, (_, index) => (index % 2) + 1);
  return defaultTeamIds();
}
