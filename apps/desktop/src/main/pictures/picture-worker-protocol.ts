import type { PictureResult } from './picture-contract';
import { PictureError, type PictureErrorCode } from './picture-error';
import { renderPicture } from './picture-render';

export interface PictureWorkerRequest {
  id: number;
  request: unknown;
}

export type PictureWorkerResponse =
  | { id: number; ok: true; result: PictureResult }
  | { id: number; ok: false; code: PictureErrorCode; message: string };

export function handlePictureWorkerMessage(message: unknown): PictureWorkerResponse {
  const id =
    typeof message === 'object' &&
    message !== null &&
    Number.isSafeInteger((message as { id?: unknown }).id)
      ? (message as PictureWorkerRequest).id
      : -1;
  try {
    if (id < 0) throw new PictureError('invalid-request', 'the worker message has no id');
    return { id, ok: true, result: renderPicture((message as PictureWorkerRequest).request) };
  } catch (error) {
    if (error instanceof PictureError) {
      return { id, ok: false, code: error.code, message: error.message };
    }
    return {
      id,
      ok: false,
      code: 'worker-failed',
      message: error instanceof Error ? error.message : 'the picture could not be drawn',
    };
  }
}
