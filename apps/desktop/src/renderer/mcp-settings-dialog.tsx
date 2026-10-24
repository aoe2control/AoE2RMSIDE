import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleButton } from '@/components/ui/toggle-button';
import type {
  ConnectorFailure,
  ConnectorSettingsPatch,
  ConnectorSetup,
  ConnectorState,
} from '../shared/connector-api';
import type { MessageId } from '../shared/i18n/translator';
import { CopyFeedbackIcon, useCopyFeedback } from './copy-button';
import { useI18n } from './i18n';
import {
  connectorAppRows,
  connectPanelOpensOnEnable,
  connectRowVariant,
} from './mcp-connector-model';
import {
  connectorPromptText,
  connectorSetupChoices,
  connectorSetupText,
  type ConnectorSetupChoice,
} from './mcp-setup-text';

const choiceWords: Readonly<Record<ConnectorSetupChoice, { label: MessageId; hint: MessageId }>> = {
  'claude-desktop': {
    label: 'mcp.setup.app.claude-desktop',
    hint: 'mcp.setup.hint.claude-desktop',
  },
  'claude-code': { label: 'mcp.setup.app.claude-code', hint: 'mcp.setup.hint.claude-code' },
  codex: { label: 'mcp.setup.app.codex', hint: 'mcp.setup.hint.codex' },
  other: { label: 'mcp.setup.app.other', hint: 'mcp.setup.hint.other' },
};

const failureWords: Readonly<Record<ConnectorFailure, MessageId>> = {
  'pipe-in-use': 'mcp.unavailable.pipe-in-use',
  'key-file': 'mcp.unavailable.key-file',
  catalog: 'mcp.unavailable.catalog',
  internal: 'mcp.unavailable.internal',
};

