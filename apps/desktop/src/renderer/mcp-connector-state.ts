import { useEffect, useState } from 'react';
import type { ConnectorState } from '../shared/connector-api';

export function useConnectorState(
  enabled: boolean,
): [ConnectorState | null, (state: ConnectorState) => void] {
  const [state, setState] = useState<ConnectorState | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    const unsubscribe = window.rmside.onConnectorState((next) => setState(next));
    void window.rmside.getConnectorState().then(
      (next) => {
        if (current) setState((shown) => shown ?? next);
      },
      () => undefined,
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [enabled]);
  return [state, setState];
}
