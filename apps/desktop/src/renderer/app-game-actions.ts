import { useEffect } from 'react';
import type {
  ManualDeploymentMapIconRequest,
  ManualDeploymentPreview,
  PreviewGenerationResult,
  RmsideDesktopApi,
} from '../shared/api';
import type { ConnectorRendererRequest } from '../shared/connector-api';
import {
  appGameLimits,
  validateAppDeployRequest,
  validateAppLiveTestRequest,
  type AppDeployApplyRequest,
  type AppDeployPrepareRequest,
  type AppDeployReply,
  type AppGameMissing,
  type AppGameRunFailure,
  type AppLiveTestReply,
  type AppLiveTestRequest,
} from '../shared/connector-game-api';
import { desktopErrorFacts } from '../shared/desktop-error';
import { generationWarningCrashes } from '../shared/known-crashes';
import { presentDeploymentFailure } from '../shared/message-catalog';
import { outputMessageText, type OutputMessage } from '../shared/output-message';
import {
  AppRunRefusal,
  resolveAppRunDocument,
  type AppRunDocument,
  type AppRunWorkspace,
} from './app-runs';
import {
  applyManualDeploymentWithOutput,
  deploymentRequest,
  prepareManualDeployment,
  rememberedDeploymentMapIcon,
  type ManualDeploymentActionsApi,
} from './managed-mod-deployment-actions';
import { readEnableModPreference, suggestedModName } from './managed-mod-deployment-state';
import { isStaleExactPreviewError } from './preview-execution';

export type AppExactResult =
  | { outcome: 'result'; result: PreviewGenerationResult; reused?: boolean }
  | AppGameRunFailure
  | { outcome: 'not-ready'; missing: AppGameMissing }
  | { outcome: 'cancelled' }
  | { outcome: 'busy' };

export interface AppGameHost {
  exactResult(
    document: AppRunDocument,
    token: string,
    app: string,
    reuse: boolean,
  ): Promise<AppExactResult>;
  liveTest(request: AppLiveTestRequest, document: AppRunDocument): Promise<AppLiveTestReply>;
}

