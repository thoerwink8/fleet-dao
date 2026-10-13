// 首页看板右侧的详情：单击卡片打开（初版 PR #13 的样子：从右边滑进来、浮在画布上）。
// 单子：在哪一段、谁在做、在等什么、本段和总耗时、要你拍的、最近一次事件，底下「打开单子详情」进站内详情页。
// 三段：这一段干什么、平均耗时、在途的单（点了跳到那张卡）。引擎：各色几张、引擎和项目。
import { ArrowUpRight, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { formatAgo, formatDuration } from '../../../lib/format';
import { useNow } from '../../../lib/hooks';
import type { Tone } from '../../../lib/status';
import { cn } from '../../../lib/utils';
import { StatusBadge, StatusDot } from '../../layout/status-badge';
import { inkClass } from '../../layout/tone';
import { ActionButtons } from '../../task-actions';
import { Button } from '../../ui/button';
import type { TicketUsage } from '../resources';
import { CardLink, needsFounder, statusTextOf, WAIT_LABEL } from '../running-card';
import type { HomeRunning } from '../types';
import { targetOfItem, useBoardUi } from './board-ui';
import {
  type BoardNodeData,
  compareTickets,
  isNeedsYou,
  isStuck,
  nodeId,
  phasesOf,
  segmentKeyOf,
  ticketTone,
} from './model';
import { avgText, segmentHintOf, segmentName } from './nodes';
import { UsageLine, usageTitle } from './usage';

export function DetailPanel({
  data,
  running,
  onClose,
  onSelect,
}: {
  data: BoardNodeData;
  /** 全部在跑的单（三段、引擎详情里列单子用；不受过滤影响）。 */
  running: readonly HomeRunning[];
  onClose(): void;
  onSelect(nodeId: string): void;
}) {
  const item = data.kind === 'ticket' || data.kind === 'ask' ? data.item : undefined;
  return (
    <motion.aside
      key="detail"
      initial={{ opacity: 0, x: 28 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 28 }}
      transition={{ type: 'spring', stiffness: 420, damping: 38 }}
      className="absolute top-14 right-3 bottom-3 z-20 flex w-98 max-w-full flex-col overflow-hidden rounded-lg border bg-popover shadow-overlay backdrop-blur-xl"
      aria-label="详情"
      data-board-detail
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-4">
          {item ? (
            <TicketPanel
              item={item}
              usage={data.kind === 'ticket' ? data.usage : undefined}
              onClose={onClose}
            />
          ) : null}
          {data.kind === 'segment' ? (
            <SegmentPanel data={data} running={running} onClose={onClose} onSelect={onSelect} />
          ) : null}
          {data.kind === 'root' ? (
            <RootPanel data={data} running={running} onClose={onClose} onSelect={onSelect} />
          ) : null}
        </div>
      </div>
      {item ? (
        <footer className="flex items-center justify-between gap-2 border-t bg-muted px-4 py-2.5">
          <span className="text-meta text-muted-foreground">
            双击卡片或按 <kbd className="num">O</kbd> 进单子详情
          </span>
          <Button asChild size="sm" variant="secondary">
            <CardLink item={item} className="">
              打开单子详情
              <ArrowUpRight />
            </CardLink>
          </Button>
        </footer>
      ) : null}
    </motion.aside>
  );
}

function Head({ children, onClose }: { children: ReactNode; onClose(): void }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      <Button size="icon" variant="ghost" className="ml-auto size-7" onClick={onClose} aria-label="关闭详情">
        <X />
      </Button>
    </div>
  );
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-5', className)}>
      <h3 className="mb-2 text-meta font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 text-body">
      <span className="w-14 shrink-0 text-meta text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function since(iso: string | undefined, now: number): string | undefined {
  return iso ? formatDuration(Math.max(0, now - Date.parse(iso))) : undefined;
}

