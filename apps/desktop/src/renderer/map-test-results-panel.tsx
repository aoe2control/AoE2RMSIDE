import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { outputSourceLabel } from '../shared/output-message';
import type { MapTestResultsState } from './app-context';
import { useI18n } from './i18n';
import {
  findingCountsText,
  mapTestNoFindingsText,
  mapTestResultsModel,
  mapTestResultsNotice,
  mapTestRowsPerPage,
  type MapTestCheckGroup,
  type MapTestFindingEntry,
  type MapTestResultsOrigin,
} from './map-test-results-model';
import { useMapTestProgress, type MapTestProgressStore } from './map-test-progress';
import { OutputGroupHeader, OutputMessageText, OutputSeverityIcon } from './output-panel';
import { preventMultiClickSelection, usePlainClick } from './plain-click';

export function MapTestResultsPanel({
  results,
  origin,
  onExport,
  onGoToCheck,
  onReplay,
  progress,
}: {
  results: MapTestResultsState;
  origin: MapTestResultsOrigin;
  progress: MapTestProgressStore;
  onExport(): void;
  onGoToCheck(line: number, column: number): void;
  onReplay(findingId: string): void;
}) {
  const { t, translator } = useI18n();
  const model = useMemo(() => {
    void translator;
    return mapTestResultsModel(results.report);
  }, [results.report, translator]);
  const { summary, groups } = model;
  const running = useMapTestProgress(progress);
  const notice = mapTestResultsNotice({
    origin,
    imported: results.imported,
    scriptName: summary.scriptName,
    ...(running.phase === 'running'
      ? { progress: { completed: running.completed, requested: running.requested } }
      : {}),
  });
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [pages, setPages] = useState<ReadonlyMap<string, number>>(() => new Map());
  const list = useRef<HTMLDivElement>(null);
  const identity = `${results.imported ? 'imported' : 'run'}:${results.report.reportIdentity}`;
  const shownIdentity = useRef(identity);
  useEffect(() => {
    if (shownIdentity.current === identity) return;
    shownIdentity.current = identity;
    setClosed(new Set());
    setPages(new Map());
    if (list.current) list.current.scrollTop = 0;
  }, [identity]);
  const toggle = (key: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const showMore = (key: string) =>
    setPages((current) => new Map(current).set(key, (current.get(key) ?? 1) + 1));
  return (
    <div className="bottom-list-shell test-results-shell" onMouseDown={preventMultiClickSelection}>
      <div className="test-results-toolbar">
        <p className="test-results-summary" role="status">
          <span className="output-run-result" data-result={summary.status}>
            {summary.statusLabel}
          </span>{' '}
          {summary.testedMap
            ? t('test-results.results.summary.map', {
                script: summary.scriptName,
                map: summary.testedMap,
                facts: summary.facts,
              })
            : t('test-results.results.summary', {
                script: summary.scriptName,
                facts: summary.facts,
              })}
        </p>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className="test-results-export"
                onClick={onExport}
                size="xs"
                variant="ghost"
              />
            }
          >
            <Upload aria-hidden="true" /> {t('test-results.results.export')}
          </TooltipTrigger>
          <TooltipContent>{t('test-results.results.export-tooltip')}</TooltipContent>
        </Tooltip>
      </div>
      <div
        aria-label={t('test-results.results.list-label', { count: summary.findings })}
        className="output-log test-results-log owned-scrollbars"
        data-testid="test-results"
        ref={list}
      >
        {notice ? (
          <div
            className="output-row test-results-notice"
            data-code={notice.code}
            data-severity={notice.severity}
          >
            <OutputSeverityIcon
              severity={notice.severity}
              source={outputSourceLabel(notice.source)}
            />
            <OutputMessageText message={notice} repeat={1} />
          </div>
        ) : null}
        {groups.length === 0 ? (
          <p className="output-empty">{mapTestNoFindingsText(summary)}</p>
        ) : (
          groups.map((group) => (
            <CheckGroupView
              group={group}
              key={group.key}
              onGoToCheck={() => onGoToCheck(group.line, group.column)}
              mapShown={summary.testedMap !== null}
              onReplay={onReplay}
              onShowMore={() => showMore(group.key)}
              onToggle={() => toggle(group.key)}
              open={!closed.has(group.key)}
              pages={pages.get(group.key) ?? 1}
            />
          ))
        )}
      </div>
    </div>
  );
}

