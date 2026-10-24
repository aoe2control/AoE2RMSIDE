import { memo, useCallback, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { MessageId } from '../shared/i18n/translator';
import type { OutputMessage, OutputSeverity } from '../shared/output-message';
import { useFollowBottom } from './follow-bottom';
import { useI18n } from './i18n';
import {
  JumpToLatest,
  OutputGroupHeader,
  OutputMessageText,
  OutputSeverityIcon,
} from './output-panel';
import { preventMultiClickSelection, usePlainClick } from './plain-click';
import {
  filterProblemGroups,
  type ProblemEntry,
  type ProblemFileGroup,
  type ProblemTarget,
} from './problems-model';
import { useProblemRowWindow, type ProblemRowWindow, type WindowGroup } from './problems-window';
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

function worstSeverity(group: ProblemFileGroup): OutputSeverity {
  return group.counts.error > 0 ? 'error' : group.counts.warning > 0 ? 'warning' : 'info';
}

export const ProblemsPanel = memo(function ProblemsPanel({
  filter,
  groups,
  onNavigate,
}: {
  filter: SeverityFilter;
  groups: readonly ProblemFileGroup[];
  onNavigate(target: ProblemTarget, location: string): void;
}) {
  const { t } = useI18n();
  const shown = useMemo(() => filterProblemGroups(groups, filter), [groups, filter]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [openDetails] = useState(() => new WeakSet<OutputMessage>());
  const rows = shown.reduce((total, group) => total + group.entries.length, 0);
  const follow = useFollowBottom(rows, shown);
  const windowGroups = useMemo<WindowGroup[]>(
    () =>
      shown.map((group) => ({
        uri: group.uri,
        keys: group.entries.map((entry) => entry.key),
        open: !closed.has(group.uri),
      })),
    [closed, shown],
  );
  const rowWindow = useProblemRowWindow(windowGroups, follow);
  const followRef = follow.ref;
  const windowRef = rowWindow.listRef;
  const listRef = useCallback(
    (element: HTMLDivElement | null) => {
      followRef(element);
      windowRef(element);
    },
    [followRef, windowRef],
  );
  const hidden = groups.reduce((total, group) => total + group.entries.length, 0) - rows;
  const toggle = (uri: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  return (
    <div className="bottom-list-shell" onMouseDown={preventMultiClickSelection}>
      <div
        aria-label={t('problems-panel.log.label', { count: rows })}
        className="output-log problems-log owned-scrollbars"
        data-follow={follow.state.pinned ? 'pinned' : 'free'}
        data-testid="problems"
        onBlur={(event) => rowWindow.onBlur(event.relatedTarget)}
        onFocus={(event) => rowWindow.onFocus(event.target)}
        onScroll={() => {
          follow.onScroll();
          rowWindow.onScroll();
        }}
        ref={listRef}
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
              openDetails={openDetails}
              rowWindow={rowWindow}
              total={groups.find((candidate) => candidate.uri === group.uri) ?? group}
            />
          ))
        )}
      </div>
      <JumpToLatest follow={follow} />
    </div>
  );
});

function ProblemGroupView({
  group,
  onNavigate,
  onToggle,
  open,
  openDetails,
  rowWindow,
  total,
}: {
  group: ProblemFileGroup;
  onNavigate(target: ProblemTarget, location: string): void;
  onToggle(): void;
  open: boolean;
  openDetails: WeakSet<OutputMessage>;
  rowWindow: ProblemRowWindow;
  total: ProblemFileGroup;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const rowsId = useId();
  const { containerRef } = rowWindow;
  const rowsRef = useCallback(
    (element: HTMLDivElement | null) => containerRef(group.uri, element),
    [containerRef, group.uri],
  );
  const setSize = group.entries.length;
  return (
    <div
      aria-labelledby={titleId}
      className="output-group problems-group"
      data-file={group.name}
      data-open={open ? 'true' : 'false'}
      data-problem-group={group.uri}
      data-protected={group.protected ? 'true' : 'false'}
      role="group"
    >
      <OutputGroupHeader
        icon={
          <OutputSeverityIcon
            severity={worstSeverity(total)}
            source={
              group.protected ? t('problems-panel.group.game-file') : t('problems-panel.group.file')
            }
          />
        }
        onToggle={onToggle}
        open={open}
        rowsId={rowsId}
        title={
          <>
            <span className="output-group-name">{group.name}</span>
            {' · '}
            <span className="output-group-counts">{countsText(total, t)}</span>
          </>
        }
        titleId={titleId}
        toggleLabel={
          open
            ? t('problems-panel.group.hide', { file: group.name })
            : t('problems-panel.group.show', { file: group.name })
        }
        tooltip={group.path}
      />
      <div
        aria-label={t('problems-panel.group.label', { file: group.name })}
        className="output-group-rows"
        hidden={!open}
        id={rowsId}
        ref={rowsRef}
        role="list"
      >
        {rowWindow
          .slots(group.uri)
          .flatMap((slot) =>
            slot.kind === 'gap' ? (
              <div
                aria-hidden="true"
                className="problems-gap"
                key={`gap-${slot.start}`}
                style={{ height: slot.height }}
              />
            ) : (
              group.entries
                .slice(slot.start, slot.end)
                .map((entry, offset) => (
                  <ProblemRowView
                    entry={entry}
                    key={entry.key}
                    measureRow={rowWindow.measureRow}
                    openDetails={openDetails}
                    onNavigate={onNavigate}
                    position={slot.start + offset + 1}
                    setSize={setSize}
                  />
                ))
            ),
          )}
      </div>
    </div>
  );
}

const ProblemRowView = memo(function ProblemRowView({
  entry,
  measureRow,
  onNavigate,
  openDetails,
  position,
  setSize,
}: {
  entry: ProblemEntry;
  measureRow: ProblemRowWindow['measureRow'];
  onNavigate(target: ProblemTarget, location: string): void;
  openDetails: WeakSet<OutputMessage>;
  position: number;
  setSize: number;
}) {
  const { t } = useI18n();
  const go = () => onNavigate(entry.target, entry.location);
  const click = usePlainClick(go);
  const key = entry.key;
  const measure = useCallback(
    (element: HTMLDivElement) => measureRow(key, element),
    [key, measureRow],
  );
  return (
    <div
      aria-posinset={position}
      aria-setsize={setSize}
      className="output-row problems-row"
      data-code={entry.message.code}
      data-severity={entry.severity}
      onClick={click.onClick}
      onMouseDown={click.onMouseDown}
      ref={measure}
      role="listitem"
    >
      <OutputSeverityIcon severity={entry.severity} source={t(severityWords[entry.severity])} />
      <OutputMessageText
        detailsMemory={openDetails}
        message={entry.message}
        noteDetails
        repeat={entry.count}
      />
      <Tooltip disableHoverablePopup>
        <TooltipTrigger
          render={
            <Button
              aria-label={t('problems-panel.row.go-to', { location: entry.location })}
              className="output-row-end problems-position"
              onClick={go}
              size="xs"
              variant="ghost"
            />
          }
        >
          {entry.position}
        </TooltipTrigger>
        <TooltipContent>
          {t('problems-panel.row.go-to', { location: entry.location })}
        </TooltipContent>
      </Tooltip>
    </div>
  );
});
