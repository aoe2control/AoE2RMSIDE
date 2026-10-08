export const gameModeModifierOptions = [
  {
    value: 'empire-wars',
    labelId: 'game-options.game-mode.empire-wars',
    gameMode: 'empire-wars',
    protocolValue: 1,
  },
  {
    value: 'sudden-death',
    labelId: 'game-options.game-mode.sudden-death',
    gameMode: 'sudden-death',
    protocolValue: 2,
  },
  {
    value: 'regicide',
    labelId: 'game-options.game-mode.regicide',
    gameMode: 'regicide',
    protocolValue: 3,
  },
  {
    value: 'king-of-the-hill',
    labelId: 'game-options.game-mode.king-of-the-hill',
    gameMode: 'king-of-the-hill',
    protocolValue: 4,
  },
] as const;

export type GameModeModifier = (typeof gameModeModifierOptions)[number]['value'];

export const lobbyOptionFlags = [
  'turboMode',
  'fullTechTree',
  'antiquityMode',
  'solidFarms',
] as const;
export type LobbyOptionFlag = (typeof lobbyOptionFlags)[number];

export interface LobbyOptions {
  gameModeModifiers: GameModeModifier[];
  turboMode: boolean;
  fullTechTree: boolean;
  antiquityMode: boolean;
  solidFarms: boolean;
}

const compactFlagKeys: Record<LobbyOptionFlag, string> = {
  turboMode: 't',
  fullTechTree: 'ft',
  antiquityMode: 'aq',
  solidFarms: 'sf',
};

export const compactLobbyOptionKeys = ['m', ...Object.values(compactFlagKeys)] as const;

export function isGameModeModifier(value: unknown): value is GameModeModifier {
  return gameModeModifierOptions.some((option) => option.value === value);
}

export function effectiveGameModeModifiers(
  gameMode: string,
  modifiers: readonly string[],
): GameModeModifier[] {
  return gameModeModifierOptions
    .filter((option) => option.gameMode !== gameMode && modifiers.includes(option.value))
    .map((option) => option.value);
}

export function hasLobbyOptions(options: Partial<LobbyOptions>): boolean {
  return (
    (options.gameModeModifiers?.length ?? 0) > 0 ||
    lobbyOptionFlags.some((flag) => options[flag] === true)
  );
}

export function setupContextMinor(
  options: Partial<LobbyOptions>,
  computerPlayerSlots: readonly number[],
): 0 | 1 | 2 {
  if (hasLobbyOptions(options)) return 2;
  return computerPlayerSlots.length > 0 ? 1 : 0;
}

export function compactSetupSuffix(
  computerPlayerSlots: readonly number[],
  options: Partial<LobbyOptions>,
): string {
  let suffix = computerPlayerSlots.length > 0 ? `;ai=${computerPlayerSlots.join(',')}` : '';
  const modifiers = gameModeModifierOptions
    .filter((option) => options.gameModeModifiers?.includes(option.value))
    .map((option) => option.protocolValue);
  if (modifiers.length > 0) suffix += `;m=${modifiers.join(',')}`;
  for (const flag of lobbyOptionFlags) {
    if (options[flag] === true) suffix += `;${compactFlagKeys[flag]}=1`;
  }
  return suffix;
}

export function lobbyOptionFields(options: Partial<LobbyOptions>): Partial<LobbyOptions> {
  return {
    ...((options.gameModeModifiers?.length ?? 0) > 0
      ? { gameModeModifiers: [...options.gameModeModifiers!] }
      : {}),
    ...Object.fromEntries(
      lobbyOptionFlags.filter((flag) => options[flag] === true).map((flag) => [flag, true]),
    ),
  };
}

export function liveComputerPlayerSlots(playerSlots: readonly number[]): number[] {
  return playerSlots.filter((slot) => slot !== 1).sort((left, right) => left - right);
}
