import { useLayoutEffect } from 'react';

export interface ModalSurfaceRegistry {
  isOpen(): boolean;
  hold(): () => void;
}

export function createModalSurfaceRegistry(report: (open: boolean) => void): ModalSurfaceRegistry {
  let held = 0;
  return {
    isOpen: () => held > 0,
    hold() {
      held += 1;
      if (held === 1) report(true);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held -= 1;
        if (held === 0) report(false);
      };
    },
  };
}

const registry = createModalSurfaceRegistry((open) => {
  void window.rmside.syncModalSurfaceOpen(open).catch(() => undefined);
});

export const isModalSurfaceOpen = registry.isOpen;

export function useModalSurface(open: boolean): void {
  useLayoutEffect(() => (open ? registry.hold() : undefined), [open]);
}
