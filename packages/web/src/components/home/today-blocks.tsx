// 主页三块（决定 0093）：要你拍的、在跑的、上线了的，按重要度从上到下，一件事一行。数据怎么挑写在 today.ts 文件头。
// - 要你拍的：一行写事、要定什么、推荐哪个、为什么，选项就是按钮，点一下就是拍板（和通知中心同一个接口）；
//   看门狗的卡没有选项，也不给「处理」（报警自己修、自己撤）：一行写谁在修、修了多久、开了多久，右边只留「看看」。
//   看远程环境时只读：按钮置灰、写去那台上答。
// - 在跑的：法国引擎的单和本机会话混在一起排，卡着的、等你的在前；一行写事、谁在做、进度、卡没卡。
//   引擎单有 flowMode 时标题旁标「全程」或「三段」；没有这个值不标。
// - 上线了的：最近 5 次切到法国的提交，一行一句改了什么，带上同一版还带的 PR。
import { ArrowRight, CheckCheck, CirclePlay, Rocket } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import {
  errorText,
  useAnswerNotification,
  useFranceReleasedCommits,
  useLocalSessions,
  useNotifications,
} from '../../api/client';
import type { Notification } from '../../api/types';
import { decisionToast } from '../../lib/decision-result';
import { formatAgo, formatDateTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { FlowModeTag } from '../flow-mode-tag';
import { EmptyState } from '../layout/empty-state';
import { List } from '../layout/list';
import { LoadError, LoadingRows } from '../layout/load-state';
import { Notice } from '../layout/notice';
import { Section } from '../layout/section';
import { StatusBadge } from '../layout/status-badge';
import { Button } from '../ui/button';
import {
  type AskItem,
  askItems,
  askLine,
  engineRow,
  localRows,
  NO_OPTIONS_TEXT,
  type RunRow,
  type ShippedRow,
  shippedRows,
  sortRunRows,
  watchdogRepair,
} from './today';
import type { HomeDecision, HomeDone, HomeRunning } from './types';

/** 区块标题：名字加灰色的条数。 */
function BlockTitle({ name, count }: { name: string; count?: number | undefined }) {
  return (
    <span className="flex items-baseline gap-2">
      {name}
      {count === undefined ? null : (
        <span className="num text-meta font-normal text-muted-foreground">{count}</span>
      )}
    </span>
  );
}

const rowCls = 'flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-4';

// —— 要你拍的 ——

function AskRow({
  item,
  now,
  answering,
  handlingProblem,
  onAnswer,
}: {
  item: AskItem;
  now: number;
  /** 正在答的那一条和点的哪一项。 */
  answering: { id: string; optionId: string } | undefined;
  /** 这一页谁在修没算成：为什么。有了也不拿「还没人接」顶。 */
  handlingProblem: string | undefined;
  onAnswer: (n: Notification, optionId: string) => void;
}) {
  const { n, kind } = item;
  const { question, pick, why } = askLine(n);
  const options = n.options ?? [];
  const busy = answering?.id === n.id;
  const recommendation = pick ? `推荐：${pick}。${why ?? ''}` : null;
  const failed = n.answer?.execution?.ok === false ? n.answer.execution.text : null;
  const repair = kind === 'watchdog' ? watchdogRepair(n, now, handlingProblem) : null;
  return (
    <li className={rowCls} data-ask-row={kind}>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <StatusBadge
            tone={kind === 'gate' ? 'human' : 'fail'}
            variant="dot"
            label={kind === 'gate' ? '要你拍' : '看门狗'}
          />
          <span className="min-w-0 truncate text-body font-medium" title={n.title}>
            {n.title}
          </span>
          <span
            className="num ml-auto shrink-0 text-meta text-muted-foreground"
            title={formatDateTime(n.createdAt)}
          >
            {formatAgo(n.createdAt, now)}
          </span>
        </p>
        {question !== n.title ? (
          <p className="mt-0.5 truncate text-meta text-muted-foreground" title={question} data-ask-question>
            {kind === 'gate' ? '要定：' : '怎么了：'}
            {question}
          </p>
        ) : null}
        {recommendation ? (
          <p className="mt-0.5 truncate text-meta text-muted-foreground" title={recommendation} data-ask-pick>
            推荐：<span className="font-medium text-foreground">{pick}</span>。{why}
          </p>
        ) : kind === 'gate' ? (
          <p className="mt-0.5 truncate text-meta text-muted-foreground" data-ask-pick>
            {NO_OPTIONS_TEXT}
          </p>
        ) : null}
        {repair ? (
          <p
            className="mt-0.5 truncate text-meta text-muted-foreground"
            title={repair.title}
            data-ask-repair={repair.state}
          >
            {repair.who ? (
              <>
                <span className="font-medium text-foreground">{repair.who}</span>
                {repair.text.slice(repair.who.length)}
              </>
            ) : (
              repair.text
            )}
          </p>
        ) : null}
        {failed ? (
          // 拍了但系统没做成（#2353）：原因写在这里，再点一次选项就是再拍
          <p className="mt-0.5 truncate text-meta text-ink-fail" title={failed} data-ask-failed>
            上次选「{n.answer?.text}」没做成：{failed}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2" data-ask-actions>
        {kind === 'gate' && options.length > 0
          ? options.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant={o.recommended ? 'brand' : 'outline'}
                title={o.detail}
                loading={busy && answering?.optionId === o.id}
                disabled={busy && answering?.optionId !== o.id}
                onClick={() => onAnswer(n, o.id)}
              >
                {o.label}
              </Button>
            ))
          : null}
        {kind === 'gate' && options.length === 0 ? (
          <Button asChild size="sm" variant="outline">
            <Link to="/notifications?level=decision">
              去回复
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        ) : null}
        {kind === 'watchdog' ? (
          <Button asChild size="sm" variant="ghost">
            <Link to={n.link ?? '/notifications'}>
              看看
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** 本台：读通知，点选项就是拍板。 */
export function AskBlock() {
  const now = useNow();
  const q = useNotifications('open');
  const answer = useAnswerNotification();
  const items = q.data ? askItems(q.data.items) : [];
  const onAnswer = (n: Notification, optionId: string) =>
    answer.mutate(
      { id: n.id, body: { optionId } },
      {
        onSuccess: (r) => {
          // 系统照着做的结果照实说（#2353）：没做成不弹成「都好了」，卡留着可以再选
          const t = decisionToast(r);
          toast[t.level](t.title, { description: t.description });
        },
        onError: (e) => toast.error('没记下', { description: errorText(e) }),
      },
    );
  const answering =
    answer.isPending && answer.variables && 'optionId' in answer.variables.body
      ? { id: answer.variables.id, optionId: String(answer.variables.body.optionId) }
      : undefined;
  return (
    <Section
      flush
      {...(items.length > 0 ? { tone: 'human' as const } : {})}
      data-home-block="ask"
      title={<BlockTitle name="要你拍的" count={q.data ? items.length : undefined} />}
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link to="/notifications">通知中心</Link>
        </Button>
      }
    >
      {q.error ? (
        <div className="p-4">
          <LoadError what="要你拍的" error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : !q.data ? (
        <div className="p-4">
          <LoadingRows rows={2} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState size="inline" icon={CheckCheck} title="没有要你拍的" />
      ) : (
        <List>
          {items.map((it) => (
            <AskRow
              key={it.n.id}
              item={it}
              now={now}
              answering={answering}
              handlingProblem={q.data.handlingProblem}
              onAnswer={onAnswer}
            />
          ))}
        </List>
      )}
      {q.data?.nextCursor ? (
        // 通知超过一页：这里只看了最近一页，照实说，不当成只有这些
        <p className="border-t px-4 py-2 text-meta text-muted-foreground" data-ask-more>
          待处理的通知超过 {q.data.items.length} 条，这里只看了最近的；
          <Link to="/notifications" className="underline underline-offset-2">
            去通知中心看全
          </Link>
        </p>
      ) : null}
    </Section>
  );
}

/** 看远程环境的快照：只读，答要去那台上答。 */
export function RemoteAskBlock({ decisions, machine }: { decisions: HomeDecision[]; machine: string }) {
  const now = useNow();
  return (
    <Section flush data-home-block="ask" title={<BlockTitle name="要你拍的" count={decisions.length} />}>
      {decisions.length === 0 ? (
        <EmptyState size="inline" icon={CheckCheck} title="没有要你拍的" />
      ) : (
        <List>
          {decisions.map((d) => (
            <li key={d.id} className={rowCls} data-ask-row="gate">
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                  <StatusBadge tone="human" variant="dot" label="要你拍" />
                  <span className="min-w-0 truncate text-body font-medium" title={d.title}>
                    {d.title}
                  </span>
                  <span className="num ml-auto shrink-0 text-meta text-muted-foreground">
                    {formatAgo(d.since, now)}
                  </span>
                </p>
                {d.context ? (
                  <p className="mt-0.5 truncate text-meta text-muted-foreground">{d.context}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col items-start gap-1 md:items-end">
                <Button size="sm" variant="outline" disabled data-remote-disabled>
                  去答
                </Button>
                <span className="text-meta text-muted-foreground">要去{machine}那台上答</span>
              </div>
            </li>
          ))}
        </List>
      )}
    </Section>
  );
}

// —— 在跑的 ——

function RunLine({ row }: { row: RunRow }) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-body font-medium" title={row.what}>
            {row.what}
          </span>
          <FlowModeTag mode={row.flowMode} />
        </p>
        <p className="truncate text-meta text-muted-foreground" title={`${row.who} · ${row.progress}`}>
          {row.who} · {row.progress}
        </p>
        {row.why ? (
          <p className="truncate text-meta text-muted-foreground" title={row.why} data-run-why>
            {row.why}
          </p>
        ) : null}
      </div>
      <StatusBadge tone={row.tone} label={row.stuck} className="self-start md:self-center" />
    </>
  );
  const cls = 'flex items-start gap-3 px-4 py-3 md:items-center';
  return (
    <li data-run-row={row.source} data-tone={row.tone}>
      {row.href && !row.external ? (
        <Link to={row.href} className={`${cls} hover:bg-accent`}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

function RunList({ rows, extra }: { rows: RunRow[]; extra?: ReactNode }) {
  return (
    <>
      {rows.length === 0 ? (
        <EmptyState size="inline" icon={CirclePlay} title="现在没有在跑的单" />
      ) : (
        <List>
          {sortRunRows(rows).map((r) => (
            <RunLine key={r.key} row={r} />
          ))}
        </List>
      )}
      {extra}
    </>
  );
}

/** 本台：法国引擎的单 + 本机会话。 */
export function RunBlock({ running }: { running: HomeRunning[] }) {
  const now = useNow();
  const local = useLocalSessions();
  const nodes = local.data?.nodes ?? [];
  const machineOf = (id: string) => nodes.find((n) => n.id === id)?.machine ?? undefined;
  const engine = running.map((r) => engineRow(r, now, { href: r.link, external: false }, machineOf));
  const lr = local.data ? localRows(local.data, now) : null;
  const rows = [...engine, ...(lr?.kind === 'rows' ? lr.rows : [])];
  const extra = local.error ? (
    <div className="border-t p-4">
      <LoadError what="本机会话" error={local.error} onRetry={() => void local.refetch()} />
    </div>
  ) : lr?.kind === 'rows' && lr.silent.length > 0 ? (
    <p
      className="border-t px-4 py-2 text-meta text-muted-foreground"
      data-run-local="silent"
      title={lr.silent.map((s) => `${s.machine}：${s.why}`).join('；')}
    >
      本机会话没上报（在做什么看不到，不当成没在做）：
      {lr.silent.map((s) => `${s.machine}${s.never ? '一次都没收到' : '上次收到的已过期'}`).join('；')}
    </p>
  ) : lr?.kind === 'notWired' ? (
    <p className="border-t px-4 py-2 text-meta text-muted-foreground" data-run-local="notWired">
      本机会话没接上：{lr.why}
    </p>
  ) : null;
  return (
    <Section
      flush
      data-home-block="run"
      title={<BlockTitle name="在跑的" count={rows.length} />}
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link to="/tasks">全部任务</Link>
        </Button>
      }
    >
      <RunList rows={rows} extra={extra} />
    </Section>
  );
}

/** 看远程环境的快照：那台的引擎单，只读（站内详情读的是本台的库，不给链接）。本机会话只在本台看。 */
export function RemoteRunBlock({ running }: { running: HomeRunning[] }) {
  const now = useNow();
  const rows = running.map((r) => engineRow(r, now, { href: r.link, external: true }));
  return (
    <Section flush data-home-block="run" title={<BlockTitle name="在跑的" count={rows.length} />}>
      <RunList rows={rows} />
    </Section>
  );
}

// —— 上线了的 ——

function prHref(repo: string | null, n: number): string | undefined {
  if (!repo) return undefined;
  const cut = repo.indexOf('/');
  if (cut < 0) return undefined;
  return brand.repoLink({ owner: repo.slice(0, cut), name: repo.slice(cut + 1) }, 'pull', n);
}

function PrLink({ repo, n, title }: { repo: string | null; n: number; title?: string | undefined }) {
  const href = prHref(repo, n);
  const label = `#${n}`;
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      className="num underline underline-offset-2"
    >
      {label}
    </a>
  ) : (
    <span className="num" title={title}>
      {label}
    </span>
  );
}

function carriedText(row: ShippedRow): string {
  if (row.carried.length > 0) {
    // 标题没读到时后端的退路是「PR #号」：只写一次号
    const list = row.carried
      .map((d) => (d.title === `PR #${d.prNumber}` ? `#${d.prNumber}` : `#${d.prNumber} ${d.title}`))
      .join('、');
    return `还带了 ${row.carried.length} 个：${list}${row.carriedKnown ? '' : '（可能没列全）'}`;
  }
  return row.carriedKnown ? '只带了这一个 PR' : '同一版带的别的 PR 没列全，去更新日志看';
}

function ShippedLine({ row, now }: { row: ShippedRow; now: number }) {
  const carried = carriedText(row);
  return (
    <li className="px-4 py-3" data-shipped-row={row.event}>
      <p className="flex min-w-0 items-center gap-2 whitespace-nowrap">
        {row.what !== null ? (
          <span className="min-w-0 truncate text-body font-medium" title={row.what}>
            {row.what}
          </span>
        ) : (
          <span className="min-w-0 truncate text-body text-ink-stall" title={row.whatWhy ?? ''}>
            标题没查成：{row.whatWhy}
          </span>
        )}
        {row.event !== 'release' ? (
          <StatusBadge
            tone="stall"
            variant="outline"
            icon={false}
            label={row.event === 'rollback' ? '回滚' : '自动回滚'}
          />
        ) : null}
        <span className="num ml-auto shrink-0 text-meta text-muted-foreground" title={formatDateTime(row.at)}>
          {formatAgo(row.at, now)}
        </span>
      </p>
      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-meta text-muted-foreground">
        {row.pr ? <PrLink repo={row.pr.repo} n={row.pr.number} /> : <span>不是 PR 合进来的</span>}
        <span aria-hidden>·</span>
        <span className="font-mono">{row.short}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate" title={carried} data-shipped-carried>
          {carried}
        </span>
      </p>
    </li>
  );
}

/** 本台：法国的发布历史 + 最近合并的 PR。 */
export function ShippedBlock({ done }: { done: HomeDone[] }) {
  const now = useNow();
  const q = useFranceReleasedCommits();
  const rows = q.data?.state === 'ok' ? shippedRows(q.data.commits, done) : [];
  return (
    <Section
      flush
      data-home-block="shipped"
      title={<BlockTitle name="上线了的" count={q.data?.state === 'ok' ? rows.length : undefined} />}
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link to="/changelog">更新日志</Link>
        </Button>
      }
    >
      {q.error ? (
        <div className="p-4">
          <LoadError what="上线记录" error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : !q.data ? (
        <div className="p-4">
          <LoadingRows rows={2} />
        </div>
      ) : q.data.state === 'unreadable' ? (
        <div className="p-4">
          <Notice tone="stall">上线记录没查成：{q.data.why}</Notice>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState size="inline" icon={Rocket} title="法国的发布历史里还没有发布记录" />
      ) : (
        <List>
          {rows.map((r) => (
            <ShippedLine key={r.key} row={r} now={now} />
          ))}
        </List>
      )}
    </Section>
  );
}

/** 看远程环境：上线记录是法国这台的发布历史，不顶着远程环境的名字列。 */
export function RemoteShippedBlock() {
  return (
    <Section flush data-home-block="shipped" title={<BlockTitle name="上线了的" />}>
      <EmptyState size="inline" icon={Rocket} title="上线记录只在本台看" hint="切回本台再看。" />
    </Section>
  );
}
