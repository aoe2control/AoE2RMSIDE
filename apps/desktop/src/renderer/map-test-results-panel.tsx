import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { outputSourceLabel, wordOutputText, type OutputText } from '../shared/output-message';
import type { MapTestResultsState } from './app-context';
import { useI18n } from './i18n';
import {
  findingCountsText,
  mapTestNoFindingsText,
  mapTestResultsModel,
  mapTestResultsNotice,
  mapTestRowsPerPage,
  type MapTestCheckGroup,
  type MapTestCrashGroup,
  type MapTestFindingEntry,
  type MapTestResultsOrigin,
} from './map-test-results-model';
import { useMapTestProgress, type MapTestProgressStore } from './map-test-progress';
import { OutputGroupHeader, OutputMessageText, OutputSeverityIcon } from './output-panel';
import { preventMultiClickSelection, usePlainClick } from './plain-click';
import {
  isQualityReport,
  qualityResultsModel,
  type QualityCaseGroup,
  type QualityItemEntry,
  type QualityResultsModel,
} from './quality-check-output';

export function MapTestResultsPanel(props: {
  results: MapTestResultsState;
  origin: MapTestResultsOrigin;
  progress: MapTestProgressStore;
  onExport(): void;
  onGoToCheck(line: number, column: number): void;
  onReplay(findingId: string): void;
}) {
  return isQualityReport(props.results.report) ? (
    <QualityResultsPanel {...props} />
  ) : (
    <CheckResultsPanel {...props} />
  );
}

