import { desktopErrorMessage } from '../shared/desktop-error';

export class RequiredSourceLimitError extends Error {
  readonly scope: string;

  constructor(
    readonly kind: 'file' | 'bytes' | 'records' | 'metadata',
    scope: string,
    readonly used: number,
    readonly maximum: number,
  ) {
    const boundedScope = scope.slice(0, 512);
    super(
      desktopErrorMessage(
        `source-catalog.required.${kind}`,
        `Required source preparation exceeded its ${kind} limit for ${boundedScope} (${used}/${maximum}). Reduce the required source data, then run again.`,
        { scope: boundedScope, used, maximum },
      ),
    );
    this.name = 'RequiredSourceLimitError';
    this.scope = boundedScope;
  }
}
