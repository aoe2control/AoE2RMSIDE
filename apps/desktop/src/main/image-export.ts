import { deflate } from 'node:zlib';
import { promisify } from 'node:util';
import type { ManualDeploymentMapIconImage } from '../shared/api';
import {
  validateClipboardImageRequest,
  validatePreviewImageSaveRequest,
  type ExportImagePixels,
  type PreviewImageSaveResult,
} from '../shared/image-export';
import { t } from '../shared/i18n/translator';
import { assembleRgbaPng, rgbaPngScanlines } from './map-icon-png';
import { savePngThroughDialog, type MapIconSaveDependencies } from './map-icon-save';

const deflateAsync = promisify(deflate);
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export async function encodeExportImagePng(
  image: Readonly<ExportImagePixels>,
): Promise<Uint8Array> {
  const compressed = await deflateAsync(rgbaPngScanlines(image.pixels, image.width, image.height), {
    level: 6,
  });
  return assembleRgbaPng(image.width, image.height, compressed);
}

export interface ClipboardImageDependencies {
  mapIcon(token: string): Promise<ManualDeploymentMapIconImage | null>;
  writeImage(png: Uint8Array): Promise<boolean>;
}

export async function copyImageToClipboard(
  request: unknown,
  dependencies: ClipboardImageDependencies,
): Promise<void> {
  const valid = validateClipboardImageRequest(request);
  let png: Uint8Array;
  if (valid.kind === 'pixels') {
    png = await encodeExportImagePng(valid);
  } else {
    const icon = await dependencies.mapIcon(valid.token);
    if (!icon) throw new Error('the deployment preview includes no map icon');
    png = icon.bytes;
  }
  if (!startsWithPngSignature(png)) throw new Error('clipboard image is not a PNG');
  if (!(await dependencies.writeImage(png)))
    throw new Error('the image could not be put on the clipboard');
}

export async function savePreviewImage(
  request: unknown,
  dependencies: Omit<MapIconSaveDependencies, 'icon'>,
): Promise<PreviewImageSaveResult> {
  const valid = validatePreviewImageSaveRequest(request);
  return savePngThroughDialog(
    {
      bytes: await encodeExportImagePng(valid),
      fileName: valid.fileName,
      filterName: t('native-dialog.preview-image.filter'),
      title: t('native-dialog.preview-image.title'),
    },
    dependencies,
  );
}

function startsWithPngSignature(bytes: Uint8Array): boolean {
  return pngSignature.every((value, index) => bytes[index] === value);
}
