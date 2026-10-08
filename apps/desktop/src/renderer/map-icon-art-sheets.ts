import nomadFeetSheetData from '../../../../assets/original/map-icon-players/nomad-feet-v1.webp?inline';
import playerSquaresSheetData from '../../../../assets/original/map-icon-players/player-squares-v1.png?inline';
import resourceSheetData from '../../../../assets/original/map-icon-resources/resource-spritesheet-v1.webp?inline';
import treeSheetData from '../../../../assets/original/map-icon-trees/tree-spritesheet-v1.webp?inline';
import {
  mapIconResourceSheetLayout,
  mapIconTreeSheetLayout,
  processMapIconSpriteSheet,
  type MapIconArtSheets,
  type MapIconSheetPixels,
} from './map-icon-art';
import {
  processMapIconNomadFeetSheet,
  processMapIconPlayerSquaresSheet,
} from './map-icon-player-markers';

let sheets: Promise<MapIconArtSheets> | null = null;

export function loadMapIconArtSheets(): Promise<MapIconArtSheets> {
  sheets ??= Promise.all([
    decodeSheet(treeSheetData),
    decodeSheet(resourceSheetData),
    decodeSheet(playerSquaresSheetData),
    decodeSheet(nomadFeetSheetData),
  ])
    .then(([trees, resources, squares, feet]) => ({
      trees: processMapIconSpriteSheet(trees, mapIconTreeSheetLayout),
      resources: processMapIconSpriteSheet(resources, mapIconResourceSheetLayout),
      players: {
        squares: processMapIconPlayerSquaresSheet(squares),
        feet: processMapIconNomadFeetSheet(feet),
      },
    }))
    .catch((error: unknown) => {
      sheets = null;
      throw error;
    });
  return sheets;
}

export function mapIconSheetImage(dataUrl: string): {
  type: 'image/webp' | 'image/png';
  bytes: Uint8Array<ArrayBuffer>;
} {
  const match = /^data:(image\/(?:webp|png));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUrl);
  if (!match) throw new Error('map icon sprite sheet is not an inlined WebP or PNG image');
  const binary = atob(match[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { type: match[1] as 'image/webp' | 'image/png', bytes };
}

export function mapIconSheetBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  return mapIconSheetImage(dataUrl).bytes;
}

async function decodeSheet(dataUrl: string): Promise<MapIconSheetPixels> {
  const { type, bytes } = mapIconSheetImage(dataUrl);
  const bitmap = await createImageBitmap(new Blob([bytes], { type }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('map icon sprite sheet cannot be decoded');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, rgba: data };
  } finally {
    bitmap.close();
  }
}
