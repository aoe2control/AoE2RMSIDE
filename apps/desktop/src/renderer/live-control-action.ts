import type { LiveControlConnectionState } from './preview-execution';

export type LiveControlActionKind = 'detach' | 'remove';
export type LiveControlActionWait = 'connecting' | 'detaching' | 'busy';

export type LiveControlAction =
  | { kind: LiveControlActionKind; available: true }
  | { kind: LiveControlActionKind; available: false; wait: LiveControlActionWait };

export interface LiveControlActionInput {
  connectionState: LiveControlConnectionState;
  detaching: boolean;
  operationBusy: boolean;
}

export function liveControlAction({
  connectionState,
  detaching,
  operationBusy,
}: LiveControlActionInput): LiveControlAction {
  if (detaching) return { kind: 'detach', available: false, wait: 'detaching' };
  switch (connectionState) {
    case 'connecting':
    case 'recovering':
      return { kind: 'detach', available: false, wait: 'connecting' };
    case 'attached':
      return operationBusy
        ? { kind: 'detach', available: false, wait: 'busy' }
        : { kind: 'detach', available: true };
    case 'disconnected':
    case 'error':
      return operationBusy
        ? { kind: 'remove', available: false, wait: 'busy' }
        : { kind: 'remove', available: true };
  }
}
