import {
  matchesShortcut,
  menuShortcutItems,
  type ShortcutKeyEvent,
} from '../shared/application-shortcuts';

const quietFocus = new WeakSet<Element>();

const ownFocusIndication =
  "[role='application'], [role='menu'], [role='menubar'], [role='listbox'], [contenteditable='true']";

const dialogSurfaces = "[role='dialog'], [role='alertdialog']";

export function holdsQuietFocus(element: Element | null | undefined): boolean {
  return element ? quietFocus.has(element) : false;
}

export function isQuietFocusKey(event: ShortcutKeyEvent): boolean {
  if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt') return true;
  if (event.key === 'Meta' || event.key === 'AltGraph') return true;
  if (/^F(?:[1-9]|1\d|2[0-4])$/u.test(event.key)) return true;
  return menuShortcutItems.some(({ accelerator }) => matchesShortcut(event, accelerator));
}

export function isDialogFocusNavigationKey(
  event: Pick<KeyboardEvent, 'key'>,
  focused: { matches(selector: string): boolean },
): boolean {
  if (event.key === 'Tab') return true;
  if (!/^Arrow(?:Up|Down|Left|Right)$/u.test(event.key)) return false;
  return !focused.matches("button:not([aria-haspopup]), a[href], [role='button']");
}

export function installQuietFocus(target: Window = window): () => void {
  const document = target.document;
  const recordFocus = (event: FocusEvent) => {
    const element = event.target;
    if (!(element instanceof Element)) return;
    if (element.matches(':focus-visible')) quietFocus.delete(element);
    else quietFocus.add(element);
  };
  const keepFocusQuiet = (event: KeyboardEvent) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return;
    if (!quietFocus.has(active) || active.closest(ownFocusIndication)) return;
    const inDialog = active.closest(dialogSurfaces) !== null;
    const quietKey = inDialog ? !isDialogFocusNavigationKey(event, active) : isQuietFocusKey(event);
    if (!quietKey) return;
    if (!active.matches(':focus-visible')) return;
    active.blur();
    active.focus({ focusVisible: false, preventScroll: true });
  };
  document.addEventListener('focusin', recordFocus, true);
  target.addEventListener('keydown', keepFocusQuiet, true);
  return () => {
    document.removeEventListener('focusin', recordFocus, true);
    target.removeEventListener('keydown', keepFocusQuiet, true);
  };
}
