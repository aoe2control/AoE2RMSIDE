import { parentPort } from 'node:worker_threads';
import { handlePictureWorkerMessage } from './picture-worker-protocol';

parentPort?.on('message', (message: unknown) => {
  const response = handlePictureWorkerMessage(message);
  if (response.ok) {
    const buffer = response.result.png.buffer;
    parentPort!.postMessage(response, buffer instanceof ArrayBuffer ? [buffer] : []);
  } else {
    parentPort!.postMessage(response);
  }
});
