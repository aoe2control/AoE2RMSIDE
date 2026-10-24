import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Download, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { noUpdate, updateBusy, updateDownloadPercent, type UpdateState } from '../shared/update';
import { ExecutionProgressBar } from './execution-progress-bar';
import { useI18n } from './i18n';

export interface UpdateController {
  state: UpdateState;
  requestUpdate(): void;
}

const UpdateContext = createContext<UpdateController | null>(null);

export const UpdateProvider = UpdateContext.Provider;

export function useUpdateController(enabled: boolean): {
  controller: UpdateController;
  dialogOpen: boolean;
  setDialogOpen(open: boolean): void;
} {
  const [state, setState] = useState<UpdateState>(noUpdate);
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    const unsubscribe = window.rmside.onUpdateState((next) => setState(next));
    void window.rmside.getUpdateState().then(
      (next) => {
        if (current) setState(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [enabled]);
  useEffect(() => {
    if (state.phase !== 'available') setDialogOpen(false);
  }, [state.phase]);
  const requestUpdate = useCallback(() => {
    if (state.phase === 'available') setDialogOpen(true);
  }, [state.phase]);
  const controller = useMemo(() => ({ state, requestUpdate }), [requestUpdate, state]);
  return { controller, dialogOpen, setDialogOpen };
}

export function UpdateHeaderControl({ controller }: { controller: UpdateController }) {
  const { t } = useI18n();
  const { state } = controller;
  const run = useRef(0);
  const wasBusy = useRef(false);
  const busy = updateBusy(state);
  if (busy && !wasBusy.current) run.current += 1;
  wasBusy.current = busy;
  if (state.phase === 'none') return null;
  if (state.phase === 'available') {
    return (
      <Tooltip disableHoverablePopup>
        <TooltipTrigger
          delay={0}
          render={
            <Button
              className="update-button"
              data-testid="update-button"
              onClick={controller.requestUpdate}
              size="xs"
              variant="secondary"
            />
          }
        >
          <Download aria-hidden="true" data-icon="inline-start" />
          {t('app-update.button')}
        </TooltipTrigger>
        <TooltipContent>
          {t('app-update.button.tooltip', { version: state.version })}
        </TooltipContent>
      </Tooltip>
    );
  }
  const percent = updateDownloadPercent(state);
  const word =
    state.phase === 'downloading'
      ? t('app-update.progress.downloading')
      : state.phase === 'verifying'
        ? t('app-update.progress.verifying')
        : t('app-update.progress.installing');
  const detail =
    state.phase === 'downloading'
      ? state.totalBytes === null
        ? t('app-update.progress.detail.preparing', { version: state.version })
        : t('app-update.progress.detail.downloading', {
            version: state.version,
            percent,
            received: megabytes(state.receivedBytes),
            total: megabytes(state.totalBytes),
          })
      : state.phase === 'verifying'
        ? t('app-update.progress.detail.verifying', { version: state.version })
        : t('app-update.progress.detail.installing', { version: state.version });
  const cancellable = state.phase === 'downloading' || state.phase === 'verifying';
  return (
    <span className="update-progress-group" data-phase={state.phase} data-testid="update-progress">
      <Tooltip disableHoverablePopup>
        <TooltipTrigger
          delay={0}
          render={
            <span
              aria-label={t('app-update.progress.label')}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={percent}
              aria-valuetext={detail}
              className="game-art-conversion-progress update-progress"
              role="progressbar"
              tabIndex={0}
            />
          }
        >
          <span aria-hidden="true" className="game-art-conversion-action">
            {word}
          </span>
          <ExecutionProgressBar
            fading={false}
            identity={`update-${run.current}`}
            onFadeEnd={() => undefined}
            percent={percent}
          />
        </TooltipTrigger>
        <TooltipContent
          className="game-art-conversion-tooltip"
          data-testid="update-progress-tooltip"
        >
          {detail}
        </TooltipContent>
      </Tooltip>
      {cancellable ? (
        <Tooltip disableHoverablePopup>
          <TooltipTrigger
            delay={0}
            render={
              <Button
                aria-label={t('app-update.cancel')}
                className="update-cancel"
                onClick={() => void window.rmside.cancelUpdate().catch(() => undefined)}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <X aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{t('app-update.cancel')}</TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

export function UpdateNoteAction() {
  const { t } = useI18n();
  const controller = useContext(UpdateContext);
  if (!controller || controller.state.phase === 'none') return null;
  return (
    <>
      {' · '}
      <Button
        className="output-link output-update-action h-auto"
        data-testid="update-note-action"
        disabled={controller.state.phase !== 'available'}
        onClick={controller.requestUpdate}
        type="button"
        variant="link"
      >
        {t('app-update.note-action')}
      </Button>
    </>
  );
}

export function UpdateDialog({
  aiAppsConnected = false,
  controller,
  open,
  onOpenChange,
}: {
  aiAppsConnected?: boolean;
  controller: UpdateController;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const confirm = useRef<HTMLButtonElement>(null);
  const shown = useRef<string | null>(null);
  if (controller.state.phase === 'available') shown.current = controller.state.version;
  const version = shown.current ?? '';
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent
        className="update-dialog"
        data-testid="update-dialog"
        initialFocus={confirm}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('app-update.dialog.title', { version })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('app-update.dialog.description', { version })} {t('app-update.dialog.unsaved')}
            {aiAppsConnected ? <> {t('app-update.dialog.mcp-apps')}</> : null}
          </AlertDialogDescription>
          <Button
            className="output-link update-dialog-notes h-auto self-start"
            data-testid="update-release-notes"
            onClick={() => void window.rmside.openUpdateReleaseNotes().catch(() => undefined)}
            role="link"
            type="button"
            variant="link"
          >
            {t('app-update.dialog.release-notes')}
          </Button>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('dialog.confirm.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onOpenChange(false);
              void window.rmside.startUpdate(version).catch(() => undefined);
            }}
            data-testid="update-confirm"
            ref={confirm}
          >
            {t('app-update.dialog.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
