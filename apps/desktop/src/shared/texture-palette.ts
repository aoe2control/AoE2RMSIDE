import type {
  SelectedTexturePalette,
  TexturePaletteDescriptor,
  TerrainTextureColor,
  ObjectTextureColor,
  CliffTextureColor,
} from './api';

const maximumTerrainColors = 4096;
const maximumObjectColors = 100_000;
const maximumCliffColors = 4096;

function validColor(color: unknown): boolean {
  return Number.isInteger(color) && (color as number) >= 0 && (color as number) <= 0xffffff;
}

function ascending<T>(values: unknown, key: keyof T & string, maximum: number): values is T[] {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.length <= maximum &&
    values.every((value: unknown, index) => {
      if (typeof value !== 'object' || value === null) return false;
      const record = value as Record<string, unknown>;
      const id = record[key];
      const previous = index === 0 ? -1 : (values[index - 1] as Record<string, number>)[key]!;
      return (
        Number.isInteger(id) &&
        (id as number) >= 0 &&
        (id as number) <= 0xffff_ffff &&
        (id as number) > previous &&
        validColor(record.color) &&
        Object.keys(record).length === 2
      );
    })
  );
}

export function isTexturePaletteDescriptor(value: unknown): value is TexturePaletteDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const palette = value as Partial<Record<keyof TexturePaletteDescriptor, unknown>>;
  const provenance = palette.provenance as Record<string, unknown> | undefined;
  const text = (field: unknown, maximum: number) =>
    typeof field === 'string' && field.length > 0 && field.length <= maximum;
  return (
    text(palette.paletteId, 96) &&
    text(palette.productVersion, 64) &&
    typeof palette.paletteHash === 'string' &&
    /^[0-9a-f]{64}$/u.test(palette.paletteHash) &&
    typeof provenance === 'object' &&
    provenance !== null &&
    text(provenance.tool, 256) &&
    text(provenance.installationBuild, 64) &&
    typeof provenance.derivedOn === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(provenance.derivedOn) &&
    ascending<TerrainTextureColor>(palette.terrainColors, 'terrainId', maximumTerrainColors) &&
    ascending<ObjectTextureColor>(palette.objectColors, 'objectId', maximumObjectColors) &&
    ascending<CliffTextureColor>(palette.cliffColors, 'cliffType', maximumCliffColors)
  );
}

export function isSelectedTexturePaletteOrAbsent(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return (
    isTexturePaletteDescriptor(value) &&
    ((value as SelectedTexturePalette).selection === 'exact-version' ||
      (value as SelectedTexturePalette).selection === 'latest-fallback')
  );
}

export interface TextureLookColors {
  key: string;
  terrains: ReadonlyMap<number, number>;
  gaiaObjects: ReadonlyMap<number, number>;
  cliffs: ReadonlyMap<number, number>;
}

const lookColorCache = new WeakMap<TexturePaletteDescriptor, TextureLookColors>();

export function textureLookColors(palette: TexturePaletteDescriptor): TextureLookColors {
  let colors = lookColorCache.get(palette);
  if (!colors) {
    colors = {
      key: palette.paletteHash,
      terrains: new Map(palette.terrainColors.map((entry) => [entry.terrainId, entry.color])),
      gaiaObjects: new Map(palette.objectColors.map((entry) => [entry.objectId, entry.color])),
      cliffs: new Map(palette.cliffColors.map((entry) => [entry.cliffType, entry.color])),
    };
    lookColorCache.set(palette, colors);
  }
  return colors;
}

export function lookMarkerObjectColors(
  look: 'minimap' | 'texture-colors' | 'game-textures',
  palette: TexturePaletteDescriptor | null | undefined,
): ReadonlyMap<number, number> | undefined {
  return look !== 'minimap' && palette ? textureLookColors(palette).gaiaObjects : undefined;
}
