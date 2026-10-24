import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
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
import { ToggleButton } from '@/components/ui/toggle-button';
import type { ConnectorState } from '../shared/connector-api';
import type { ConnectorPromptAnswer } from '../shared/connector-prompts';
import { knownCrashDetails } from '../shared/known-crashes';
import { useI18n } from './i18n';
import {
  ConnectorPromptQueue,
  connectorPromptKey,
  shownConnectorPrompt,
  type ShownConnectorPrompt,
} from './mcp-prompt-queue';

export function McpPrompts({ state }: { state: ConnectorState | null }) {
  const { t } = useI18n();
  const queue = useMemo(
    () =>
      new ConnectorPromptQueue((reply) => {
        void window.rmside.replyToConnectorRequest(reply).catch(() => undefined);
      }),
    [],
  );
  const prompts = useSyncExternalStore(queue.subscribe, queue.snapshot);
  useEffect(
    () =>
      window.rmside.onConnectorRequest((request) => {
        queue.accept(request);
      }),
    [queue],
  );
  const enabled = state?.enabled ?? null;
  useEffect(() => {
    if (enabled === false) queue.closeAll();
  }, [enabled, queue, prompts]);
  useEffect(() => {
    const next = queue.expire();
    if (next === null) return undefined;
    const timer = window.setTimeout(() => queue.expire(), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [prompts, queue]);
  const [answeredPairings, setAnsweredPairings] = useState<ReadonlySet<string>>(new Set());
  const pairingRequests = (state?.pairingRequests ?? []).filter(
    (request) => !answeredPairings.has(request.id),
  );
  const shown = shownConnectorPrompt(pairingRequests, prompts);
  const key = connectorPromptKey(shown);
  const held = useRef<ShownConnectorPrompt | null>(null);
  if (shown) held.current = shown;
  const visible = held.current;
  const [allowForSession, setAllowForSession] = useState(false);
  const [sessionKey, setSessionKey] = useState(key);
  if (sessionKey !== key) {
    setSessionKey(key);
    setAllowForSession(false);
  }
  const popup = useRef<HTMLDivElement>(null);

  const decidePairing = (decision: 'allow' | 'deny') => {
    if (shown?.kind !== 'pairing') return;
    const id = shown.request.id;
    setAnsweredPairings((current) => new Set([...current, id]));
    void window.rmside.decideConnectorPairing(id, decision).catch(() => undefined);
  };
  const answerPrompt = (answer: ConnectorPromptAnswer) => {
    if (shown?.kind !== 'bridge') return;
    queue.answer(shown.entry.requestId, answer);
  };
  const cancel = () => {
    if (shown?.kind === 'pairing') decidePairing('deny');
    else answerPrompt({ decision: 'cancel' });
  };

  let content: ReactNode = null;
  if (visible?.kind === 'pairing') {
    const { displayName: app, launcherImage: program } = visible.request;
    content = (
      <>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('mcp.pairing.title', { app })}</AlertDialogTitle>
          <AlertDialogDescription>
            {program
              ? t('mcp.pairing.description', { program })
              : t('mcp.pairing.description.no-program')}
          </AlertDialogDescription>
          <p className="mcp-prompt-note">{t('mcp.pairing.name-note')}</p>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="mcp-pairing-deny">
            {t('mcp.pairing.deny')}
          </AlertDialogCancel>
          <AlertDialogAction data-testid="mcp-pairing-allow" onClick={() => decidePairing('allow')}>
            {t('mcp.pairing.allow')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </>
    );
  } else if (visible?.kind === 'bridge') {
    const prompt = visible.entry.prompt;
    if (prompt.prompt === 'deploy-replace') {
      content = (
        <>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('mcp.deploy.replace.title', { mod: prompt.mod })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('mcp.deploy.replace.description', { app: prompt.app, file: prompt.file })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('dialog.confirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="mcp-prompt-confirm"
              onClick={() => answerPrompt({ decision: 'confirm' })}
              variant="warning"
            >
              {t('mcp.deploy.replace.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </>
      );
    } else if (prompt.prompt === 'deploy-known-crash') {
      content = (
        <>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('live-test.crash-warning.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deploy-panel.crash-warning', { details: knownCrashDetails(prompt.crashes) })}
            </AlertDialogDescription>
            <p className="mcp-prompt-note">
              {t('mcp.deploy.crash.by-app', {
                app: prompt.app,
                file: prompt.file,
                mod: prompt.mod,
              })}
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('dialog.confirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="mcp-prompt-confirm"
              onClick={() => answerPrompt({ decision: 'confirm' })}
              variant="warning"
            >
              {t('deploy-panel.deploy-anyway')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </>
      );
    } else {
      content = (
        <>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('mcp.live.title', { app: prompt.app })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('mcp.live.description', { app: prompt.app, file: prompt.file, seed: prompt.seed })}
            </AlertDialogDescription>
            {prompt.crashes ? (
              <p className="mcp-prompt-note mcp-prompt-warning">
                {t('live-test.crash-warning.description', {
                  details: knownCrashDetails(prompt.crashes),
                })}
              </p>
            ) : null}
          </AlertDialogHeader>
          <ToggleButton
            checked={allowForSession}
            className="mcp-prompt-session"
            data-testid="mcp-live-session"
            density="compact"
            onClick={() => setAllowForSession((current) => !current)}
          >
            {t('mcp.live.session')}
          </ToggleButton>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('dialog.confirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="mcp-prompt-confirm"
              onClick={() =>
                answerPrompt({
                  decision: 'confirm',
                  ...(allowForSession ? { allowForSession: true } : {}),
                })
              }
              variant={prompt.crashes ? 'warning' : 'default'}
            >
              {prompt.crashes ? t('live-test.crash-warning.confirm') : t('mcp.live.start')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </>
      );
    }
  }

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      open={shown !== null}
    >
      <AlertDialogContent
        className="mcp-prompt"
        data-testid="mcp-prompt"
        initialFocus={popup}
        ref={popup}
      >
        {content}
      </AlertDialogContent>
    </AlertDialog>
  );
}
