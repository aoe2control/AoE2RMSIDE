import { Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ConnectorState } from '../shared/connector-api';
import { useI18n } from './i18n';
import { connectorIndicatorState } from './mcp-connector-model';
import { RunningIndicator } from './running-indicator';

export function McpStatusIndicator({
  state,
  onOpenSettings,
}: {
  state: ConnectorState | null;
  onOpenSettings(): void;
}) {
  const { t } = useI18n();
  const indicator = connectorIndicatorState(state);
  if (indicator.kind === 'hidden') return null;
  const single = indicator.apps.length === 1 ? indicator.apps[0]! : null;
  const label = single ?? t('mcp.status.many', { count: indicator.apps.length });
  const name =
    indicator.working !== null
      ? t('mcp.status.working', { app: indicator.working })
      : single !== null
        ? t('mcp.status.connected', { app: single })
        : t('mcp.status.connected-many', { count: indicator.apps.length });
  return (
    <Tooltip disableHoverablePopup>
      <TooltipTrigger
        delay={0}
        render={
          <Button
            aria-label={name}
            className="mcp-status-indicator"
            data-testid="mcp-status-indicator"
            data-working={indicator.working !== null || undefined}
            onClick={onOpenSettings}
            size="xs"
            variant="ghost"
          />
        }
      >
        {indicator.working !== null ? (
          <RunningIndicator className="mcp-status-icon" size={14} />
        ) : (
          <Plug aria-hidden="true" className="mcp-status-icon" />
        )}
        <span className="mcp-status-label">{label}</span>
      </TooltipTrigger>
      <TooltipContent>
        {indicator.working !== null
          ? t('mcp.status.working', { app: indicator.working })
          : t('mcp.status.tooltip')}
      </TooltipContent>
    </Tooltip>
  );
}
