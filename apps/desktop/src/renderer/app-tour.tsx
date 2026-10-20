import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import {
  advanceTour,
  normalizeTourProgress,
  restartTour,
  skipTour,
  tourCardDecision,
  tourCardPlacement,
  tourCardsFor,
  tourSpotlightRect,
  tourStep,
  tourTextParts,
  tourUncoveredRect,
  type TourCardId,
  type TourCardSide,
  type TourMoment,
  type TourProgress,
  type TourRect,
  type TourTargetState,
} from '../shared/app-tour';
import { editionCapabilities } from '../shared/edition';
import { useI18n } from './i18n';
import { useModalSurface } from './modal-surfaces';
import { presenceProps, useHeld, usePresence } from './motion';

const tourOffscreen = 10_000;

const tourPollMilliseconds = 250;

const tourTargetSelectors: Record<TourCardId, string> = {
  explorer: '.workspace-sidebar',
  editor: '.editor-panel',
  run: '.preview-run-controls',
  preview: '.preview-panel',
  output: '.bottom-panel',
};

const openSurfaceSelectors = [
  "[role='dialog']:not([data-app-tour-card])",
  "[role='alertdialog']",
  "[role='menu']",
  "[role='listbox']",
  '.monaco-editor .suggest-widget.visible',
  '.monaco-editor .parameter-hints-widget.visible',
  '.monaco-hover:not(.hidden)',
].join(', ');