function CheckResultsPanel({
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
  const { summary, groups, crashes } = model;
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
        {crashes ? (
          <CrashGroupView
            group={crashes}
            mapShown={
              summary.testedMap !== null &&
              crashes.entries.every((entry) => entry.mapName === summary.testedMap)
            }
            onToggle={() => toggle(crashGroupKey)}
            open={!closed.has(crashGroupKey)}
          />
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

const crashGroupKey = 'game-crashes';

function CrashGroupView({
  group,
  mapShown,
  onToggle,
  open,
}: {
  group: MapTestCrashGroup;
  mapShown: boolean;
  onToggle(): void;
  open: boolean;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const rowsId = useId();
  const title = t('test-results.crashes.title');
  return (
    <div
      aria-labelledby={titleId}
      className="output-group test-results-group"
      data-game-crashes="true"
      data-open={open ? 'true' : 'false'}
      role="group"
    >
      <OutputGroupHeader
        icon={<OutputSeverityIcon severity="error" source={t('test-results.crashes.source')} />}
        onToggle={onToggle}
        open={open}
        rowsId={rowsId}
        title={
          <>
            <span className="output-group-name">{title}</span>
            {' · '}
            <span className="output-group-counts">
              {t('test-results.crashes.maps', { maps: group.maps })}
            </span>
          </>
        }
        titleId={titleId}
        toggleLabel={open ? t('test-results.crashes.hide') : t('test-results.crashes.show')}
      />
      <div aria-label={title} className="output-group-rows" hidden={!open} id={rowsId} role="list">
        {group.entries.map((entry) => (
          <div
            className="output-row"
            data-code={entry.message.code}
            data-crash={entry.crashId}
            data-severity={entry.message.severity}
            key={entry.key}
            role="listitem"
          >
            <OutputSeverityIcon
              severity={entry.message.severity}
              source={t('test-results.crashes.source')}
            />
            <OutputMessageText message={entry.message} repeat={1} />
            <span className="output-row-end test-results-finding-end">
              {mapShown ? null : (
                <Tooltip disableHoverablePopup>
                  <TooltipTrigger render={<span className="test-results-map" />}>
                    {entry.mapName}
                  </TooltipTrigger>
                  <TooltipContent className="path-tooltip">{entry.mapPath}</TooltipContent>
                </Tooltip>
              )}
              {entry.seedsText ? (
                <Tooltip disableHoverablePopup>
                  <TooltipTrigger
                    render={
                      <span
                        className="test-results-map test-results-crash-seeds"
                        data-testid="test-results-crash-seeds"
                      />
                    }
                  >
                    {entry.seedsText}
                  </TooltipTrigger>
                  <TooltipContent className="path-tooltip">{entry.seedsText}</TooltipContent>
                </Tooltip>
              ) : null}
            </span>
          </div>
        ))}
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
          <Tooltip disableHoverablePopup>
            <TooltipTrigger
              render={
                <Button
                  aria-label={t('test-results.results.go-to-check', { location: group.location })}
                  className="output-row-end problems-position"
                  onClick={onGoToCheck}
                  size="xs"
                  variant="ghost"
                />
              }
            >
              {group.position}
            </TooltipTrigger>
            <TooltipContent>
              {t('test-results.results.go-to-check', { location: group.location })}
            </TooltipContent>
          </Tooltip>
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
          <Tooltip disableHoverablePopup>
            <TooltipTrigger render={<span className="test-results-map" />}>
              {entry.mapName}
            </TooltipTrigger>
            <TooltipContent className="path-tooltip">{entry.mapPath}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip disableHoverablePopup>
          <TooltipTrigger
            render={
              <Button
                aria-label={label}
                className="problems-position test-results-seed"
                onClick={replay}
                size="xs"
                variant="ghost"
              />
            }
          >
            {t('test-results.results.seed', { seed: entry.seed })}
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </span>
    </div>
  );
}

function QualityResultsPanel({
  results,
  onExport,
  onReplay,
}: {
  results: MapTestResultsState;
  onExport(): void;
  onReplay(findingId: string): void;
}) {
  const { t, translator } = useI18n();
  const report = results.report;
  const model = useMemo((): QualityResultsModel | null => {
    void translator;
    return isQualityReport(report) ? qualityResultsModel(report, results.scriptUri) : null;
  }, [report, results.scriptUri, translator]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const list = useRef<HTMLDivElement>(null);
  const identity = `${results.imported ? 'imported' : 'run'}:${report.reportIdentity}`;
  const shownIdentity = useRef(identity);
  useEffect(() => {
    if (shownIdentity.current === identity) return;
    shownIdentity.current = identity;
    setClosed(new Set());
    if (list.current) list.current.scrollTop = 0;
  }, [identity]);
  if (!model) return null;
  const toggle = (key: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const statusLabel =
    model.result === 'passed'
      ? t('test-results.results.status.passed')
      : model.result === 'warnings'
        ? t('run-menu.result.warnings')
        : t('test-results.results.status.failed');
  const status = model.result === 'warnings' ? 'test-warnings' : model.result;
  return (
    <div className="bottom-list-shell test-results-shell" onMouseDown={preventMultiClickSelection}>
      <div className="test-results-toolbar">
        <p className="test-results-summary" role="status">
          <span className="output-run-result" data-result={status}>
            {statusLabel}
          </span>{' '}
          {t('test-results.quality.summary', {
            map: model.mapName,
            facts: t('test-results.quality.facts', {
              maps: model.maps,
              failures: model.failures,
              warnings: model.warnings,
            }),
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
        aria-label={t('test-results.quality.list-label', { count: model.items })}
        className="output-log test-results-log owned-scrollbars"
        data-quality-check="true"
        data-testid="test-results"
        ref={list}
      >
        {model.groups.length === 0 ? (
          <p className="output-empty">
            {t('test-results.quality.no-findings', { maps: model.maps })}
          </p>
        ) : (
          model.groups.map((group) => (
            <QualityCaseGroupView
              group={group}
              key={group.key}
              mapName={model.mapName}
              onReplay={onReplay}
              onToggle={() => toggle(group.key)}
              open={!closed.has(group.key)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function caseTitleText(title: OutputText | string): string {
  return typeof title === 'string' ? title : wordOutputText(title);
}

function QualityCaseGroupView({
  group,
  mapName,
  onReplay,
  onToggle,
  open,
}: {
  group: QualityCaseGroup;
  mapName: string;
  onReplay(findingId: string): void;
  onToggle(): void;
  open: boolean;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const rowsId = useId();
  const title = caseTitleText(group.title);
  return (
    <div
      aria-labelledby={titleId}
      className="output-group test-results-group"
      data-open={open ? 'true' : 'false'}
      data-quality-case={group.caseId}
      role="group"
    >
      <OutputGroupHeader
        icon={
          <OutputSeverityIcon
            severity={group.severity}
            source={outputSourceLabel('Quality check')}
          />
        }
        onToggle={onToggle}
        open={open}
        rowsId={rowsId}
        title={
          <>
            <span className="output-group-name">{title}</span>
            {' · '}
            <span className="output-group-counts">
              {t('test-results.quality.findings', { count: group.entries.length })}
            </span>
          </>
        }
        titleId={titleId}
        toggleLabel={
          open
            ? t('test-results.quality.hide-case', { case: title })
            : t('test-results.quality.show-case', { case: title })
        }
      />
      <div
        aria-label={t('test-results.quality.case-findings', { case: title })}
        className="output-group-rows"
        hidden={!open}
        id={rowsId}
        role="list"
      >
        {group.entries.map((entry) => (
          <QualityItemRowView entry={entry} key={entry.key} mapName={mapName} onReplay={onReplay} />
        ))}
      </div>
    </div>
  );
}

function QualityItemRowView({
  entry,
  mapName,
  onReplay,
}: {
  entry: QualityItemEntry;
  mapName: string;
  onReplay(findingId: string): void;
}) {
  const { t } = useI18n();
  const first = entry.seeds.find((seed) => seed.findingId !== null)?.findingId ?? null;
  const click = usePlainClick(() => {
    if (first) onReplay(first);
  });
  return (
    <div
      className="output-row test-results-row"
      data-code={entry.message.code}
      data-severity={entry.message.severity}
      onClick={click.onClick}
      onMouseDown={click.onMouseDown}
      role="listitem"
    >
      <OutputSeverityIcon
        severity={entry.message.severity}
        source={outputSourceLabel('Quality check')}
      />
      <OutputMessageText message={entry.message} repeat={1} />
      <span className="output-row-end test-results-finding-end">
        {entry.seeds.map((seed) => {
          const label = t('test-results.results.show-seed', { seed: seed.seed, map: mapName });
          const text = t('test-results.results.seed', { seed: seed.seed });
          return seed.findingId ? (
            <Tooltip disableHoverablePopup key={seed.key}>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={label}
                    className="problems-position test-results-seed"
                    data-seed={seed.seed}
                    onClick={() => onReplay(seed.findingId!)}
                    size="xs"
                    variant="ghost"
                  />
                }
              >
                {text}
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="test-results-map" data-seed={seed.seed} key={seed.key}>
              {text}
            </span>
          );
        })}
      </span>
    </div>
  );
}
