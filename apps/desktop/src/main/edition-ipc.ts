export interface IpcRegistrar {
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void;
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
}

export class EditionFeatureUnavailableError extends Error {
  constructor(readonly channel: string) {
    super('this feature is not part of this edition');
    this.name = 'EditionFeatureUnavailableError';
  }
}

export function editionIpcRegistrar<T extends IpcRegistrar>(
  ipc: T,
  refusedChannels: ReadonlySet<string>,
): Pick<T, 'handle' | 'on'> {
  const handle: IpcRegistrar['handle'] = (channel, listener) =>
    ipc.handle(
      channel,
      refusedChannels.has(channel)
        ? () => {
            throw new EditionFeatureUnavailableError(channel);
          }
        : listener,
    );
  const on: IpcRegistrar['on'] = (channel, listener) =>
    ipc.on(channel, refusedChannels.has(channel) ? () => undefined : listener);
  return { handle, on } as Pick<T, 'handle' | 'on'>;
}
