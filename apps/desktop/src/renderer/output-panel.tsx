import { Fragment, memo, useId, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  externalLinkUrls,
  type ExternalLinkTarget,
  type PreviewProvenanceOperation,
} from '../shared/api';
import { englishTranslator } from '../shared/i18n/translator';
import { documentName, outputPartWording, rewordOutputMessage } from '../shared/message-catalog';
import {
  outputSourceLabel,
  sentence,
  type OutputMessage,
  type OutputSeverity,
} from '../shared/output-message';
import { refusalOperation } from '../shared/refusal-location';
import {
  filterOutputEntries,
  formatOutputTime,
  outputGroupOpen,
  outputMessageCount,
  outputRunConstructNote,
  outputRunFacts,
  outputRunResultLabel,
  type OutputGroup,
  type OutputLogState,
  type OutputRow,
  type OutputRunHeader,
  type OutputRunResult,
} from './output-log';
import { useFollowBottom, type FollowState } from './follow-bottom';
import { useI18n } from './i18n';
import { preventMultiClickSelection, usePlainClick } from './plain-click';
import type { SeverityFilter } from './severity-filter';
import { severityIcons } from './severity-filter-toggles';
import { UpdateNoteAction } from './update-control';

const releaseAvailableCode = 'update.release-available';

export const OutputPanel = memo(function OutputPanel({
  filter,
  state,
  onNavigateOperation,
  onToggleGroup,
}: {
  filter: SeverityFilter;
  state: OutputLogState;
  onNavigateOperation?(operation: PreviewProvenanceOperation): void;
  onToggleGroup(groupId: string): void;
}) {
  const { t } = useI18n();
  const count = outputMessageCount(state);
  const entries = filterOutputEntries(state, filter);
  const follow = useFollowBottom(count, entries);
  return (
    <div className="bottom-list-shell" onMouseDown={preventMultiClickSelection}>
      <div
        aria-label={t('output.log.label', { count })}
        aria-live="polite"
        className="output-log owned-scrollbars"
        data-follow={follow.state.pinned ? 'pinned' : 'free'}
        data-testid="output"
        onScroll={follow.onScroll}
        ref={follow.ref}
        role="log"
      >
        {state.entries.length === 0 ? (
          <p className="output-empty">{t('output.empty')}</p>
        ) : entries.length === 0 ? (
          <p className="output-empty">{t('output.empty.filtered')}</p>
        ) : (
          entries.map((entry) =>
            entry.kind === 'row' ? (
              <OutputRowView
                key={`row-${entry.row.id}`}
                onNavigateOperation={onNavigateOperation}
                row={entry.row}
              />
            ) : (
              <OutputGroupView
                group={entry}
                key={`run-${entry.id}`}
                {...(onNavigateOperation ? { onNavigateOperation } : {})}
                onToggleGroup={onToggleGroup}
                open={outputGroupOpen(state, entry.id)}
              />
            ),
          )
        )}
      </div>
      <JumpToLatest follow={follow} />
    </div>
  );
});

export function JumpToLatest({ follow }: { follow: { state: FollowState; jumpToLatest(): void } }) {
  const { t } = useI18n();
  if (follow.state.pinned || follow.state.unseen === 0) return null;
  return (
    <Button
      className="bottom-list-jump"
      onClick={follow.jumpToLatest}
      size="xs"
      variant="secondary"
    >
      <ArrowDown aria-hidden="true" />
      {t('output.jump-to-latest', { count: follow.state.unseen })}
    </Button>
  );
}

function OutputTime({ time }: { time: number }) {
  return (
    <time className="output-time output-row-end" dateTime={new Date(time).toISOString()}>
      {formatOutputTime(time)}
    </time>
  );
}

export function OutputSeverityIcon({
  severity,
  source,
}: {
  severity: OutputSeverity;
  source: string;
}) {
  const Icon = severityIcons[severity];
  return (
    <Tooltip disableHoverablePopup>
      <TooltipTrigger render={<span className="output-severity" data-severity={severity} />}>
        <Icon aria-hidden="true" />
        <span className="output-source sr-only">{source}</span>
      </TooltipTrigger>
      <TooltipContent>{source}</TooltipContent>
    </Tooltip>
  );
}

