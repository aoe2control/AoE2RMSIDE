import { useCallback, useEffect } from 'react';

export type FocusInteraction = 'navigation' | 'other';

export class FocusInteractionTracker {
  private last: FocusInteraction = 'other';

  record(event: Pick<KeyboardEvent, 'type' | 'key'>): void {
    if (event.type === 'keydown') {
      if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt') return;
      if (event.key === 'Meta') return;
      this.last = event.key === 'Tab' ? 'navigation' : 'other';
      return;
    }
    if (event.type === 'pointerdown' || event.type === 'mousedown') this.last = 'other';
  }

  get focusFromNavigation(): boolean {
    return this.last === 'navigation';
  }
}

const tracker = new FocusInteractionTracker();
let installed = 0;
const recordInteraction = (event: Event) => tracker.record(event as KeyboardEvent);

export function useKeyboardNavigationFocus(): {
  onBlur(event: { currentTarget: HTMLElement }): void;
  onFocus(event: { currentTarget: HTMLElement }): void;
} {
  useEffect(() => {
    if (installed === 0) {
      document.addEventListener('keydown', recordInteraction, true);
      document.addEventListener('pointerdown', recordInteraction, true);
    }
    installed += 1;
    return () => {
      installed -= 1;
      if (installed === 0) {
        document.removeEventListener('keydown', recordInteraction, true);
        document.removeEventListener('pointerdown', recordInteraction, true);
      }
    };
  }, []);
  const onFocus = useCallback((event: { currentTarget: HTMLElement }) => {
    if (tracker.focusFromNavigation) event.currentTarget.dataset.keyboardFocus = 'true';
    else delete event.currentTarget.dataset.keyboardFocus;
  }, []);
  const onBlur = useCallback((event: { currentTarget: HTMLElement }) => {
    delete event.currentTarget.dataset.keyboardFocus;
  }, []);
  return { onBlur, onFocus };
}
