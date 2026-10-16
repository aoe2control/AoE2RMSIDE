import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/components/ui/menubar';
import type {
  ApplicationMenuEntry,
  ApplicationMenuModel,
  ApplicationMenuName,
} from '../shared/api';
import {
  applicationMenuForAccessKey,
  applicationMenuRows,
  applicationMenus,
} from './application-menu-entries';
import { useI18n } from './i18n';
import { isModalSurfaceOpen } from './modal-surfaces';

export function ApplicationMenuBar() {
  const { t } = useI18n();
  const [model, setModel] = useState<ApplicationMenuModel | null>(null);
  const [openMenu, setOpenMenu] = useState<ApplicationMenuName | null>(null);
  const openMenuRef = useRef<ApplicationMenuName | null>(null);
  const triggers = useRef(new Map<ApplicationMenuName, HTMLElement>());
  const focusBefore = useRef<HTMLElement | null>(null);
  const lastInput = useRef<'keyboard' | 'pointer'>('pointer');
  const entry = useRef<'keyboard' | 'pointer'>('pointer');
  const closeReason = useRef<string | undefined>(undefined);
  const focusOnOpen = useRef<'first-item' | 'popup' | null>(null);
  const movingAlongBar = useRef(false);

  useLayoutEffect(() => {
    openMenuRef.current = openMenu;
  }, [openMenu]);

  const refreshModel = useCallback(() => {
    void window.rmside
      .getApplicationMenuModel()
      .then(setModel)
      .catch((error: unknown) => console.error(error));
  }, []);

  useEffect(() => {
    refreshModel();
    return window.rmside.onApplicationMenuModelChange(setModel);
  }, [refreshModel]);

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === document.body) return;
      if (
        target.closest('.application-menu, .application-menu-popup, [data-base-ui-focus-guard]')
      ) {
        return;
      }
      focusBefore.current = target;
    };
    document.addEventListener('focusin', remember, true);
    return () => document.removeEventListener('focusin', remember, true);
  }, []);

  const restoreFocus = useCallback(() => {
    const target = focusBefore.current;
    if (target?.isConnected) {
      target.focus({ focusVisible: false, preventScroll: true });
      return;
    }
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.closest('.application-menu, .application-menu-popup')
    ) {
      active.blur();
    }
  }, []);

  const closeMenus = useCallback(() => {
    closeReason.current = 'imperative-action';
    setOpenMenu(null);
  }, []);

  const focusTrigger = useCallback((name: ApplicationMenuName) => {
    lastInput.current = 'keyboard';
    triggers.current.get(name)?.focus({ preventScroll: true });
  }, []);

  const openFromKeyboard = useCallback(
    (name: ApplicationMenuName) => {
      if (openMenuRef.current === null) entry.current = 'keyboard';
      focusOnOpen.current = 'first-item';
      focusTrigger(name);
      setOpenMenu(name);
      refreshModel();
    },
    [focusTrigger, refreshModel],
  );

  const toggleMenuBar = useCallback(() => {
    const active = document.activeElement;
    if (
      openMenuRef.current !== null ||
      (active instanceof HTMLElement && active.closest('.application-menu'))
    ) {
      closeMenus();
      restoreFocus();
      return;
    }
    entry.current = 'keyboard';
    focusTrigger(applicationMenus[0]!.name);
  }, [closeMenus, focusTrigger, restoreFocus]);

  useEffect(() => {
    let altAlone = false;
    const onKeyDown = (event: KeyboardEvent) => {
      lastInput.current = 'keyboard';
      if (event.key === 'Alt') {
        if (!event.repeat) altAlone = !event.ctrlKey && !event.shiftKey && !event.metaKey;
        return;
      }
      altAlone = false;
      if (isModalSurfaceOpen()) return;
      const modifiers = event.ctrlKey || event.shiftKey || event.metaKey;
      if (event.key === 'F10' && !modifiers && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        toggleMenuBar();
        return;
      }
      if (event.altKey && !modifiers) {
        const name = applicationMenuForAccessKey(event);
        if (!name) return;
        event.preventDefault();
        event.stopPropagation();
        openFromKeyboard(name);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return;
      const alone = altAlone;
      altAlone = false;
      if (!alone || isModalSurfaceOpen()) return;
      event.preventDefault();
      toggleMenuBar();
    };
    let pointer = { x: Number.NaN, y: Number.NaN };
    const onPointerMove = (event: PointerEvent) => {
      if (event.screenX === pointer.x && event.screenY === pointer.y) return;
      pointer = { x: event.screenX, y: event.screenY };
      lastInput.current = 'pointer';
    };
    const onPointer = (event: PointerEvent) => {
      altAlone = false;
      movingAlongBar.current = false;
      pointer = { x: event.screenX, y: event.screenY };
      lastInput.current = 'pointer';
    };
    const onWheel = () => {
      altAlone = false;
    };
    const onBlur = () => {
      altAlone = false;
      if (openMenuRef.current !== null && !document.hasFocus()) closeMenus();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('blur', onBlur);
    };
  }, [closeMenus, openFromKeyboard, toggleMenuBar]);

  useEffect(() => {
    const focus = focusOnOpen.current;
    if (openMenu === null || focus === null) return undefined;
    focusOnOpen.current = null;
    let frame = 0;
    let attempts = 0;
    const move = () => {
      const popups = [...document.querySelectorAll<HTMLElement>('[data-application-menu-popup]')];
      const popup = popups.find((element) => element.dataset.applicationMenuPopup === openMenu);
      const target =
        focus === 'first-item'
          ? popup?.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')
          : popup;
      const leaving = popups.length > 1;
      if (target && !leaving) target.focus({ preventScroll: true });
      else if (++attempts < 60) frame = requestAnimationFrame(move);
      else target?.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(move);
    return () => cancelAnimationFrame(frame);
  }, [openMenu]);

  const onOpenChange = useCallback(
    (name: ApplicationMenuName, open: boolean, reason: string | undefined) => {
      if (open) {
        const previous = openMenuRef.current;
        const moving = (previous !== null && previous !== name) || movingAlongBar.current;
        movingAlongBar.current = false;
        if (previous === null && !moving) entry.current = lastInput.current;
        if (moving && focusOnOpen.current === null) {
          focusOnOpen.current = lastInput.current === 'keyboard' ? 'first-item' : 'popup';
        }
        setOpenMenu(name);
        refreshModel();
        return;
      }
      closeReason.current = reason;
      movingAlongBar.current = reason === 'list-navigation';
      setOpenMenu((current) => (current === name ? null : current));
    },
    [refreshModel],
  );

  const finalFocus = useCallback((): boolean | HTMLElement => {
    const reason = closeReason.current;
    if (
      openMenuRef.current !== null ||
      reason === 'sibling-open' ||
      reason === 'list-navigation' ||
      reason === 'trigger-hover' ||
      reason === 'trigger-focus' ||
      reason === 'focus-out'
    ) {
      return false;
    }
    if (reason === 'escape-key' && entry.current === 'keyboard') return true;
    const target = focusBefore.current;
    return target?.isConnected ? target : false;
  }, []);

  const activate = useCallback(
    (key: string) => {
      closeReason.current = 'item-press';
      window.setTimeout(() => {
        restoreFocus();
        void window.rmside
          .activateApplicationMenuItem(key)
          .catch((error: unknown) => console.error(error));
      }, 0);
    },
    [restoreFocus],
  );

  const onMenuBarKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (openMenuRef.current !== null) return;
      if (!(event.target instanceof Element) || !event.target.closest('[data-application-menu]')) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        restoreFocus();
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const name = applicationMenuForAccessKey(event);
      if (name) {
        event.preventDefault();
        openFromKeyboard(name);
      }
    },
    [openFromKeyboard, restoreFocus],
  );

  const labels = new Map(model?.menus.map((menu) => [menu.name, menu]));

  return (
    <Menubar
      aria-label={t('workbench.application-menu.label')}
      className="application-menu"
      data-menu-open={openMenu !== null}
      onKeyDown={onMenuBarKeyDown}
    >
      {applicationMenus.map((menu) => {
        const content = labels.get(menu.name);
        return (
          <MenubarMenu
            key={menu.name}
            onOpenChange={(open, details) => onOpenChange(menu.name, open, details.reason)}
            open={openMenu === menu.name}
          >
            <MenubarTrigger
              data-application-menu={menu.name}
              onBlur={(event) => delete event.currentTarget.dataset.keyboardFocus}
              onFocus={(event) => {
                if (lastInput.current === 'keyboard')
                  event.currentTarget.dataset.keyboardFocus = 'true';
                else delete event.currentTarget.dataset.keyboardFocus;
              }}
              onMouseDown={(event) => event.preventDefault()}
              ref={(element: HTMLElement | null) => {
                if (element) triggers.current.set(menu.name, element);
                else triggers.current.delete(menu.name);
              }}
              render={<Button className="application-menu-trigger" size="sm" variant="ghost" />}
            >
              {content?.label ?? t(menu.label)}
            </MenubarTrigger>
            <MenubarContent
              className="application-menu-popup owned-scrollbars"
              data-application-menu-popup={menu.name}
              finalFocus={finalFocus}
            >
              <ApplicationMenuRows activate={activate} entries={content?.entries ?? []} />
            </MenubarContent>
          </MenubarMenu>
        );
      })}
    </Menubar>
  );
}

