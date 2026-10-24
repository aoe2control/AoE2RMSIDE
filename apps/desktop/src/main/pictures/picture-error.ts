export type PictureErrorCode =
  | 'unsupported-version'
  | 'invalid-request'
  | 'invalid-map'
  | 'too-large'
  | 'cancelled'
  | 'timeout'
  | 'busy'
  | 'worker-failed';

export class PictureError extends Error {
  constructor(
    readonly code: PictureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PictureError';
  }
}
