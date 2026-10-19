import { useCallback, useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Check, X } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { ThemePreference } from '../shared/api';
import type { EditorColorSchemeId } from '../shared/editor-color-scheme';
import {
  editorBackgrounds,
  editorColorSchemes,
  previewRoleColor,
  schemePreviewLines,
  type EditorColorHalf,
  type EditorColorScheme,
} from './editor-color-schemes';
import { useI18n } from './i18n';
import { prefersReducedMotion } from './motion';
import { themePreferences } from './theme';
import {
  horizontalOverflow,
  isNotchedWheel,
  schemeDragScrollLeft,
  schemeDragStarted,
  schemeFlingMinimumVelocity,
  schemeFlingTimeConstant,
  schemeLandingVelocity,
  schemeMomentumSettled,
  schemeMomentumStep,
  schemeMomentumTarget,
  schemeReleaseVelocity,
  schemeWheelTimeConstant,
  type EdgeOverflow,
  type SchemeScrollSample,
} from './theme-settings';

export function ThemeSettingsDialog({
  open,
  onOpenChange,
  themePreference,
  onThemePreferenceChange,
  editorColorScheme,
  onEditorColorSchemeChange,
  previewBlur,
  onPreviewBlurChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  themePreference: ThemePreference;
  onThemePreferenceChange(preference: ThemePreference): void;
  editorColorScheme: EditorColorSchemeId;
  onEditorColorSchemeChange(scheme: EditorColorSchemeId): void;
  previewBlur: boolean;
  onPreviewBlurChange(blur: boolean): void;
}) {
  const { t } = useI18n();
  const appThemeLabelId = useId();
  const editorColorsLabelId = useId();
  const backgroundBlurLabelId = useId();
  const themeLabels = {
    system: t('app-menu.view.theme.system'),
    light: t('app-menu.view.theme.light'),
    dark: t('app-menu.view.theme.dark'),
  } satisfies Record<ThemePreference, string>;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="theme-settings-dialog" data-testid="theme-settings-dialog">
        <DialogClose
          aria-label={t('settings.theme.close-label')}
          className="theme-settings-close"
          size="icon-compact"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </DialogClose>
        <DialogHeader>
          <DialogTitle>{t('app-menu.view.theme')}</DialogTitle>
        </DialogHeader>
        <section className="theme-settings-section">
          <h3 className="theme-settings-label" id={appThemeLabelId}>
            {t('settings.theme.app-theme')}
          </h3>
          <SegmentedControl<ThemePreference>
            aria-labelledby={appThemeLabelId}
            className="theme-settings-app-theme"
            data-testid="theme-settings-app-theme"
            onValueChange={onThemePreferenceChange}
            options={themePreferences.map((preference) => ({
              value: preference,
              label: themeLabels[preference],
            }))}
            value={themePreference}
          />
        </section>
        <section className="theme-settings-section">
          <h3 className="theme-settings-label" id={editorColorsLabelId}>
            {t('settings.theme.editor-colors')}
          </h3>
          <SchemeCards
            labelledBy={editorColorsLabelId}
            onChange={onEditorColorSchemeChange}
            open={open}
            schemeName={(scheme) => scheme.name ?? t('settings.theme.scheme.default')}
            value={editorColorScheme}
          />
        </section>
        <section className="theme-settings-section">
          <h3 className="theme-settings-label" id={backgroundBlurLabelId}>
            {t('settings.theme.background-blur')}
          </h3>
          <SegmentedControl<BackgroundBlurChoice>
            aria-labelledby={backgroundBlurLabelId}
            backdrop={<BlurSwitchEnds />}
            className="background-blur-switch"
            data-testid="theme-settings-background-blur"
            onValueChange={(choice) => onPreviewBlurChange(choice === 'blurred')}
            options={[
              {
                value: 'clear',
                label: t('settings.theme.background-blur.clear'),
                tooltip: t('settings.theme.background-blur.clear.tooltip'),
              },
              {
                value: 'blurred',
                label: t('settings.theme.background-blur.blurred'),
                tooltip: t('settings.theme.background-blur.blurred.tooltip'),
              },
            ]}
            value={previewBlur ? 'blurred' : 'clear'}
          />
        </section>
      </DialogContent>
    </Dialog>
  );
}