function itemContent(entry: { label: string; accelerator: string | null }): ReactNode {
  return (
    <>
      <span className="application-menu-label">{entry.label}</span>
      {entry.accelerator ? <MenubarShortcut>{entry.accelerator}</MenubarShortcut> : null}
    </>
  );
}

function ApplicationMenuRows({
  activate,
  entries,
}: {
  activate(key: string): void;
  entries: readonly ApplicationMenuEntry[];
}) {
  return applicationMenuRows(entries).map((row) => {
    if (row.kind === 'separator') return <MenubarSeparator key={row.key} />;
    if (row.kind === 'submenu') {
      return (
        <MenubarSub key={row.entry.key}>
          <MenubarSubTrigger disabled={!row.entry.enabled} label={row.entry.label}>
            <span className="application-menu-label">{row.entry.label}</span>
          </MenubarSubTrigger>
          <MenubarSubContent className="application-menu-popup owned-scrollbars">
            <ApplicationMenuRows activate={activate} entries={row.entry.entries} />
          </MenubarSubContent>
        </MenubarSub>
      );
    }
    if (row.kind === 'radio-group') {
      return (
        <MenubarRadioGroup key={row.key} value={row.value}>
          {row.entries.map((item) => (
            <MenubarRadioItem
              closeOnClick
              disabled={!item.enabled}
              key={item.key}
              label={item.label}
              onClick={() => activate(item.key)}
              value={item.key}
            >
              {itemContent(item)}
            </MenubarRadioItem>
          ))}
        </MenubarRadioGroup>
      );
    }
    const item = row.entry;
    if (item.check === 'checkbox') {
      return (
        <MenubarCheckboxItem
          checked={item.checked}
          closeOnClick
          disabled={!item.enabled}
          key={item.key}
          label={item.label}
          onClick={() => activate(item.key)}
        >
          {itemContent(item)}
        </MenubarCheckboxItem>
      );
    }
    return (
      <MenubarItem
        disabled={!item.enabled}
        key={item.key}
        label={item.label}
        onClick={() => activate(item.key)}
      >
        {itemContent(item)}
      </MenubarItem>
    );
  });
}