function shownElement(element: Element): boolean {
  if (element.closest('[data-ending-style], [hidden]')) return false;
  if (element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

export function tourSurfaceOpen(root: ParentNode = document): boolean {
  if (
    document.body.classList.contains('resizing-horizontal') ||
    document.body.classList.contains('resizing-bottom-panel')
  ) {
    return true;
  }
  for (const element of root.querySelectorAll(openSurfaceSelectors)) {
    if (shownElement(element)) return true;
  }
  return false;
}

const tourControlSelectors = [
  '.preview-run-controls',
  '.preview-preset-control-host',
  '.preview-map-toolbar',
  '.preview-map-information',
  '.preview-profiler-host',
].join(', ');

function targetElement(card: TourCardId): HTMLElement | null {
  return document.querySelector<HTMLElement>(tourTargetSelectors[card]);
}

function shownRect(element: Element): TourRect | null {
  const rect = element.getBoundingClientRect();
  const width = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
  if (width < 4 || height < 4) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function targetRect(card: TourCardId): TourRect | null {
  const element = targetElement(card);
  if (!element || !element.isConnected) return null;
  return shownRect(element);
}

function coveringRect(card: TourCardId): TourRect | null {
  if (card !== 'preview') return null;
  const workspace = document.querySelector<HTMLElement>('.fixed-workspace');
  if (workspace?.dataset.editorShown !== 'true') return null;
  const region = workspace.querySelector<HTMLElement>('.workspace-preview-region');
  if (region?.dataset.layout !== 'behind-editor') return null;
  const editor = workspace.querySelector<HTMLElement>('.editor-panel');
  return editor ? shownRect(editor) : null;
}

function spotlightRect(card: TourCardId): TourRect | null {
  const rect = targetRect(card);
  if (rect === null) return null;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const spotlight = tourUncoveredRect(tourSpotlightRect(rect, viewport), coveringRect(card));
  return spotlight.width < 4 || spotlight.height < 4 ? null : spotlight;
}

function controlRects(): TourRect[] {
  const rects: TourRect[] = [];
  for (const element of document.querySelectorAll(tourControlSelectors)) {
    if (!shownElement(element)) continue;
    const rect = shownRect(element);
    if (rect) rects.push(rect);
  }
  return rects;
}

function sameRect(a: TourRect | null, b: TourRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

const motionFrom: Record<TourCardSide, 'left' | 'right' | 'top' | 'bottom'> = {
  right: 'left',
  left: 'right',
  bottom: 'top',
  top: 'bottom',
  over: 'bottom',
};

export interface AppTourProps {
  ready: boolean;
  restartRequest: number;
  targets: Record<TourCardId, TourTargetState>;
  runActive: boolean;
  previewReady: boolean;
  onEditorCard(): void;
}

export function AppTour({
  ready,
  restartRequest,
  targets,
  runActive,
  previewReady,
  onEditorCard,
}: AppTourProps) {
  const cards = tourCardsFor(editionCapabilities);
  const [progress, setProgress] = useState<TourProgress | null>(null);
  const [shownCard, setShownCard] = useState<TourCardId | null>(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const moment = useRef({ targets, runActive, previewReady, onEditorCard });
  moment.current = { targets, runActive, previewReady, onEditorCard };
  const lastActivity = useRef(performance.now());
  const pointerHeld = useRef(false);
  const showAtOnce = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  const saveProgress = useCallback((next: TourProgress) => {
    progressRef.current = next;
    setProgress(next);
    void window.rmside.saveTourProgress(next).catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    void window.rmside
      .getTourProgress()
      .catch((): TourProgress => ({ status: 'done' }))
      .then((stored) => {
        if (!active) return;
        const normalized = normalizeTourProgress(stored, cards);
        if (normalized !== stored) saveProgress(normalized);
        else {
          progressRef.current = stored;
          setProgress(stored);
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveProgress]);

  useEffect(() => {
    const active = () => {
      lastActivity.current = performance.now();
    };
    const press = () => {
      pointerHeld.current = true;
      active();
    };
    const release = () => {
      pointerHeld.current = false;
      active();
    };
    window.addEventListener('keydown', active, true);
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('wheel', active, { capture: true, passive: true });
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('blur', release);
      window.removeEventListener('keydown', active, true);
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('wheel', active, { capture: true });
    };
  }, []);

  const handledRestart = useRef(restartRequest);
  useEffect(() => {
    if (restartRequest === handledRestart.current) return;
    handledRestart.current = restartRequest;
    setShownCard(null);
    showAtOnce.current = true;
    saveProgress(restartTour(cards));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartRequest, saveProgress]);

  const currentCard = progress?.status === 'active' ? progress.card : null;

  useEffect(() => {
    if (!ready || currentCard === null || shownCard !== null) return undefined;
    const look = () => {
      const card = currentCard;
      const latest = moment.current;
      const layoutTarget = latest.targets[card];
      const measured: TourTargetState =
        layoutTarget === 'shown' && spotlightRect(card) === null ? 'hidden' : layoutTarget;
      const surfaceOpen = pointerHeld.current || tourSurfaceOpen();
      const now: TourMoment = {
        idleMilliseconds: showAtOnce.current
          ? Number.POSITIVE_INFINITY
          : performance.now() - lastActivity.current,
        surfaceOpen,
        runActive: latest.runActive,
        target: measured,
        previewReady: latest.previewReady,
      };
      const decision = tourCardDecision(card, now);
      if (decision === 'skip') {
        const current = progressRef.current;
        if (current) saveProgress(advanceTour(current, cards));
        return;
      }
      if (decision !== 'show') return;
      showAtOnce.current = false;
      if (card === 'editor') latest.onEditorCard();
      const focused = document.activeElement;
      returnFocus.current =
        focused instanceof HTMLElement && focused !== document.body ? focused : null;
      setShownCard(card);
    };
    look();
    const timer = window.setInterval(look, tourPollMilliseconds);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCard, ready, saveProgress, shownCard]);

  const restoreFocus = useCallback(() => {
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus({ focusVisible: false, preventScroll: true });
  }, []);

  const gotIt = useCallback(() => {
    const current = progressRef.current;
    if (!current) return;
    setShownCard(null);
    lastActivity.current = performance.now();
    saveProgress(advanceTour(current, cards));
    restoreFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreFocus, saveProgress]);

  const skip = useCallback(() => {
    setShownCard(null);
    saveProgress(skipTour());
    restoreFocus();
  }, [restoreFocus, saveProgress]);

  const retract = useCallback(() => {
    setShownCard(null);
    restoreFocus();
  }, [restoreFocus]);

  if (progress === null) return null;
  return (
    <TourCard card={shownCard} cards={cards} onGotIt={gotIt} onRetract={retract} onSkip={skip} />
  );
}

interface TourCardProps {
  card: TourCardId | null;
  cards: readonly TourCardId[];
  onGotIt(): void;
  onSkip(): void;
  onRetract(): void;
}

interface TourGeometry {
  spotlight: TourRect;
  left: number;
  top: number;
  side: TourCardSide;
  maxHeight?: number;
}

function cardFullSize(element: HTMLElement): { width: number; height: number } {
  const body = element.querySelector<HTMLElement>('.tour-card-body');
  const hidden = body ? body.scrollHeight - body.clientHeight : 0;
  return {
    width: element.offsetWidth,
    height: Math.min(element.offsetHeight + Math.max(0, hidden), window.innerHeight - 24),
  };
}

function TourCard({ card: shownCard, cards, onGotIt, onSkip, onRetract }: TourCardProps) {
  const { t } = useI18n();
  const presence = usePresence(shownCard !== null);
  const card = useHeld(shownCard, presence.closing);
  const titleId = useId();
  const bodyId = useId();
  const cardElement = useRef<HTMLDivElement | null>(null);
  const gotItButton = useRef<HTMLButtonElement | null>(null);
  const skipButton = useRef<HTMLButtonElement | null>(null);
  const [geometry, setGeometry] = useState<TourGeometry | null>(null);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const open = shownCard !== null;
  useModalSurface(open);

  const presenceRef = presence.ref;
  const bindCard = useCallback(
    (element: HTMLDivElement | null) => {
      cardElement.current = element;
      presenceRef(element);
    },
    [presenceRef],
  );

  const measure = useCallback((): boolean => {
    if (shownCard === null) return true;
    const spotlight = spotlightRect(shownCard);
    const element = cardElement.current;
    if (spotlight === null) return false;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const size = element ? cardFullSize(element) : { width: 0, height: 0 };
    const placement = tourCardPlacement(spotlight, size, viewport, controlRects());
    const previous = geometryRef.current;
    if (
      previous === null ||
      !sameRect(previous.spotlight, spotlight) ||
      previous.left !== placement.left ||
      previous.top !== placement.top ||
      previous.side !== placement.side ||
      previous.maxHeight !== placement.maxHeight
    ) {
      const next: TourGeometry = { spotlight, ...placement };
      geometryRef.current = next;
      setGeometry(next);
    }
    return true;
  }, [shownCard]);

  useLayoutEffect(() => {
    if (shownCard === null) return undefined;
    geometryRef.current = null;
    measure();
    let frame = 0;
    const follow = () => {
      if (!measure()) {
        onRetract();
        return;
      }
      if (tourSurfaceOpen()) {
        onRetract();
        return;
      }
      frame = window.requestAnimationFrame(follow);
    };
    frame = window.requestAnimationFrame(follow);
    return () => window.cancelAnimationFrame(frame);
  }, [measure, onRetract, shownCard]);

  const placed = geometry !== null;
  const focusedFor = useRef<TourCardId | null>(null);
  useEffect(() => {
    if (shownCard === null) {
      focusedFor.current = null;
      return;
    }
    if (!placed || focusedFor.current === shownCard) return;
    focusedFor.current = shownCard;
    gotItButton.current?.focus({ focusVisible: false, preventScroll: true });
  }, [placed, shownCard]);

  useEffect(() => {
    if (shownCard === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const element = cardElement.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onGotIt();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const next =
          document.activeElement === gotItButton.current ? skipButton.current : gotItButton.current;
        next?.focus({ preventScroll: true });
        return;
      }
      if (!element || !(event.target instanceof Node) || !element.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        gotItButton.current?.focus({ focusVisible: false, preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onGotIt, shownCard]);

  if (!presence.mounted || card === null) return null;
  const { step, total } = tourStep(card, cards);
  const text = tourCardText(card);
  const swallow = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const spotlight = geometry?.spotlight;
  return createPortal(
    <div className="tour-layer" data-card={card} data-testid="app-tour">
      <div
        aria-hidden="true"
        className="tour-blocker"
        data-testid="app-tour-blocker"
        onClick={swallow}
        onContextMenu={swallow}
        onDoubleClick={swallow}
        onMouseDown={swallow}
        onPointerDown={swallow}
      />
      <div
        aria-hidden="true"
        className="tour-spotlight motion-backdrop"
        data-testid="app-tour-spotlight"
        {...presenceProps(presence.closing)}
        style={
          spotlight
            ? {
                height: spotlight.height,
                left: spotlight.left,
                top: spotlight.top,
                width: spotlight.width,
              }
            : { visibility: 'hidden' }
        }
      />
      <div
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="tour-card motion-surface"
        data-app-tour-card=""
        data-motion-from={geometry ? motionFrom[geometry.side] : 'bottom'}
        data-side-placement={geometry?.side}
        data-testid="app-tour-card"
        ref={bindCard}
        role="dialog"
        {...presenceProps(presence.closing)}
        style={
          geometry
            ? { left: geometry.left, maxHeight: geometry.maxHeight, top: geometry.top }
            : { left: -tourOffscreen, top: -tourOffscreen }
        }
      >
        <div className="tour-card-header">
          <h2 className="tour-card-title" id={titleId}>
            {t(text.title)}
          </h2>
          <span className="tour-card-step" data-testid="app-tour-step">
            {t('tour.step', { step, total })}
          </span>
        </div>
        <div className="tour-card-body" id={bodyId}>
          <p>
            <TourText text={t(text.body)} />
          </p>
          {text.tip ? (
            <p className="tour-card-tip">
              <TourText text={t(text.tip)} />
            </p>
          ) : null}
        </div>
        <div className="tour-card-actions">
          <Button onClick={onSkip} ref={skipButton} size="sm" variant="ghost">
            {t('tour.skip')}
          </Button>
          <Button onClick={onGotIt} ref={gotItButton} size="sm">
            {t('tour.got-it')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TourText({ text }: { text: string }) {
  return (
    <>
      {tourTextParts(text).map((part, index) =>
        part.kind === 'term' ? (
          <span className="tour-term" key={index}>
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

type TourMessageId =
  | 'tour.explorer.title'
  | 'tour.explorer.body.maps'
  | 'tour.explorer.body.scripts'
  | 'tour.editor.title'
  | 'tour.editor.body.snippets'
  | 'tour.editor.body'
  | 'tour.run.title'
  | 'tour.run.body'
  | 'tour.preview.title'
  | 'tour.preview.body'
  | 'tour.preview.tip'
  | 'tour.output.title'
  | 'tour.output.body';

function tourCardText(card: TourCardId): {
  title: TourMessageId;
  body: TourMessageId;
  tip?: TourMessageId;
} {
  const maps = editionCapabilities.newRmsScript;
  switch (card) {
    case 'explorer':
      return {
        title: 'tour.explorer.title',
        body: maps ? 'tour.explorer.body.maps' : 'tour.explorer.body.scripts',
      };
    case 'editor':
      return {
        title: 'tour.editor.title',
        body: maps ? 'tour.editor.body.snippets' : 'tour.editor.body',
      };
    case 'run':
      return { title: 'tour.run.title', body: 'tour.run.body' };
    case 'preview':
      return { title: 'tour.preview.title', body: 'tour.preview.body', tip: 'tour.preview.tip' };
    case 'output':
      return { title: 'tour.output.title', body: 'tour.output.body' };
  }
}
