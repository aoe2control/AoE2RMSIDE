import { computeMorphField, morphFieldTexels, type MorphPicture } from './preview-morph-field';

export interface MorphFieldRequest {
  id: number;
  previous: MorphPicture;
  next: MorphPicture;
}

export interface MorphFieldReply {
  id: number;
  size: number;
  texels: Uint8Array;
  maximum: number;
  movedBlocks: number;
  milliseconds: number;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<MorphFieldRequest>) => void) | null;
  postMessage(message: MorphFieldReply, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  const started = performance.now();
  const { id, previous, next } = event.data;
  const field = computeMorphField(previous, next);
  const texels = morphFieldTexels(field);
  scope.postMessage(
    {
      id,
      size: field.size,
      texels,
      maximum: field.maximum,
      movedBlocks: field.movedBlocks,
      milliseconds: performance.now() - started,
    },
    [texels.buffer],
  );
};