export function OutputGroupHeader({
  end,
  expandable = true,
  icon,
  onToggle,
  open,
  rowsId,
  title,
  titleId,
  toggleLabel,
  tooltip,
}: {
  end?: ReactNode;
  expandable?: boolean;
  icon: ReactNode;
  onToggle(): void;
  open: boolean;
  rowsId: string;
  title: ReactNode;
  titleId: string;
  toggleLabel: string;
  tooltip?: string;
}) {
  const click = usePlainClick(() => {
    if (expandable) onToggle();
  });
  return (
    <div
      className="output-row output-group-header"
      data-expandable={expandable ? 'true' : 'false'}
      onClick={click.onClick}
      onMouseDown={click.onMouseDown}
    >
      <span className="output-group-toggle-cell">
        {expandable ? (
          <Button
            aria-controls={rowsId}
            aria-expanded={open}
            aria-label={toggleLabel}
            className="output-group-toggle"
            onClick={onToggle}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronRight aria-hidden="true" className="output-chevron" />
          </Button>
        ) : null}
      </span>
      {icon}
      <div className="output-text">
        <p className="output-headline output-group-title">
          {tooltip ? (
            <Tooltip disableHoverablePopup>
              <TooltipTrigger render={<span id={titleId} />}>{title}</TooltipTrigger>
              <TooltipContent align="start" className="path-tooltip">
                {tooltip}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span id={titleId}>{title}</span>
          )}
        </p>
      </div>
      {end}
    </div>
  );
}

const runStatusIcons: Readonly<Record<OutputRunResult, LucideIcon>> = {
  exact: CircleCheck,
  synthetic: CircleCheck,
  unchanged: CircleCheck,
  passed: CircleCheck,
  failed: CircleX,
  'test-failed': CircleX,
  'test-warnings': TriangleAlert,
  stopped: CircleMinus,
};

function OutputRunStatusIcon({ header }: { header: OutputRunHeader }) {
  const Icon = runStatusIcons[header.result];
  const source = outputSourceLabel(
    header.kind === 'map-test'
      ? 'Map test'
      : header.kind === 'quality-check'
        ? 'Quality check'
        : 'Run',
  );
  return (
    <Tooltip disableHoverablePopup>
      <TooltipTrigger
        render={<span className="output-severity output-run-status" data-result={header.result} />}
      >
        <Icon aria-hidden="true" />
        <span className="output-source sr-only">{source}</span>
      </TooltipTrigger>
      <TooltipContent>{source}</TooltipContent>
    </Tooltip>
  );
}

const openOutputDetails = new WeakSet<OutputMessage>();

const OutputRowView = memo(function OutputRowView({
  child = false,
  onNavigateOperation,
  row,
}: {
  child?: boolean;
  onNavigateOperation?: ((operation: PreviewProvenanceOperation) => void) | undefined;
  row: OutputRow;
}) {
  const { t } = useI18n();
  const { message } = row;
  const target = onNavigateOperation ? message.target : undefined;
  const go = () => {
    if (target) onNavigateOperation?.(refusalOperation(message.code, target));
  };
  const click = usePlainClick(go);
  const goTo = target
    ? t('output.row.go-to', {
        location: t('message.format.file-line', {
          name: documentName(target.sourceId),
          line: target.line,
        }),
      })
    : null;
  const position = target ? (
    <Tooltip disableHoverablePopup>
      <TooltipTrigger
        render={
          <Button
            aria-label={goTo!}
            className={`problems-position${child ? ' output-row-end' : ''}`}
            onClick={go}
            size="xs"
            variant="ghost"
          />
        }
      >
        {`${target.line}:${target.column}`}
      </TooltipTrigger>
      <TooltipContent>{goTo}</TooltipContent>
    </Tooltip>
  ) : null;
  return (
    <div
      className="output-row"
      data-code={message.code}
      data-goes-to={target ? 'true' : undefined}
      data-monospace={message.monospace ? 'true' : undefined}
      data-severity={message.severity}
      data-source={message.source}
      onClick={target ? click.onClick : undefined}
      onMouseDown={target ? click.onMouseDown : undefined}
    >
      <OutputSeverityIcon severity={message.severity} source={outputSourceLabel(message.source)} />
      <OutputMessageText
        detailsMemory={openOutputDetails}
        message={message}
        noteDetails={message.source === 'XS'}
        repeat={row.repeat}
      />
      {child ? (
        position
      ) : position ? (
        <span className="output-row-end output-row-ends">
          {position}
          <OutputTime time={row.time} />
        </span>
      ) : (
        <OutputTime time={row.time} />
      )}
    </div>
  );
});

