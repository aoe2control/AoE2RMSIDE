export interface MorphPicture {
  texels: Uint8Array;
  width: number;
  height: number;
}

export interface MorphFieldOptions {
  grid: number;
  field: number;
  window: number;
  radius: number;
  distancePenalty: number;
  minimumGain: number;
  maximumError: number;
}

export const defaultMorphFieldOptions: MorphFieldOptions = {
  grid: 64,
  field: 32,
  window: 4,
  radius: 6,
  distancePenalty: 0.0025,
  minimumGain: 0.012,
  maximumError: 0.09,
};

export interface MorphField {
  size: number;
  vectors: Float32Array;
  maximum: number;
  movedBlocks: number;
}

export function morphColourGrid(picture: MorphPicture, size: number): Float32Array {
  const { texels, width, height } = picture;
  const sums = new Float64Array(size * size * 3);
  const counts = new Uint32Array(size * size);
  for (let y = 0; y < height; y += 1) {
    const cellY = Math.min(size - 1, Math.floor(((y + 0.5) * size) / height));
    for (let x = 0; x < width; x += 1) {
      const cellX = Math.min(size - 1, Math.floor(((x + 0.5) * size) / width));
      const cell = cellY * size + cellX;
      const texel = (y * width + x) * 4;
      sums[cell * 3] = sums[cell * 3]! + texels[texel]!;
      sums[cell * 3 + 1] = sums[cell * 3 + 1]! + texels[texel + 1]!;
      sums[cell * 3 + 2] = sums[cell * 3 + 2]! + texels[texel + 2]!;
      counts[cell] = counts[cell]! + 1;
    }
  }
  const grid = new Float32Array(size * size * 3);
  for (let cellY = 0; cellY < size; cellY += 1) {
    for (let cellX = 0; cellX < size; cellX += 1) {
      const cell = cellY * size + cellX;
      const count = counts[cell]!;
      if (count > 0) {
        for (let channel = 0; channel < 3; channel += 1) {
          grid[cell * 3 + channel] = sums[cell * 3 + channel]! / count / 255;
        }
        continue;
      }
      const x = Math.min(width - 1, Math.floor(((cellX + 0.5) * width) / size));
      const y = Math.min(height - 1, Math.floor(((cellY + 0.5) * height) / size));
      const texel = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        grid[cell * 3 + channel] = texels[texel + channel]! / 255;
      }
    }
  }
  return grid;
}

export function computeMorphField(
  previous: MorphPicture,
  next: MorphPicture,
  options: MorphFieldOptions = defaultMorphFieldOptions,
): MorphField {
  const { grid: size, field, window, radius } = options;
  if (size % field !== 0) throw new Error('morph grid must be a multiple of the field');
  const block = size / field;
  const oldGrid = morphColourGrid(previous, size);
  const newGrid = morphColourGrid(next, size);
  const raw = new Float32Array(field * field * 2);
  const windowStart = Math.floor((window - block) / 2);
  const windowCells = window * window * 3;
  let movedBlocks = 0;
  for (let fieldY = 0; fieldY < field; fieldY += 1) {
    for (let fieldX = 0; fieldX < field; fieldX += 1) {
      const startX = fieldX * block - windowStart;
      const startY = fieldY * block - windowStart;
      const cost = (offsetX: number, offsetY: number, limit: number) => {
        let total = 0;
        for (let row = 0; row < window; row += 1) {
          const newY = clampIndex(startY + row, size);
          const oldY = clampIndex(startY + row + offsetY, size);
          for (let column = 0; column < window; column += 1) {
            const newCell = (newY * size + clampIndex(startX + column, size)) * 3;
            const oldCell = (oldY * size + clampIndex(startX + column + offsetX, size)) * 3;
            total +=
              Math.abs(newGrid[newCell]! - oldGrid[oldCell]!) +
              Math.abs(newGrid[newCell + 1]! - oldGrid[oldCell + 1]!) +
              Math.abs(newGrid[newCell + 2]! - oldGrid[oldCell + 2]!);
          }
          if (total >= limit) return total;
        }
        return total;
      };
      const stay = cost(0, 0, Number.POSITIVE_INFINITY) / windowCells;
      let best = stay;
      let bestScore = stay;
      let bestX = 0;
      let bestY = 0;
      if (stay > options.minimumGain) {
        for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
          for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
            if (offsetX === 0 && offsetY === 0) continue;
            const penalty = options.distancePenalty * Math.hypot(offsetX, offsetY);
            const limit = (bestScore - penalty) * windowCells;
            if (limit <= 0) continue;
            const difference = cost(offsetX, offsetY, limit) / windowCells;
            const score = difference + penalty;
            if (score < bestScore) {
              bestScore = score;
              best = difference;
              bestX = offsetX;
              bestY = offsetY;
            }
          }
        }
      }
      const moved =
        (bestX !== 0 || bestY !== 0) &&
        stay - best >= options.minimumGain &&
        best <= options.maximumError;
      const vector = (fieldY * field + fieldX) * 2;
      if (moved) {
        raw[vector] = bestX / size;
        raw[vector + 1] = bestY / size;
        movedBlocks += 1;
      }
    }
  }
  return {
    size: field,
    vectors: smoothMorphVectors(raw, field),
    maximum: radius / size,
    movedBlocks,
  };
}

export function smoothMorphVectors(vectors: Float32Array, size: number): Float32Array {
  const median = new Float32Array(vectors.length);
  const neighbourhood = new Float32Array(9);
  for (let component = 0; component < 2; component += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const at = (clampIndex(y + dy, size) * size + clampIndex(x + dx, size)) * 2;
            neighbourhood[count] = vectors[at + component]!;
            count += 1;
          }
        }
        neighbourhood.sort();
        median[(y * size + x) * 2 + component] = neighbourhood[4]!;
      }
    }
  }
  let current = median;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Float32Array(current.length);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        for (let component = 0; component < 2; component += 1) {
          let sum = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              sum +=
                current[
                  (clampIndex(y + dy, size) * size + clampIndex(x + dx, size)) * 2 + component
                ]!;
            }
          }
          next[(y * size + x) * 2 + component] = sum / 9;
        }
      }
    }
    current = next;
  }
  return current;
}

export function morphFieldTexels(field: MorphField): Uint8Array {
  const texels = new Uint8Array(field.size * field.size * 4);
  const scale = field.maximum > 0 ? 127 / field.maximum : 0;
  for (let index = 0; index < field.size * field.size; index += 1) {
    texels[index * 4] = encodeComponent(field.vectors[index * 2]! * scale);
    texels[index * 4 + 1] = encodeComponent(field.vectors[index * 2 + 1]! * scale);
    texels[index * 4 + 2] = 0;
    texels[index * 4 + 3] = 255;
  }
  return texels;
}

function encodeComponent(value: number): number {
  return Math.min(255, Math.max(1, 128 + Math.round(value)));
}

function clampIndex(value: number, size: number): number {
  return value < 0 ? 0 : value >= size ? size - 1 : value;
}
