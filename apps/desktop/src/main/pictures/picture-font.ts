export const pictureGlyphWidth = 5;
export const pictureGlyphHeight = 7;
export const pictureGlyphSpacing = 1;

const glyphRows: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.....', '..#..'],
  ':': ['.....', '..#..', '.....', '.....', '.....', '..#..', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#.#.#', '#...#'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
});

const glyphMasks: ReadonlyMap<string, readonly number[]> = new Map(
  Object.entries(glyphRows).map(([character, rows]) => [
    character,
    rows.map((row) =>
      [...row].reduce(
        (mask, cell, column) => (cell === '#' ? mask | (1 << (4 - column)) : mask),
        0,
      ),
    ),
  ]),
);

export function pictureFontSupports(text: string): boolean {
  for (const character of text) if (!glyphMasks.has(character)) return false;
  return true;
}

export function pictureTextWidth(text: string, scale: number): number {
  const length = [...text].length;
  return length === 0
    ? 0
    : (length * (pictureGlyphWidth + pictureGlyphSpacing) - pictureGlyphSpacing) * scale;
}

export function pictureTextHeight(scale: number): number {
  return pictureGlyphHeight * scale;
}

export function forEachTextPixel(
  text: string,
  left: number,
  top: number,
  scale: number,
  plot: (x: number, y: number) => void,
): void {
  let cursor = left;
  for (const character of text) {
    const masks = glyphMasks.get(character);
    if (!masks) throw new Error(`the picture font has no glyph for ${JSON.stringify(character)}`);
    for (let row = 0; row < pictureGlyphHeight; row += 1) {
      const mask = masks[row]!;
      for (let column = 0; column < pictureGlyphWidth; column += 1) {
        if (mask & (1 << (4 - column))) plot(cursor + column * scale, top + row * scale);
      }
    }
    cursor += (pictureGlyphWidth + pictureGlyphSpacing) * scale;
  }
}