export function OutputMessageText({
  detailsMemory,
  message: shown,
  noteDetails = false,
  repeat,
}: {
  detailsMemory?: WeakSet<OutputMessage>;
  message: OutputMessage;
  noteDetails?: boolean;
  repeat: number;
}) {
  const { t, translator } = useI18n();
  const message = rewordOutputMessage(shown);
  const partTranslator = (part: 'cause' | 'action') =>
    outputPartWording(shown, part) === 'interface' ? translator : englishTranslator;
  const [detailsOpen, setDetailsOpen] = useState(() => detailsMemory?.has(shown) ?? false);
  const detailsId = useId();
  const hasDetails =
    message.severity === 'info'
      ? noteDetails && Boolean(message.detail)
      : Boolean(message.detail) || reportableCode(message.code);
  return (
    <div className="output-text">
      <p className="output-headline">
        <span data-wording={outputPartWording(shown, 'headline')}>
          <LinkedText text={message.headline} />
        </span>
        {repeat > 1 ? (
          <Tooltip disableHoverablePopup>
            <TooltipTrigger render={<span className="output-repeat" />}>
              {' '}
              {t('output.repeat', { count: repeat })}
            </TooltipTrigger>
            <TooltipContent>{t('output.repeat.tooltip', { count: repeat })}</TooltipContent>
          </Tooltip>
        ) : null}
      </p>
      {message.cause || message.action ? (
        <p className="output-cause">
          {message.cause ? (
            <span data-wording={outputPartWording(shown, 'cause')}>
              <LinkedText text={sentence(message.cause, partTranslator('cause'))} />
            </span>
          ) : null}
          {message.cause && message.action ? ' ' : null}
          {message.action ? (
            <span data-wording={outputPartWording(shown, 'action')}>
              <OutputActionView action={message.action} translator={partTranslator('action')} />
            </span>
          ) : null}
          {shown.code === releaseAvailableCode ? <UpdateNoteAction /> : null}
        </p>
      ) : null}
      {hasDetails ? (
        <>
          <Button
            aria-controls={detailsId}
            aria-expanded={detailsOpen}
            className="output-details-toggle"
            onClick={() => {
              const next = !detailsOpen;
              if (next) detailsMemory?.add(shown);
              else detailsMemory?.delete(shown);
              setDetailsOpen(next);
            }}
            size="xs"
            variant="ghost"
          >
            <ChevronRight aria-hidden="true" className="output-chevron" />
            {t('output.details')}
          </Button>
          <div className="output-details" hidden={!detailsOpen} id={detailsId}>
            <span className="output-details-code" data-wording="as-written">
              {message.code}
            </span>
            {message.detail ? (
              <pre className="output-details-raw" data-wording="as-written">
                {message.detail}
              </pre>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function reportableCode(code: string): boolean {
  return /^(?:RMS(?:GEN|XS)?\d|XS\d|(?:protocol|jsonrpc|control|deploy|content)\.)/u.test(code);
}

function OutputActionView({
  action,
  translator,
}: {
  action: NonNullable<OutputMessage['action']>;
  translator: Parameters<typeof sentence>[1];
}) {
  if (action.link) {
    return (
      <ExternalLink className="output-action" target={action.link}>
        {action.label}
      </ExternalLink>
    );
  }
  return <span className="output-action">{sentence(action.label, translator)}</span>;
}

function ExternalLink({
  children,
  className,
  target,
}: {
  children: string;
  className?: string;
  target: ExternalLinkTarget;
}) {
  const url = externalLinkUrls[target];
  const link = (
    <Button
      className={`output-link h-auto${className ? ` ${className}` : ''}`}
      onClick={() => void window.rmside.openExternalLink(target).catch(() => undefined)}
      role="link"
      type="button"
      variant="link"
    />
  );
  return (
    <Tooltip disableHoverablePopup disabled={children === url}>
      <TooltipTrigger render={link}>{children}</TooltipTrigger>
      <TooltipContent className="path-tooltip">{url}</TooltipContent>
    </Tooltip>
  );
}

const linkTargets = Object.entries(externalLinkUrls) as Array<[ExternalLinkTarget, string]>;

function LinkedText({ text }: { text: string }) {
  for (const [target, url] of linkTargets) {
    const index = text.indexOf(url);
    if (index < 0) continue;
    return (
      <>
        <LinkedText text={text.slice(0, index)} />
        <ExternalLink target={target}>{url}</ExternalLink>
        <LinkedText text={text.slice(index + url.length)} />
      </>
    );
  }
  return text;
}

const OutputGroupView = memo(function OutputGroupView({
  group,
  onNavigateOperation,
  onToggleGroup,
  open,
}: {
  group: OutputGroup;
  onNavigateOperation?(operation: PreviewProvenanceOperation): void;
  onToggleGroup(groupId: string): void;
  open: boolean;
}) {
  const onToggle = () => onToggleGroup(group.id);
  const { t } = useI18n();
  const titleId = useId();
  const rowsId = useId();
  const { header } = group;
  const constructs = header.constructs;
  const expandable = group.rows.length > 0 || group.droppedRows > 0 || Boolean(constructs);
  const shownOpen = open && expandable;
  return (
    <div
      aria-labelledby={titleId}
      className="output-group output-run-group"
      data-open={shownOpen ? 'true' : 'false'}
      data-output-run={group.id}
      data-run-kind={header.kind}
      data-run-map-hash={header.mapHash}
      data-run-request-hash={header.requestHash}
      data-run-result={header.result}
      data-run-size={header.size}
      role="group"
    >
      <OutputGroupHeader
        end={<OutputTime time={group.time} />}
        expandable={expandable}
        icon={<OutputRunStatusIcon header={header} />}
        onToggle={onToggle}
        open={open}
        rowsId={rowsId}
        title={
          <>
            <span className="output-group-name">{header.script}</span>
            {shownOpen ? null : (
              <>
                {outputRunFacts(header).map((fact) => (
                  <Fragment key={fact.id}>
                    {' · '}
                    {fact.inline}
                  </Fragment>
                ))}
                {' · '}
                <OutputRunResultWords header={header} />
              </>
            )}
          </>
        }
        titleId={titleId}
        toggleLabel={open ? t('output.run.hide') : t('output.run.show')}
      />
      {expandable ? (
        <div className="output-group-rows" hidden={!open} id={rowsId}>
          {shownOpen ? (
            <>
              <OutputRunFactTable header={header} />
              {constructs ? (
                <OutputRunConstructList constructs={constructs} onNavigate={onNavigateOperation} />
              ) : null}
              {group.droppedRows > 0 ? (
                <p className="output-dropped">
                  {t('output.run.dropped', { count: group.droppedRows })}
                </p>
              ) : null}
              {group.rows.map((row) => (
                <OutputRowView
                  child
                  key={row.id}
                  onNavigateOperation={onNavigateOperation}
                  row={row}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

function OutputRunResultWords({ header }: { header: OutputRunHeader }) {
  const resultLabel = outputRunResultLabel(header);
  const constructNote = outputRunConstructNote(header);
  return (
    <>
      {resultLabel === null ? null : (
        <span className="output-run-result" data-result={header.result}>
          {resultLabel}
        </span>
      )}
      {resultLabel !== null && constructNote ? ' · ' : null}
      {constructNote ? <span className="output-run-constructs">{constructNote}</span> : null}
    </>
  );
}

function OutputRunFactTable({ header }: { header: OutputRunHeader }) {
  const { t } = useI18n();
  return (
    <dl className="output-run-facts">
      {outputRunFacts(header).map((fact) => (
        <Fragment key={fact.id}>
          <dt data-fact={fact.id}>{fact.label}</dt>
          <dd data-fact={fact.id}>{fact.value}</dd>
        </Fragment>
      ))}
      <dt data-fact="result">{t('output.run.fact.result')}</dt>
      <dd data-fact="result">
        <OutputRunResultWords header={header} />
      </dd>
    </dl>
  );
}

function OutputRunConstructList({
  constructs,
  onNavigate,
}: {
  constructs: NonNullable<OutputGroup['header']['constructs']>;
  onNavigate: ((operation: PreviewProvenanceOperation) => void) | undefined;
}) {
  const { t } = useI18n();
  return (
    <div className="output-run-construct-row">
      <div className="output-text">
        <p className="output-headline">{t('output.constructs.heading')}</p>
        <ul aria-label={t('output.constructs.label')} className="output-run-constructs-list">
          {constructs.items.map((item) => (
            <li key={item.label}>
              <Tooltip disableHoverablePopup disabled={!onNavigate}>
                <TooltipTrigger
                  render={
                    <Button
                      className="output-run-construct h-auto"
                      disabled={!onNavigate}
                      onClick={() => onNavigate?.(item.operation)}
                      type="button"
                      variant="link"
                    />
                  }
                >
                  {item.label}
                </TooltipTrigger>
                <TooltipContent>{t('output.constructs.go-to')}</TooltipContent>
              </Tooltip>
            </li>
          ))}
          {constructs.omitted > 0 ? (
            <li className="output-run-construct-more">
              {t('output.constructs.more', { count: constructs.omitted })}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