function CheckGroupView({
  group,
  mapShown,
  onGoToCheck,
  onReplay,
  onShowMore,
  onToggle,
  open,
  pages,
}: {
  group: MapTestCheckGroup;
  mapShown: boolean;
  onGoToCheck(): void;
  onReplay(findingId: string): void;
  onShowMore(): void;
  onToggle(): void;
  open: boolean;
  pages: number;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const rowsId = useId();
  const shown = group.entries.slice(0, pages * mapTestRowsPerPage);
  const hidden = group.entries.length - shown.length;
  return (
    <div
      aria-labelledby={titleId}
      className="output-group test-results-group"
      data-check={group.position}
      data-open={open ? 'true' : 'false'}
      role="group"
    >
      <OutputGroupHeader
        end={
          <Button
            aria-label={t('test-results.results.go-to-check', { location: group.location })}
            className="output-row-end problems-position"
            onClick={onGoToCheck}
            size="xs"
            title={t('test-results.results.go-to-check', { location: group.location })}
            variant="ghost"
          >
            {group.position}
          </Button>
        }
        icon={
          <OutputSeverityIcon severity="error" source={t('test-results.results.check-source')} />
        }
        onToggle={onToggle}
        open={open}
        rowsId={rowsId}
        title={
          <>
            <span className="output-group-name">{group.headline}</span>
            {' · '}
            <span className="output-group-counts">
              {findingCountsText(group.findings, group.seeds)}
            </span>
          </>
        }
        titleId={titleId}
        toggleLabel={
          open
            ? t('test-results.results.hide-check-findings', { line: group.line })
            : t('test-results.results.show-check-findings', { line: group.line })
        }
        tooltip={group.location}
      />
      <div
        aria-label={t('test-results.results.check-findings', { line: group.line })}
        className="output-group-rows"
        hidden={!open}
        id={rowsId}
        role="list"
      >
        {shown.map((entry) => (
          <FindingRowView
            entry={entry}
            key={entry.key}
            mapShown={mapShown}
            onReplay={onReplay}
            repeatsCheck={group.messageShown && entry.message.headline === group.headline}
          />
        ))}
        {hidden > 0 ? (
          <div className="output-dropped test-results-more" role="listitem">
            <Button
              className="test-results-more-button"
              onClick={onShowMore}
              size="xs"
              variant="ghost"
            >
              {t('test-results.results.show-more', { count: Math.min(hidden, mapTestRowsPerPage) })}
            </Button>
            <span>{t('test-results.results.not-shown', { count: hidden })}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FindingRowView({
  entry,
  mapShown,
  onReplay,
  repeatsCheck,
}: {
  entry: MapTestFindingEntry;
  mapShown: boolean;
  repeatsCheck: boolean;
  onReplay(findingId: string): void;
}) {
  const { t } = useI18n();
  const replay = () => onReplay(entry.findingId);
  const click = usePlainClick(replay);
  const label = t('test-results.results.show-seed', { seed: entry.seed, map: entry.mapName });
  return (
    <div
      className="output-row test-results-row"
      data-code={entry.message.code}
      data-repeats-check={repeatsCheck ? 'true' : undefined}
      data-seed={entry.seed}
      data-severity={entry.message.severity}
      onClick={click.onClick}
      onMouseDown={click.onMouseDown}
      role="listitem"
    >
      <OutputSeverityIcon
        severity={entry.message.severity}
        source={t('test-results.results.finding-source')}
      />
      <OutputMessageText message={entry.message} repeat={entry.count} />
      <span className="output-row-end test-results-finding-end">
        {mapShown ? null : (
          <span className="test-results-map" title={entry.mapPath}>
            {entry.mapName}
          </span>
        )}
        <Button
          aria-label={label}
          className="problems-position test-results-seed"
          onClick={replay}
          size="xs"
          title={label}
          variant="ghost"
        >
          {t('test-results.results.seed', { seed: entry.seed })}
        </Button>
      </span>
    </div>
  );
}
