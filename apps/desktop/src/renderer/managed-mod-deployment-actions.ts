import {
  defaultMapIconRenderInput,
  type ManagedDeploymentRequest,
  type ManagedDeploymentResult,
  type ManualDeploymentApplyRequest,
  type ManualDeploymentMapIconRequest,
  type ManualDeploymentPreview,
  type ManualDeploymentPreviewRequest,
  type MapIconRenderInput,
  type PreviewGenerationResult,
  type RmsideDesktopApi,
} from '../shared/api';
import { presentDeploymentFailure } from '../shared/message-catalog';
import type { OutputMessage } from '../shared/output-message';
import { deploymentOutputMessages } from './managed-mod-deployment-state';
import {
  gameTexturesDeploymentMapIcon,
  previewMatchesMapIconRequest,
  renderDeploymentMapIcon,
  resolveMapIconOption,
} from './managed-mod-map-icon';
import { drawMapIconGameTextures, effectiveMapIconLook } from './map-icon-game-textures';

export type ManualDeploymentActionsApi = Pick<
  RmsideDesktopApi,
  | 'previewManualDeployment'
  | 'applyManualDeployment'
  | 'getMapIconRenderInput'
  | 'getGameArtStatus'
  | 'getGameArtTerrain'
  | 'getGameArtImages'
>;

export function deploymentRequest(
  result: PreviewGenerationResult,
  includePreviewImage: boolean,
): ManagedDeploymentRequest {
  return {
    contractVersion: { major: 1, minor: 0, patch: 0 },
    documentUri: result.documentUri,
    documentRevision: result.documentRevision,
    sourceCatalogRevision: result.sourceCatalogRevision,
    sourceCatalogHash: result.sourceCatalogHash,
    sourceGraphHash: result.sourceGraphHash,
    externalAssetHash: result.externalAssetHash,
    resolvedRmsSourceIds: [...result.resolvedRmsSourceIds],
    externalAssetSourceIds: [...result.externalAssetSourceIds],
    includePreviewImage,
  };
}

export async function prepareManualDeployment(
  api: Pick<ManualDeploymentActionsApi, 'previewManualDeployment'>,
  request: ManualDeploymentPreviewRequest,
): Promise<ManualDeploymentPreview> {
  const fresh = await api.previewManualDeployment(request);
  if (!previewMatchesMapIconRequest(fresh.mapIcon, request.mapIcon)) {
    throw new Error('The map icon option changed while the deployment was being prepared.');
  }
  return fresh;
}

export async function applyManualDeploymentWithOutput(
  api: Pick<ManualDeploymentActionsApi, 'applyManualDeployment'>,
  appendOutput: (message: OutputMessage) => void,
  request: ManualDeploymentApplyRequest,
): Promise<ManagedDeploymentResult> {
  let result: ManagedDeploymentResult;
  try {
    result = await api.applyManualDeployment(request);
  } catch (error) {
    appendOutput(presentDeploymentFailure(error instanceof Error ? error.message : String(error)));
    throw error;
  }
  for (const message of deploymentOutputMessages(result)) appendOutput(message);
  return result;
}

export async function rememberedDeploymentMapIcon(
  api: Pick<
    ManualDeploymentActionsApi,
    'getMapIconRenderInput' | 'getGameArtStatus' | 'getGameArtTerrain' | 'getGameArtImages'
  >,
  result: PreviewGenerationResult,
  originalAvailable: boolean,
  signal: AbortSignal,
  draw: {
    textured: typeof drawMapIconGameTextures;
    colors: typeof renderDeploymentMapIcon;
  } = { textured: drawMapIconGameTextures, colors: renderDeploymentMapIcon },
): Promise<ManualDeploymentMapIconRequest> {
  const option = resolveMapIconOption(null, originalAvailable);
  if (option.mode !== 'generate') return { mode: option.mode };
  const input = await api
    .getMapIconRenderInput()
    .catch((): MapIconRenderInput => ({ ...defaultMapIconRenderInput }));
  if (input.look === 'game-textures') {
    const textured = await draw.textured(api, result, input);
    if (textured) {
      const icon = await gameTexturesDeploymentMapIcon(result, input, textured);
      return { mode: 'generate', render: icon.render };
    }
  }
  const icon = await draw.colors(
    result,
    { ...input, look: effectiveMapIconLook(input.look, false) },
    signal,
  );
  return { mode: 'generate', render: icon.render };
}
