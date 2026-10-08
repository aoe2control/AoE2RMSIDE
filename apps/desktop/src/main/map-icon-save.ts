import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import type {
  ManualDeploymentMapIconImage,
  ManualDeploymentMapIconSaveResult,
} from '../shared/api';
import { t } from '../shared/i18n/translator';

export interface MapIconSaveDialogOptions {
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
  title: string;
}

export interface MapIconSaveDependencies {
  icon(token: string): Promise<ManualDeploymentMapIconImage | null>;
  rememberedDirectory(): Promise<string | null>;
  validDirectory(path: string | null): Promise<string | undefined>;
  fallbackDirectories(): readonly (string | null)[];
  showSaveDialog(
    options: MapIconSaveDialogOptions,
  ): Promise<{ canceled: boolean; filePath?: string | undefined }>;
  writeFile(path: string, bytes: Uint8Array, exclusive: boolean): Promise<void>;
  rememberDirectory(path: string): Promise<void>;
}

export async function saveManualMapIcon(
  token: unknown,
  dependencies: MapIconSaveDependencies,
): Promise<ManualDeploymentMapIconSaveResult> {
  if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/u.test(token)) {
    throw new Error('map icon preview token is invalid');
  }
  const icon = await dependencies.icon(token);
  if (!icon) throw new Error('the deployment preview includes no map icon');
  return saveMapIconImage(icon, dependencies);
}

export async function saveGeneratedMapIcon(
  request: unknown,
  dependencies: Omit<MapIconSaveDependencies, 'icon'> & {
    generatedIcon(request: unknown): Promise<ManualDeploymentMapIconImage>;
  },
): Promise<ManualDeploymentMapIconSaveResult> {
  const icon = await dependencies.generatedIcon(request);
  if (icon.source !== 'generated') throw new Error('generated map icon is unavailable');
  return saveMapIconImage(icon, dependencies);
}

async function saveMapIconImage(
  icon: ManualDeploymentMapIconImage,
  dependencies: Omit<MapIconSaveDependencies, 'icon'>,
): Promise<ManualDeploymentMapIconSaveResult> {
  const directory = await mapIconSaveDirectory(dependencies);
  const selection = await dependencies.showSaveDialog({
    defaultPath: directory ? join(directory, icon.fileName) : icon.fileName,
    filters: [{ name: t('native-dialog.map-icon.filter'), extensions: ['png'] }],
    title: t('native-dialog.map-icon.title'),
  });
  if (selection.canceled || !selection.filePath) return { status: 'cancelled' };
  if (!isAbsolute(selection.filePath)) throw new Error('map icon save path is invalid');
  const confirmedByDialog = extname(selection.filePath).toLowerCase() === '.png';
  const path = confirmedByDialog ? selection.filePath : `${selection.filePath}.png`;
  await dependencies.rememberDirectory(dirname(path));
  await dependencies.writeFile(path, icon.bytes, !confirmedByDialog);
  return { status: 'saved', fileName: basename(path) };
}

export async function mapIconSaveDirectory(
  dependencies: Pick<
    MapIconSaveDependencies,
    'fallbackDirectories' | 'rememberedDirectory' | 'validDirectory'
  >,
): Promise<string | undefined> {
  const remembered = await dependencies.validDirectory(await dependencies.rememberedDirectory());
  if (remembered) return remembered;
  for (const fallback of dependencies.fallbackDirectories()) {
    const valid = await dependencies.validDirectory(fallback);
    if (valid) return valid;
  }
  return undefined;
}