function TicketPanel({
  item,
  usage,
  onClose,
}: {
  item: HomeRunning;
  /** 这张单此刻占的内存、CPU（#1973）；从「要你拍」那片打开时没有。 */
  usage?: TicketUsage | undefined;
  onClose(): void;
}) {
  const now = useNow();
  const ui = useBoardUi();
  const tone = ticketTone(item);
  const target = targetOfItem(item, ui.remote);
  const founder = needsFounder(item);
  return (
    <div>
      <Head onClose={onClose}>
        <span className="num text-body font-semibold text-muted-foreground">#{item.issueNumber}</span>
        <StatusBadge tone={tone} label={statusTextOf(item)} />
      </Head>
      <h2 className="mt-2 text-heading leading-snug font-semibold">{item.title}</h2>
      <p className="num mt-1 text-meta text-muted-foreground">{item.repo}</p>
      {/* 操作行右边没有别的东西，共用的那根「叫停与右侧按钮之间」的竖线和间距在这里不要（它会孤零零立在行尾，#1819） */}
      {target ? <ActionButtons target={target} className="mt-3 mr-0 border-r-0 pr-0" /> : null}

      {founder && item.pendingDecision ? (
        <Section title="要你拍">
          <div className="rounded-lg border border-st-human-line bg-st-human-soft px-3 py-2 text-body">
            {item.pendingDecision}
            <div className="mt-1 text-meta text-muted-foreground">
              {ui.remote ? (
                '要去那台上的通知中心答。'
              ) : (
                <Link to="/notifications" className="underline underline-offset-2">
                  去通知中心答
                </Link>
              )}
            </div>
          </div>
        </Section>
      ) : null}

      {item.waitingReason === 'parked' ? (
        <Section title="停下等人">
          <div
            className="rounded-lg border border-st-human-line bg-st-human-soft px-3 py-2 text-body break-words"
            data-parked-why
          >
            {item.parked ?? '引擎没写停下的原因'}
            <div className="mt-1 text-meta text-muted-foreground">
              看过之后点上面的「继续」接着做，「放弃」不做了，「重做」从头再来。
            </div>
          </div>
        </Section>
      ) : null}

      <Section title="现在">
        <div className="space-y-1.5">
          <Row label="在哪一段">
            <span className={cn('font-medium', inkClass[tone])}>{statusTextOf(item)}</span>
          </Row>
          <Row label="谁在做">
            {item.worker ? (
              <span className="num">{item.worker}</span>
            ) : (
              <span className="text-muted-foreground">没有进程在跑</span>
            )}
          </Row>
          <Row label="在等">
            {item.waitingReason === 'nothing' ? (
              <span className="text-muted-foreground">没在等，正常往前走</span>
            ) : (
              <>
                {WAIT_LABEL[item.waitingReason]}
                {item.waitingSince ? (
                  <span className="num whitespace-nowrap text-muted-foreground">
                    {' · 已 '}
                    {since(item.waitingSince, now)}
                  </span>
                ) : null}
              </>
            )}
          </Row>
          {usage ? (
            <Row label="占用">
              <span className="flex flex-col gap-0.5">
                <UsageLine usage={usage} size="meta" />
                {usage.kind === 'idle' && !usage.last ? null : (
                  <span className="text-meta text-muted-foreground">{usageTitle(usage)}</span>
                )}
              </span>
            </Row>
          ) : null}
          <Row label="本段">
            <span className="num whitespace-nowrap">{since(item.stageSince, now) ?? '—'}</span>
          </Row>
          <Row label="总共">
            <span className="num whitespace-nowrap">{since(item.taskSince, now) ?? '—'}</span>
          </Row>
        </div>
      </Section>

      <Section title="三段">
        <ol className="space-y-1.5">
          {phasesOf(item).map((p) => (
            <li key={p.key} className="flex items-center gap-2 text-body">
              <StatusDot tone={p.state === 'pending' ? 'wait' : p.tone} />
              <span
                className={cn('w-12 shrink-0', p.state === 'pending' ? 'text-muted-foreground' : undefined)}
              >
                {p.label}
              </span>
              <span className="text-meta text-muted-foreground">
                {p.state === 'done' ? '走过了' : p.state === 'active' ? '在这一段' : '还没到'}
              </span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="最近一次事件">
        {item.lastEvent ? (
          <p className={cn('text-body', item.lastEvent.tone === 'trouble' ? 'text-ink-fail' : undefined)}>
            {item.lastEvent.text}
            <span className="num ml-1 text-meta text-muted-foreground">
              · {formatAgo(item.lastEvent.at, now)}
            </span>
          </p>
        ) : (
          <p className="text-body text-muted-foreground">还没有三段流水记录</p>
        )}
      </Section>
    </div>
  );
}

/** 详情里列单子的一行：点了在画布上跳到那张卡。 */
function TicketButton({ item, onSelect }: { item: HomeRunning; onSelect(id: string): void }) {
  const tone: Tone = ticketTone(item);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(nodeId.ticket(item))}
        className="w-full rounded-lg border px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-accent"
      >
        <div className="flex items-center gap-2">
          <span className={cn('num text-meta font-semibold', inkClass[tone])}>#{item.issueNumber}</span>
          <span className="min-w-0 flex-1 truncate text-body font-medium">{item.title}</span>
          <StatusBadge tone={tone} label={statusTextOf(item)} />
        </div>
        <div className="mt-1 truncate text-meta text-muted-foreground">
          {item.worker ?? '没有进程在跑'}
          {item.waitingReason !== 'nothing' ? ` · ${WAIT_LABEL[item.waitingReason]}` : ''}
        </div>
      </button>
    </li>
  );
}

function SegmentPanel({
  data,
  running,
  onClose,
  onSelect,
}: {
  data: Extract<BoardNodeData, { kind: 'segment' }>;
  running: readonly HomeRunning[];
  onClose(): void;
  onSelect(id: string): void;
}) {
  const items = running.filter((r) => segmentKeyOf(r) === data.key).sort(compareTickets);
  return (
    <div>
      <Head onClose={onClose}>
        <span className="text-body font-semibold text-muted-foreground">流程里的一段</span>
      </Head>
      <h2 className="mt-2 text-heading leading-snug font-semibold">{segmentName(data.key)}</h2>
      <p className="mt-1 text-body text-muted-foreground">{segmentHintOf(data.key)}</p>
      <p className="num mt-1 text-meta text-muted-foreground">{avgText(data.stage, data.key)}</p>
      <Section title={`在途（${items.length}）`}>
        {items.length ? (
          <ul className="space-y-1.5">
            {items.map((it) => (
              <TicketButton key={nodeId.ticket(it)} item={it} onSelect={onSelect} />
            ))}
          </ul>
        ) : (
          <p className="text-meta text-muted-foreground">这一段现在没有单</p>
        )}
      </Section>
    </div>
  );
}

function RootPanel({
  data,
  running,
  onClose,
  onSelect,
}: {
  data: Extract<BoardNodeData, { kind: 'root' }>;
  running: readonly HomeRunning[];
  onClose(): void;
  onSelect(id: string): void;
}) {
  const c = data.counts;
  const waiting = running.filter(isNeedsYou).sort(compareTickets);
  const failed = running.filter(isStuck).sort(compareTickets);
  return (
    <div>
      <Head onClose={onClose}>
        <span className="text-body font-semibold text-muted-foreground">在跑的单</span>
      </Head>
      <p className="mt-3 text-body">
        <span className="num">{c.total}</span> 张：在跑 {c.run}，在等 {c.wait}，还没验 {c.stall}，等你{' '}
        {c.human}，出问题 {c.fail}。
      </p>
      {data.engine ? (
        <p className="mt-2 text-meta text-muted-foreground">
          引擎：
          {data.engine.state === 'on'
            ? '正常'
            : data.engine.state === 'off'
              ? '已停用'
              : data.engine.state === 'down'
                ? '没连上'
                : '没查成'}
          {data.engine.detail ? `（${data.engine.detail}）` : ''}
        </p>
      ) : null}
      {data.repos.length ? (
        <p className="num mt-1 text-meta text-muted-foreground">项目：{data.repos.join('、')}</p>
      ) : null}
      <Section title={`等你拍（${waiting.length}）`}>
        {waiting.length ? (
          <ul className="space-y-1.5">
            {waiting.map((it) => (
              <TicketButton key={nodeId.ticket(it)} item={it} onSelect={onSelect} />
            ))}
          </ul>
        ) : (
          <p className="text-meta text-muted-foreground">没有等你拍的单</p>
        )}
      </Section>
      <Section title={`出问题（${failed.length}）`}>
        {failed.length ? (
          <ul className="space-y-1.5">
            {failed.map((it) => (
              <TicketButton key={nodeId.ticket(it)} item={it} onSelect={onSelect} />
            ))}
          </ul>
        ) : (
          <p className="text-meta text-muted-foreground">没有出问题的单（不含等你）</p>
        )}
      </Section>
    </div>
  );
}