export function McpSettingsDialog({
  open,
  onOpenChange,
  state,
  onStateChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  state: ConnectorState | null;
  onStateChange(state: ConnectorState): void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [setup, setSetup] = useState<ConnectorSetup | null>(null);
  const appsLabelId = useId();
  useEffect(() => {
    if (!open || setup) return undefined;
    let current = true;
    void window.rmside.getConnectorSetup().then(
      (next) => {
        if (current) setSetup(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [open, setup]);
  useEffect(() => {
    if (!open) setConnectOpen(false);
  }, [open]);
  const latestState = useRef(state);
  useEffect(() => {
    latestState.current = state;
  }, [state]);
  const enabled = state?.enabled ?? false;
  const allowSaving = state?.allowSaving ?? false;
  const failure = state?.server.status === 'failed' ? state.server.failure : null;
  const rows = connectorAppRows(state?.allowedApps ?? []);
  const change = (patch: ConnectorSettingsPatch) => {
    if (busy) return;
    setBusy(true);
    void window.rmside
      .setConnectorSettings(patch)
      .then(
        (next) => {
          onStateChange(next);
          if (connectPanelOpensOnEnable(state, next, latestState.current)) setConnectOpen(true);
        },
        () => undefined,
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="mcp-settings-dialog"
        data-connecting={connectOpen || undefined}
        data-testid="mcp-settings-dialog"
      >
        <DialogClose
          aria-label={t('mcp.dialog.close-label')}
          className="mcp-settings-close"
          size="icon-compact"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </DialogClose>
        <DialogHeader>
          <DialogTitle>{t('mcp.dialog.title')}</DialogTitle>
          <p className="mcp-settings-description">{t('mcp.dialog.description')}</p>
        </DialogHeader>
        <div className="mcp-settings-options" data-testid="mcp-options">
          <ToggleButton
            checked={enabled}
            className="mcp-settings-option"
            data-testid="mcp-enable"
            disabled={busy || state === null}
            onClick={() => change({ enabled: !enabled })}
          >
            <span className="mcp-settings-option-text">
              <span className="mcp-settings-option-name">{t('mcp.enable.label')}</span>
            </span>
          </ToggleButton>
          <ToggleButton
            checked={allowSaving}
            className="mcp-settings-option"
            data-testid="mcp-allow-saving"
            disabled={busy || state === null}
            onClick={() => change({ allowSaving: !allowSaving })}
          >
            <span className="mcp-settings-option-text">
              <span className="mcp-settings-option-name">{t('mcp.save.label')}</span>
              <span className="mcp-settings-option-note">{t('mcp.save.note')}</span>
            </span>
          </ToggleButton>
        </div>
        {failure ? (
          <Alert className="mcp-settings-failure" role="alert" variant="destructive">
            <AlertTitle>{t(failureWords[failure])}</AlertTitle>
            <AlertDescription>{t('mcp.unavailable.retry')}</AlertDescription>
          </Alert>
        ) : null}
        <section aria-labelledby={appsLabelId} className="mcp-settings-section">
          <h3 className="mcp-settings-label" id={appsLabelId}>
            {t('mcp.apps.title')}
          </h3>
          <div className="mcp-settings-options" data-testid="mcp-apps-group">
            {rows.length === 0 ? (
              <p className="mcp-settings-empty">{t('mcp.apps.empty')}</p>
            ) : (
              <ul className="mcp-settings-apps" data-testid="mcp-allowed-apps">
                {rows.map((row) => (
                  <li className="mcp-settings-app" key={row.name}>
                    <span className="mcp-settings-app-name">{row.label}</span>
                    {row.connected ? (
                      <Badge className="mcp-settings-app-status" variant="secondary">
                        {t('mcp.apps.connected')}
                      </Badge>
                    ) : (
                      <span className="mcp-settings-app-status mcp-settings-app-last-used">
                        {t('mcp.apps.last-used', { date: row.lastUsed })}
                      </span>
                    )}
                    <Button
                      aria-label={t('mcp.apps.remove-label', { app: row.label })}
                      disabled={busy}
                      onClick={() =>
                        void window.rmside.removeConnectorApp(row.name).catch(() => undefined)
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t('mcp.apps.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mcp-connect-row">
              <Button
                data-testid="mcp-connect-open"
                onClick={() => setConnectOpen(true)}
                size="sm"
                type="button"
                variant={connectRowVariant(state)}
              >
                {t('mcp.connect.row')}
              </Button>
            </div>
          </div>
        </section>
        <ConnectAppDialog
          enabled={enabled}
          onOpenChange={setConnectOpen}
          open={open && connectOpen}
          setup={setup}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConnectAppDialog({
  open,
  onOpenChange,
  enabled,
  setup,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  enabled: boolean;
  setup: ConnectorSetup | null;
}) {
  const { t } = useI18n();
  const copyButton = useRef<HTMLButtonElement>(null);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPortal>
        <DialogOverlay className="mcp-connect-backdrop" forceRender />
      </DialogPortal>
      <DialogContent
        className="mcp-settings-dialog mcp-connect-dialog"
        data-testid="mcp-connect-dialog"
        initialFocus={copyButton}
      >
        <DialogClose
          aria-label={t('mcp.connect.close-label')}
          className="mcp-settings-close"
          size="icon-compact"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </DialogClose>
        <DialogHeader>
          <DialogTitle>{t('mcp.connect.title')}</DialogTitle>
          <p className="mcp-settings-description">{t('mcp.connect.description')}</p>
        </DialogHeader>
        <ConnectAppBody copyButton={copyButton} enabled={enabled} setup={setup} />
      </DialogContent>
    </Dialog>
  );
}

function ConnectAppBody({
  copyButton,
  enabled,
  setup,
}: {
  copyButton: RefObject<HTMLButtonElement | null>;
  enabled: boolean;
  setup: ConnectorSetup | null;
}) {
  const { t } = useI18n();
  const [handOpen, setHandOpen] = useState(false);
  const [choice, setChoice] = useState<ConnectorSetupChoice>('claude-desktop');
  const handId = useId();
  const promptText = setup ? connectorPromptText(setup) : '';
  const setupText = setup ? connectorSetupText(choice, setup) : '';
  const copyPrompt = useCopyFeedback(promptText);
  const copySetup = useCopyFeedback(setupText);
  return (
    <>
      {enabled ? null : <p className="mcp-setup-hint">{t('mcp.setup.needs-enable')}</p>}
      <pre
        aria-label={t('mcp.connect.prompt-label')}
        className="mcp-setup-text mcp-connect-prompt"
        data-testid="mcp-connect-prompt"
        dir="ltr"
        lang="en"
        tabIndex={0}
      >
        {promptText}
      </pre>
      <section className="mcp-settings-section">
        <div className="mcp-setup-actions">
          <Button
            aria-label={copyPrompt.copied ? t('mcp.connect.copied') : undefined}
            data-copied={copyPrompt.copied || undefined}
            data-testid="mcp-copy-prompt"
            disabled={setup === null}
            onClick={() =>
              void copyPrompt
                .run(() => navigator.clipboard.writeText(promptText))
                .catch(() => undefined)
            }
            ref={copyButton}
            type="button"
          >
            <span aria-hidden="true" className="mcp-setup-copy-icon" data-icon="inline-start">
              <CopyFeedbackIcon checkRef={copyPrompt.checkRef} copied={copyPrompt.copied} />
            </span>
            {t('mcp.connect.copy')}
          </Button>
          <Button
            aria-controls={handOpen ? handId : undefined}
            aria-expanded={handOpen}
            className="mcp-connect-hand-toggle"
            data-testid="mcp-setup-by-hand"
            onClick={() => setHandOpen((shown) => !shown)}
            type="button"
            variant="ghost"
          >
            <ChevronRight aria-hidden="true" className="mcp-connect-hand-chevron" />
            {t('mcp.connect.by-hand')}
          </Button>
        </div>
        {handOpen ? (
          <div className="mcp-settings-section" id={handId}>
            <Select
              onValueChange={(value) => {
                if ((connectorSetupChoices as readonly unknown[]).includes(value)) {
                  setChoice(value as ConnectorSetupChoice);
                }
              }}
              value={choice}
            >
              <SelectTrigger
                aria-label={t('mcp.setup.app')}
                className="mcp-setup-select"
                data-testid="mcp-setup-app"
              >
                <SelectValue>{t(choiceWords[choice].label)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {connectorSetupChoices.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(choiceWords[option].label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <pre
              aria-label={t('mcp.setup.text-label')}
              className="mcp-setup-text"
              data-testid="mcp-setup-text"
              dir="ltr"
              tabIndex={0}
            >
              {setupText}
            </pre>
            <p className="mcp-setup-hint">{t(choiceWords[choice].hint)}</p>
            <div className="mcp-setup-actions">
              <Button
                aria-label={copySetup.copied ? t('mcp.setup.copied') : undefined}
                data-copied={copySetup.copied || undefined}
                data-testid="mcp-copy-setup"
                disabled={setup === null}
                onClick={() =>
                  void copySetup
                    .run(() => navigator.clipboard.writeText(setupText))
                    .catch(() => undefined)
                }
                type="button"
                variant="secondary"
              >
                <span aria-hidden="true" className="mcp-setup-copy-icon" data-icon="inline-start">
                  <CopyFeedbackIcon checkRef={copySetup.checkRef} copied={copySetup.copied} />
                </span>
                {t('mcp.setup.copy')}
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}