export interface AppDeployServices {
  api: ManualDeploymentActionsApi & Pick<RmsideDesktopApi, 'getManualDeploymentContext'>;
  appendOutput(message: OutputMessage): void;
  enablePreference(): boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deployFailed(services: AppDeployServices, error: unknown): AppDeployReply {
  const presentation = presentDeploymentFailure(errorMessage(error));
  services.appendOutput(presentation);
  const words = outputMessageText(presentation).trim() || 'The deployment failed.';
  return { outcome: 'deploy-failed', message: words.slice(0, appGameLimits.message) };
}

export async function prepareAppDeployment(
  services: AppDeployServices,
  host: AppGameHost,
  request: AppDeployPrepareRequest,
  document: AppRunDocument,
): Promise<AppDeployReply> {
  const context = await services.api.getManualDeploymentContext(document.uri);
  if (!context) return { outcome: 'not-ready', missing: 'game-folder' };
  const profileId = context.selectedProfileId;
  if (!profileId) return { outcome: 'not-ready', missing: 'profile' };
  const modName =
    request.modName ??
    suggestedModName(context.ownedTargets, profileId, { uri: document.uri, name: document.name });
  for (const reuse of [true, false]) {
    const exact = await host.exactResult(document, request.token, request.app, reuse);
    if (exact.outcome !== 'result') {
      return exact.outcome === 'failed'
        ? { ...exact, message: exact.message.slice(0, appGameLimits.message) }
        : exact;
    }
    const { result } = exact;
    let mapIcon: ManualDeploymentMapIconRequest;
    let preview: ManualDeploymentPreview;
    try {
      mapIcon = await rememberedDeploymentMapIcon(
        services.api,
        result,
        context.originalMapIconAvailable,
        new AbortController().signal,
      );
      preview = await prepareManualDeployment(services.api, {
        deployment: deploymentRequest(result, mapIcon.mode === 'retain-original'),
        profileId,
        modName,
        mapIcon,
      });
    } catch (error) {
      if (exact.reused && isStaleExactPreviewError(errorMessage(error))) continue;
      return deployFailed(services, error);
    }
    return {
      outcome: 'ready',
      path: document.path,
      name: document.name.slice(0, appGameLimits.name),
      previewToken: preview.token,
      modName: preview.modName,
      profileId: preview.profileId,
      targetExists: preview.targetExists,
      files: preview.desiredFiles.length,
      crashes: generationWarningCrashes(result.warnings).slice(0, appGameLimits.crashes),
    };
  }
  return deployFailed(services, new Error('The map changed while it was being deployed.'));
}

export async function applyAppDeployment(
  services: AppDeployServices,
  request: AppDeployApplyRequest,
): Promise<AppDeployReply> {
  try {
    const result = await applyManualDeploymentWithOutput(services.api, services.appendOutput, {
      token: request.previewToken,
      confirmReplaceExisting: request.confirmReplaceExisting,
      enableMod: request.enable ?? services.enablePreference(),
    });
    const status = result.modStatus;
    const listChanged = status?.enable === 'enabled' || status?.enable === 'added';
    return {
      outcome: 'deployed',
      modName: result.modName,
      profileId: result.profileId,
      files: result.deployedFiles.length,
      enabled:
        status?.enable === 'enabled' ||
        status?.enable === 'already-enabled' ||
        status?.enable === 'added',
      enableFailed: status?.enable === 'failed',
      gameRunning: listChanged && status?.gameRunning === true,
    };
  } catch (error) {
    if (desktopErrorFacts(errorMessage(error))?.code === 'deploy.stale-preview') {
      return { outcome: 'stale' };
    }
    const words =
      outputMessageText(presentDeploymentFailure(errorMessage(error))).trim() ||
      'The deployment failed.';
    return { outcome: 'deploy-failed', message: words.slice(0, appGameLimits.message) };
  }
}

export async function answerAppGameRequest(
  request: Pick<ConnectorRendererRequest, 'kind' | 'payload'>,
  host: AppGameHost | null,
  workspace: AppRunWorkspace,
  services: AppDeployServices,
): Promise<AppDeployReply | AppLiveTestReply> {
  if (request.kind === 'deploy') {
    const deploy = validateAppDeployRequest(request.payload);
    if (deploy.phase === 'apply') return applyAppDeployment(services, deploy);
    if (!host) return { outcome: 'not-ready', missing: 'run-menu' };
    const document = await resolveAppRunDocument(workspace, deploy.path, 'generate');
    return prepareAppDeployment(services, host, deploy, document);
  }
  const live = validateAppLiveTestRequest(request.payload);
  if (!host) return { outcome: 'not-ready', missing: 'run-menu' };
  const document = await resolveAppRunDocument(workspace, live.path, 'generate');
  return host.liveTest(live, document);
}

export function useAppGameBridge(
  host: { readonly current: AppGameHost | null },
  workspace: { readonly current: AppRunWorkspace },
  appendOutput: { readonly current: (message: OutputMessage) => void },
): void {
  useEffect(() => {
    const services: AppDeployServices = {
      api: window.rmside,
      appendOutput: (message) => appendOutput.current(message),
      enablePreference: () => readEnableModPreference(window.localStorage),
    };
    const answer = (request: ConnectorRendererRequest) => {
      if (request.kind !== 'deploy' && request.kind !== 'liveTest') return;
      void (async () => {
        try {
          const payload = await answerAppGameRequest(
            request,
            host.current,
            workspace.current,
            services,
          );
          await window.rmside.replyToConnectorRequest({
            requestId: request.requestId,
            ok: true,
            payload,
          });
        } catch (error) {
          await window.rmside
            .replyToConnectorRequest({
              requestId: request.requestId,
              ok: false,
              error:
                error instanceof AppRunRefusal
                  ? { code: error.code, message: error.message }
                  : { code: 'internal', message: 'AoE2RMSIDE could not do this.' },
            })
            .catch(() => undefined);
        }
      })();
    };
    return window.rmside.onConnectorRequest(answer);
  }, [appendOutput, host, workspace]);
}
