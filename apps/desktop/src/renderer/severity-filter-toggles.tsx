import { CircleX, Info, TriangleAlert } from 'lucide-react';
import { IconToggleButton } from '@/components/ui/toggle-button';
import type { MessageId } from '../shared/i18n/translator';
import type { OutputSeverity } from '../shared/output-message';
import { useI18n } from './i18n';
import { severities, type SeverityCounts, type SeverityFilter } from './severity-filter';

const severityLabels: Record<
  OutputSeverity,
  { label: MessageId; show: MessageId; hide: MessageId }
> = {
  error: {
    label: 'severity-filter.errors.label',
    show: 'severity-filter.errors.show',
    hide: 'severity-filter.errors.hide',
  },
  warning: {
    label: 'severity-filter.warnings.label',
    show: 'severity-filter.warnings.show',
    hide: 'severity-filter.warnings.hide',
  },
  info: {
    label: 'severity-filter.notes.label',
    show: 'severity-filter.notes.show',
    hide: 'severity-filter.notes.hide',
  },
};

const severityIcons = { error: CircleX, warning: TriangleAlert, info: Info } as const;

export function SeverityFilterToggles({
  counts,
  filter,
  label,
  onToggle,
}: {
  counts: SeverityCounts;
  filter: SeverityFilter;
  label: string;
  onToggle(severity: OutputSeverity): void;
}) {
  const { t } = useI18n();
  return (
    <div
      aria-label={t('severity-filter.label', { panel: label })}
      className="severity-filter"
      role="group"
    >
      {severities.map((severity) => {
        const Icon = severityIcons[severity];
        const count = counts[severity];
        const words = severityLabels[severity];
        return (
          <IconToggleButton
            aria-label={t(words.label, { count })}
            className="severity-filter-toggle"
            data-severity={severity}
            key={severity}
            onClick={() => onToggle(severity)}
            pressed={filter[severity]}
            size="xs"
            title={filter[severity] ? t(words.hide) : t(words.show)}
          >
            <Icon aria-hidden="true" />
            <span className="severity-filter-count">{count}</span>
          </IconToggleButton>
        );
      })}
    </div>
  );
}
