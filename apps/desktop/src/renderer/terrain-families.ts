export type TerrainFamily =
  'water' | 'beach' | 'road' | 'forest' | 'snow' | 'desert' | 'rock' | 'dirt' | 'grass' | 'unknown';

export const terrainFamilyRules: ReadonlyArray<readonly [TerrainFamily, RegExp]> = Object.freeze([
  ['water', /WATER|SHALLOW|DEEP/u],
  ['beach', /BEACH/u],
  ['road', /(?<!B)ROAD|COBBLE/u],
  ['forest', /FOREST|JUNGLE(?!_?(?:GRASS|LEAVES))|BAMBOO|PALM|(?<![A-Z])(?:OAK|PINE)/u],
  ['snow', /SNOW|(?<![A-Z])IC[EY]/u],
  ['desert', /DESERT|SAND|DUNE/u],
  ['rock', /ROCK|GRAVEL/u],
  ['dirt', /DIRT|EARTH|MUD/u],
  ['grass', /GRASS/u],
]);

export const terrainFamilyColors: Readonly<Record<TerrainFamily, number>> = Object.freeze({
  water: 0x3b6fb0,
  beach: 0xc9a978,
  road: 0x8f8f8f,
  forest: 0x2f5a2a,
  snow: 0xe4eaee,
  desert: 0xd8bf85,
  rock: 0x857866,
  dirt: 0x8a6440,
  grass: 0x5f9a3c,
  unknown: 0x7d8050,
});

export function classifyTerrainFamily(names: readonly string[]): TerrainFamily {
  for (const name of names) {
    const text = name.toUpperCase();
    for (const [family, pattern] of terrainFamilyRules) {
      if (pattern.test(text)) return family;
    }
  }
  return 'unknown';
}

const shadeSteps = [-2, -1, 0, 1, 2] as const;
const shadeStepFactor = 0.07;

export function terrainFamilyColor(terrainId: number, family: TerrainFamily): number {
  const base = terrainFamilyColors[family];
  const step = shadeSteps[(((Math.trunc(terrainId) * 3) % 5) + 5) % 5]!;
  const factor = 1 + step * shadeStepFactor;
  const channel = (shift: number) =>
    Math.min(255, Math.max(0, Math.round(((base >> shift) & 0xff) * factor)));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
