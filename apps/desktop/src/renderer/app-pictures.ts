import { useEffect } from 'react';
import type { ConnectorErrorCode, ConnectorRendererRequest } from '../shared/connector-api';
import {
  validateAppPictureInputRequest,
  validateAppPictureView,
  type AppPictureInputReply,
  type AppPictureInputRequest,
  type AppPictureView,
} from '../shared/connector-picture-api';
import {
  AppRunRefusal,
  resolveAppRunDocument,
  type AppRunDocument,
  type AppRunWorkspace,
} from './app-runs';

export interface AppPictureInputHost {
  input(request: AppPictureInputRequest, document: AppRunDocument): AppPictureInputReply;
}

function refusal(error: unknown, fallback: string): { code: ConnectorErrorCode; message: string } {
  if (error instanceof AppRunRefusal) return { code: error.code, message: error.message };
  return { code: 'internal', message: fallback };
}

async function reply(
  request: ConnectorRendererRequest,
  answer: () => Promise<unknown>,
  fallback: string,
): Promise<void> {
  try {
    const payload = await answer();
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
        error: refusal(error, fallback),
      })
      .catch(() => undefined);
  }
}

export async function answerAppPictureInput(
  payload: unknown,
  host: AppPictureInputHost | null,
  workspace: AppRunWorkspace,
): Promise<AppPictureInputReply> {
  const request = validateAppPictureInputRequest(payload);
  const document = await resolveAppRunDocument(workspace, request.path, 'generate');
  if (!host) throw new AppRunRefusal('internal', 'The Run menu is not ready.');
  if (!document.content) throw new AppRunRefusal('invalid_arguments', 'The script is empty.');
  return host.input(request, document);
}

export function useAppPictureInputBridge(
  host: { readonly current: AppPictureInputHost | null },
  workspace: { readonly current: AppRunWorkspace },
): void {
  useEffect(
    () =>
      window.rmside.onConnectorRequest((request) => {
        if (request.kind !== 'pictureInput') return;
        void reply(
          request,
          () => answerAppPictureInput(request.payload, host.current, workspace.current),
          'The contact sheet could not start in AoE2RMSIDE.',
        );
      }),
    [host, workspace],
  );
}

export function useAppPictureViewBridge(view: { readonly current: () => AppPictureView }): void {
  useEffect(
    () =>
      window.rmside.onConnectorRequest((request) => {
        if (request.kind !== 'pictureView') return;
        void reply(
          request,
          async () => validateAppPictureView(view.current()),
          'The preview could not answer.',
        );
      }),
    [view],
  );
}