function SchemeCards({
  labelledBy,
  onChange,
  open,
  schemeName,
  value,
}: {
  labelledBy: string;
  onChange(scheme: EditorColorSchemeId): void;
  open: boolean;
  schemeName(scheme: EditorColorScheme): string;
  value: EditorColorSchemeId;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<EdgeOverflow>({ left: false, right: false });
  const measure = useCallback(() => {
    if (!scroller) return;
    const next = horizontalOverflow(scroller, getComputedStyle(scroller).direction === 'rtl');
    setOverflow((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, [scroller]);

  useEffect(() => {
    if (!scroller) return undefined;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    scroller.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', measure);
    };
  }, [measure, scroller]);

  const momentum = useRef<SchemeRowMomentum | null>(null);
  useEffect(() => {
    if (!scroller) return undefined;
    const rowMomentum = new SchemeRowMomentum(scroller);
    momentum.current = rowMomentum;
    const stop = () => rowMomentum.cancel();
    scroller.addEventListener('keydown', stop);
    return () => {
      scroller.removeEventListener('keydown', stop);
      rowMomentum.cancel();
      if (momentum.current === rowMomentum) momentum.current = null;
    };
  }, [scroller]);

  useEffect(() => {
    if (!scroller) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const rowMomentum = momentum.current;
      const glide = isNotchedWheel(event) && !prefersReducedMotion();
      if (!glide) rowMomentum?.cancel();
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const range = scroller.scrollWidth - scroller.clientWidth;
      if (range <= 0) return;
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      const rightToLeft = getComputedStyle(scroller).direction === 'rtl';
      const fromStart = Math.abs(
        glide && rowMomentum ? rowMomentum.restingScrollLeft() : scroller.scrollLeft,
      );
      const towardEnd = delta > 0;
      if ((towardEnd && fromStart >= range - 1) || (!towardEnd && fromStart <= 1)) return;
      event.preventDefault();
      const left = rightToLeft ? -delta : delta;
      if (glide && rowMomentum) rowMomentum.wheel(left);
      else scroller.scrollBy({ left, behavior: 'auto' });
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [scroller]);

  const shownOnOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      shownOnOpen.current = false;
      return;
    }
    if (!scroller || shownOnOpen.current) return;
    shownOnOpen.current = true;
    momentum.current?.cancel();
    scroller
      .querySelector<HTMLElement>(`[data-scheme="${value}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    measure();
  }, [measure, open, scroller, value]);

  const mousePress = useRef<SchemeRowPress | null>(null);
  useEffect(() => {
    if (!scroller) return undefined;
    const view = scroller.ownerDocument.defaultView ?? window;
    let swallowClick = false;
    let swallowTimer: number | undefined;
    const onPointerMove = (event: PointerEvent) => {
      const press = mousePress.current;
      if (!press || event.pointerId !== press.pointerId) return;
      if (!press.dragging) {
        if (!schemeDragStarted(event.clientX - press.startX, event.clientY - press.startY)) return;
        press.dragging = true;
        try {
          scroller.setPointerCapture(event.pointerId);
        } catch {}
      }
      event.preventDefault();
      scroller.scrollLeft = schemeDragScrollLeft(
        press.startScrollLeft,
        press.startX,
        event.clientX,
      );
      press.samples.push({ time: event.timeStamp, scrollLeft: scroller.scrollLeft });
      if (press.samples.length > 32) press.samples.shift();
    };
    const endPress = (event: PointerEvent) => {
      const press = mousePress.current;
      if (!press || event.pointerId !== press.pointerId) return;
      mousePress.current = null;
      view.removeEventListener('pointermove', onPointerMove);
      view.removeEventListener('pointerup', endPress);
      view.removeEventListener('pointercancel', endPress);
      if (scroller.hasPointerCapture(event.pointerId)) {
        scroller.releasePointerCapture(event.pointerId);
      }
      if (press.dragging) {
        swallowClick = true;
        view.clearTimeout(swallowTimer);
        swallowTimer = view.setTimeout(() => {
          swallowClick = false;
        }, 0);
        const velocity =
          event.type === 'pointerup' ? schemeReleaseVelocity(press.samples, event.timeStamp) : 0;
        if (Math.abs(velocity) >= schemeFlingMinimumVelocity && !prefersReducedMotion()) {
          momentum.current?.fling(velocity);
        }
      } else if (event.type === 'pointerup' && press.card) {
        revealCard(press.card);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      momentum.current?.cancel();
      if (event.pointerType !== 'mouse' || event.button !== 0 || mousePress.current) return;
      const target = event.target instanceof Element ? event.target : null;
      mousePress.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startScrollLeft: scroller.scrollLeft,
        dragging: false,
        card: target?.closest<HTMLElement>('.theme-scheme-card') ?? null,
        samples: [{ time: event.timeStamp, scrollLeft: scroller.scrollLeft }],
      };
      view.addEventListener('pointermove', onPointerMove);
      view.addEventListener('pointerup', endPress);
      view.addEventListener('pointercancel', endPress);
    };
    const onClick = (event: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const preventDefault = (event: Event) => event.preventDefault();
    scroller.addEventListener('pointerdown', onPointerDown);
    scroller.addEventListener('click', onClick, { capture: true });
    scroller.addEventListener('dragstart', preventDefault);
    scroller.addEventListener('selectstart', preventDefault);
    return () => {
      scroller.removeEventListener('pointerdown', onPointerDown);
      scroller.removeEventListener('click', onClick, { capture: true });
      scroller.removeEventListener('dragstart', preventDefault);
      scroller.removeEventListener('selectstart', preventDefault);
      view.removeEventListener('pointermove', onPointerMove);
      view.removeEventListener('pointerup', endPress);
      view.removeEventListener('pointercancel', endPress);
      view.clearTimeout(swallowTimer);
      mousePress.current = null;
    };
  }, [scroller]);

  const reveal = (event: FocusEvent<HTMLElement>) => {
    if (mousePress.current) return;
    momentum.current?.cancel();
    revealCard(event.currentTarget);
  };

  return (
    <RadioGroup<EditorColorSchemeId>
      aria-labelledby={labelledBy}
      className="theme-scheme-cards"
      data-fade-left={overflow.left}
      data-fade-right={overflow.right}
      data-testid="theme-scheme-cards"
      onValueChange={onChange}
      ref={setScroller}
      value={value}
    >
      {editorColorSchemes.map((scheme) => (
        <Radio.Root<EditorColorSchemeId>
          className="theme-scheme-card"
          data-scheme={scheme.id}
          key={scheme.id}
          nativeButton
          onFocus={reveal}
          render={<button type="button" />}
          value={scheme.id}
        >
          <span aria-hidden="true" className="theme-scheme-preview">
            <SchemePreviewCode half={scheme.light} theme="light" />
            <SchemePreviewCode half={scheme.dark} theme="dark" />
            <span className="theme-scheme-divider" />
          </span>
          {scheme.id === value ? (
            <span aria-hidden="true" className="theme-scheme-check">
              <Check />
            </span>
          ) : null}
          <span className="theme-scheme-name">{schemeName(scheme)}</span>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

type BackgroundBlurChoice = 'clear' | 'blurred';

function BlurSwitchEnds() {
  return (
    <>
      <span className="blur-switch-end" data-end="start" />
      <span className="blur-switch-end" data-end="end" />
      <span className="blur-switch-divider" data-end="start" />
      <span className="blur-switch-divider" data-end="end" />
    </>
  );
}

interface SchemeRowPress {
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  dragging: boolean;
  card: HTMLElement | null;
  samples: SchemeScrollSample[];
}

class SchemeRowMomentum {
  private glide: {
    position: number;
    velocity: number;
    timeConstant: number;
    time: number;
  } | null = null;
  private frame = 0;

  constructor(private readonly scroller: HTMLElement) {}

  restingScrollLeft(): number {
    const glide = this.glide;
    if (!glide) return this.scroller.scrollLeft;
    return schemeMomentumTarget(glide.position, glide.velocity, glide.timeConstant);
  }

  fling(velocity: number): void {
    this.start(this.scroller.scrollLeft, velocity, schemeFlingTimeConstant);
  }

  wheel(distance: number): void {
    const glide = this.glide;
    if (glide && glide.timeConstant === schemeWheelTimeConstant) {
      const now = this.view().performance.now();
      const current = schemeMomentumStep(
        glide.position,
        glide.velocity,
        now - glide.time,
        glide.timeConstant,
      );
      this.start(
        current.position,
        current.velocity + distance / schemeWheelTimeConstant,
        schemeWheelTimeConstant,
      );
      return;
    }
    this.start(
      this.scroller.scrollLeft,
      distance / schemeWheelTimeConstant,
      schemeWheelTimeConstant,
    );
  }

  cancel(): void {
    if (!this.glide) return;
    this.view().cancelAnimationFrame(this.frame);
    this.glide = null;
  }

  private view(): Window {
    return this.scroller.ownerDocument.defaultView ?? window;
  }

  private start(position: number, velocity: number, timeConstant: number): void {
    this.cancel();
    const range = Math.max(0, this.scroller.scrollWidth - this.scroller.clientWidth);
    const rightToLeft = getComputedStyle(this.scroller).direction === 'rtl';
    const landing = schemeLandingVelocity(
      position,
      velocity,
      timeConstant,
      rightToLeft ? -range : 0,
      rightToLeft ? 0 : range,
    );
    if (schemeMomentumSettled(landing, timeConstant)) return;
    const view = this.view();
    this.glide = { position, velocity: landing, timeConstant, time: view.performance.now() };
    this.frame = view.requestAnimationFrame(this.tick);
  }

  private readonly tick = (time: number): void => {
    const glide = this.glide;
    if (!glide) return;
    const next = schemeMomentumStep(
      glide.position,
      glide.velocity,
      time - glide.time,
      glide.timeConstant,
    );
    if (schemeMomentumSettled(next.velocity, glide.timeConstant)) {
      this.scroller.scrollLeft = schemeMomentumTarget(
        glide.position,
        glide.velocity,
        glide.timeConstant,
      );
      this.glide = null;
      return;
    }
    this.glide = { ...glide, ...next, time: Math.max(time, glide.time) };
    this.scroller.scrollLeft = next.position;
    this.frame = this.view().requestAnimationFrame(this.tick);
  };
}

function revealCard(card: HTMLElement): void {
  card.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    behavior: prefersReducedMotion() ? 'instant' : 'smooth',
  });
}

function SchemePreviewCode({ half, theme }: { half: EditorColorHalf; theme: 'light' | 'dark' }) {
  return (
    <span
      className="theme-scheme-code"
      data-half={theme}
      dir="ltr"
      style={{ background: editorBackgrounds[theme] }}
    >
      {schemePreviewLines.map((line, lineIndex) => (
        <span className="theme-scheme-line" key={lineIndex}>
          {line.map(([text, role], index) => (
            <span data-role={role} key={index} style={{ color: previewRoleColor(half, role) }}>
              {text}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
