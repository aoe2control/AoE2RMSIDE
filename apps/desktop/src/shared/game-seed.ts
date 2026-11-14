export const gameSeedRange = 0x1_0000_0000;
export const minimumSignedGameSeed = -0x8000_0000;
export const maximumGameSeed = 0xffff_ffff;

export function unsignedGameSeed(value: number): number | null {
  if (!Number.isSafeInteger(value) || value < minimumSignedGameSeed || value > maximumGameSeed) {
    return null;
  }
  return value < 0 ? value + gameSeedRange : value + 0;
}

export function gameSeedFromDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (!/^-?\d{1,10}$/u.test(trimmed)) return null;
  return unsignedGameSeed(Number(trimmed));
}
