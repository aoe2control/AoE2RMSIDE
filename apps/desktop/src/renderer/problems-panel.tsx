import { useId, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MessageId } from '../shared/i18n/translator';
import type { OutputSeverity } from '../shared/output-message';
import { useFollowBottom } from './follow-bottom';
import { useI18n } from './i18n';
import { JumpToLatest, OutputMessageText, OutputSource } from './output-panel';
import {
  filterProblemGroups,
  type ProblemEntry,
  type ProblemFileGroup,
  type ProblemTarget,
} from './problems-model';
import type { SeverityFilter } from './severity-filter';

const severityWords: Record<OutputSeverity, MessageId> = {
  error: 'problems-panel.severity.error',
  warning: 'problems-panel.severity.warning',
  info: 'problems-panel.severity.info',
};

const severityCounts: Record<OutputSeverity, MessageId> = {
  error: 'problems-panel.group.errors',
  warning: 'problems-panel.group.warnings',
  info: 'problems-panel.group.notes',
};

function countsText(group: ProblemFileGroup, t: ReturnType<typeof useI18n>['t']): string {
  return (['error', 'warning', 'info'] as const)
    .filter((severity) => group.counts[severity] > 0)
    .map((severity) => t(severityCounts[severity], { count: group.counts[severity] }))
    .join(' · ');
}

export function ProblemsPanel({
  filter,
  groups,
  onNavigate,
}: {
  filter: SeverityFilter;
  groups: readonly ProblemFileGroup[];
  onNavigate(target: ProblemTarget, location: string): void;
}) {
  const { t } = useI18n();
  const shown = filterProblemGroups(groups, filter);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const rows = shown.reduce((total, group) => total + group.entries.length, 0);
  const follow = useFollowBottom(rows, shown);
  const hidden = groups.reduce((total, group) => total + group.entries.length, 0) - rows;
  const toggle = (uri: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  return (
    <div className="bottom-list-shell">
      <div
        aria-label={t('problems-panel.log.label', { count: rows })}
        className="output-log problems-log owned-scrollbars"
        data-follow={follow.state.pinned ? 'pinned' : 'free'}
        data-testid="problems"
        onScroll={follow.onScroll}
        ref={follow.ref}
      >
        {groups.length === 0 ? (
          <p className="output-empty">{t('problems-panel.empty')}</p>
        ) : shown.length === 0 ? (
          <p className="output-empty">{t('problems-panel.empty.filtered', { hidden })}</p>
        ) : (
          shown.map((group) => (
            <ProblemGroupView
              group={group}
              key={group.uri}
              onNavigate={onNavigate}
              onToggle={() => toggle(group.uri)}
              open={!closed.has(group.uri)}
              total={groups.find((candidate) => candidate.uri === group.uri) ?? group}
            />
          ))
        )}
      </div>
      <JumpToLatest follow={follow} />
    </div>
  );
}

function ProblemGroupView({
  group,
  onNavigate,
  onToggle,
  open,
  total,
}: {
  group: ProblemFileGroup;
  onNavigate(target: ProblemTarget, location: string): void;
  onToggle(): void;
  open: boolean;
  total: ProblemFileGroup;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const rowsId = useId();
  const toggleFromHeader = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (window.getSelection()?.toString()) return;
    onToggle();
  };
  return (
    <div
      aria-labelledby={titleId}
      className="output-group problems-group"
      data-file={group.name}
      data-open={open ? 'true' : 'false'}
      data-protected={group.protected ? 'true' : 'false'}
      role="group"
    >
      <div
        className="output-row output-group-header"
        data-expandable="true"
        onClick={toggleFromHeader}
        title={group.path}
      >
        <span className="output-time problems-position" />
        <span className="output-source">
          {group.protected ? t('problems-panel.group.game-file') : t('problems-panel.group.file')}
        </span>
        <div className="output-text">
          <p className="output-headline output-group-title">
            <Button
              aria-controls={rowsId}
              aria-expanded={open}
              aria-label={
                open
                  ? t('problems-panel.group.hide', { file: group.name })
                  : t('problems-panel.group.show', { file: group.name })
              }
              className="output-group-toggle"
              onClick={onToggle}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronRight aria-hidden="true" className="output-chevron" />
            </Button>
            <span id={titleId}>
              {group.name}
              {' · '}
              <span className="problems-group-counts">{countsText(total, t)}</span>
            </span>
          </p>
        </div>
      </div>
      <div
        aria-label={t('problems-panel.group.label', { file: group.name })}
        className="output-group-rows"
        hidden={!open}
        id={rowsId}
        role="list"
      >
        {group.entries.map((entry) => (
          <ProblemRowView entry={entry} key={entry.key} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

function ProblemRowView({
  entry,
  onNavigate,
}: {
  entry: ProblemEntry;
  onNavigate(target: ProblemTarget, location: string): void;
}) {
  const { t } = useI18n();
  const go = () => onNavigate(entry.target, entry.location);
  const goFromRow = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, .output-source[data-overflowing="true"]'))
      return;
    if (window.getSelection()?.toString()) return;
    go();
  };
  return (
    <div
      className="output-row problems-row"
      data-code={entry.message.code}
      data-severity={entry.severity}
      onClick={goFromRow}
      role="listitem"
    >
      <Button
        aria-label={t('problems-panel.row.go-to', { location: entry.location })}
        className="output-time problems-position"
        onClick={go}
        size="xs"
        title={t('problems-panel.row.go-to', { location: entry.location })}
        variant="ghost"
      >
        {entry.position}
      </Button>
      <OutputSource name={t(severityWords[entry.severity])} />
      <OutputMessageText message={entry.message} noteDetails repeat={entry.count} />
    </div>
  );
}
