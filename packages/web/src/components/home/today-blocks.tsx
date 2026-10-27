// 工作台的四块列表（决定 0093，#3509 照 Arco 改版，样稿 canvas/Main.dc.html）：要你拍的、在跑的任务、卡住报警、最近上线。
// 数据怎么挑写在 today.ts 文件头。页面只拼 components/layout 的件，不写样式。
// - 要你拍的：只放人闸（decision 级通知）。一行：事、要定什么加多久前、推荐哪个；选项就是按钮，点一下就是拍板（和通知中心同一个接口）。
//   整块只有最上面一条的推荐项是主按钮（品牌实色），其余都是灰的次按钮；一条超过两个选项，多的收进「更多」。
//   看远程环境时只读：按钮置灰、写去那台上答。
// - 卡住报警（样稿叫「卡住报警」，创始人要的「报警没人接」）：看门狗报进来的卡。不给「处理」（报警自己修、自己撤）：
//   一行写谁在修、修了多久、开了多久，没人接就写「还没人接」，谁在修没查成照实写；右边只留「看看」。
// - 在跑的任务：法国引擎的单和本机会话混排，卡着的、等你的在前；表格一行一个状态，原因写在事下面的灰字里。手机上退成列表。
//   引擎单有 flowMode 时标题旁标「全程」或「三段」；没有这个值不标。
// - 最近上线：最近 5 次切到法国的提交，带上同一版还带的 PR。
import { CheckCheck, CirclePlay, Rocket, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
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
import { usePhone } from '../../lib/viewport';
import { FlowModeTag } from '../flow-mode-tag';
import { Button } from '../layout/button';
import { EmptyState } from '../layout/empty-state';
import { List, ListRow } from '../layout/list';
import { LoadError, LoadingRows } from '../layout/load-state';
import { Notice } from '../layout/notice';
import { RowMenu, RowMenuItem } from '../layout/row-menu';
import { Stack } from '../layout/stack';
import { LevelDot, StatusBadge } from '../layout/status-badge';
import { Table, type TableColumn } from '../layout/table';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import { HomeFoldSection } from './home-collapse';
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
  type WatchdogRepairState,
  watchdogRepair,
} from './today';
import type { HomeDecision, HomeDone, HomeRunning } from './types';

/** 区块标题：名字加灰色的条数。 */
function BlockTitle({ name, count }: { name: string; count?: number | undefined }) {
  return (
    <>
      {name}
      {count === undefined || count === 0 ? null : <Tag>{count}</Tag>}
    </>
  );
}

// —— 收起时的一行摘要（#3707 批次 3）——
// 收起后不能什么都看不见：每块写清几项、有没有异常。读不到写「没读成」，不写成「没有」。

/** 要你拍的：几件、有没有读成。 */
export function askSummary(count: number | undefined, failed: boolean): string {
  if (failed) return '没读成，展开看重试';
  if (count === undefined) return '在读…';
  return count === 0 ? '没有要你拍的' : `${count} 件等你拍`;
}

/** 在跑的任务：几件、其中几件卡住或等你。 */
export function runSummary(rows: readonly RunRow[], count: number): string {
  if (count === 0) return '现在没有在跑的单';
  const stuck = rows.filter((r) => r.tone === 'fail' || r.tone === 'human').length;
  return stuck > 0 ? `${count} 件在跑 · ${stuck} 件卡住或等你` : `${count} 件在跑 · 都正常`;
}

/** 卡住报警：几件、有没有没人接的。 */
export function alarmSummary(
  count: number | undefined,
  failed: boolean,
  nobody: number,
  unread: number,
): string {
  if (failed) return '没读成，展开看重试';
  if (count === undefined) return '在读…';
  if (count === 0) return '没有卡住报警';
  const bits = [`${count} 件卡住`];
  if (nobody > 0) bits.push(`${nobody} 件还没人接`);
  if (unread > 0) bits.push(`${unread} 件谁在修没查成`);
  return bits.join(' · ');
}

/** 最近上线：最近一版是什么、多久前。 */
export function shippedSummary(rows: readonly ShippedRow[], failed: boolean, now: number): string {
  if (failed) return '没读成，展开看重试';
  const top = rows[0];
  if (!top) return '还没有发布记录';
  const what = top.what ?? '标题没查成';
  return `最近一版 ${formatAgo(top.at, now)}：${what}`;
}

/** 超过一页时区块底下的一行说明：只看了最近一页，不当成只有这些。 */
function FootNote({ children }: { children: string }) {
  return (
    <List>
      <ListRow
        summary={
          <Text size="meta" tone="muted">
            {children}
          </Text>
        }
      />
    </List>
  );
}

// —— 要你拍的 ——

type Option = NonNullable<Notification['options']>[number];

/** 推荐的在前，其余照后端给的先后。 */
function orderedOptions(options: readonly Option[]): Option[] {
  return [...options].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
}

/** 一行直接摆几个选项按钮，多的收进「更多」。 */
const SHOWN_OPTIONS = 2;

function AskRow({
  item,
  now,
  answering,
  lead,
  onAnswer,
}: {
  item: AskItem;
  now: number;
  /** 正在答的那一条和点的哪一项。 */
  answering: { id: string; optionId: string } | undefined;
  /** 整块最上面的一条：它的推荐项是整块唯一的主按钮。 */
  lead: boolean;
  onAnswer: (n: Notification, optionId: string) => void;
}) {
  const { n } = item;
  const { question, pick, why } = askLine(n);
  const options = orderedOptions(n.options ?? []);
  const busy = answering?.id === n.id;
  const failed = n.answer?.execution?.ok === false ? n.answer.execution.text : null;
  const shown = options.slice(0, SHOWN_OPTIONS);
  const more = options.slice(SHOWN_OPTIONS);
  return (
    <ListRow
      tall
      wrapTrailing
      data-ask-row="gate"
      title={
        <Text strong title={n.title}>
          {n.title}
        </Text>
      }
      meta={
        <>
          <Text size="meta" tone="muted" block title={formatDateTime(n.createdAt)}>
            {question !== n.title ? `${question}　` : ''}
            {formatAgo(n.createdAt, now)}
          </Text>
          {pick ? (
            <Text size="meta" tone="secondary" block>
              推荐：{pick}。{why}
            </Text>
          ) : (
            <Text size="meta" tone="muted" block>
              {NO_OPTIONS_TEXT}
            </Text>
          )}
          {failed ? (
            // 拍了但系统没做成（#2353）：原因写在这里，再点一次选项就是再拍
            <Text size="meta" tone="danger" block title={failed}>
              上次选「{n.answer?.text}」没做成：{failed}
            </Text>
          ) : null}
        </>
      }
      trailing={
        <Stack direction="horizontal" gap="sm" align="center">
          {options.length === 0 ? (
            <Button size="sm" href="/notifications?level=decision">
              去回复
            </Button>
          ) : (
            shown.map((o, i) => (
              <Button
                key={o.id}
                size="sm"
                variant={lead && i === 0 && o.recommended ? 'primary' : 'secondary'}
                title={o.detail}
                loading={busy && answering?.optionId === o.id}
                {...(busy && answering?.optionId !== o.id ? { disabledReason: '正在记上一个选择' } : {})}
                onClick={() => onAnswer(n, o.id)}
              >
                {o.label}
              </Button>
            ))
          )}
          {more.length > 0 ? (
            <RowMenu label={`更多选项：${n.title}`} title="还有别的选项" reveal={false}>
              {more.map((o) => (
                <RowMenuItem key={o.id} disabled={busy} onSelect={() => onAnswer(n, o.id)}>
                  {o.label}
                </RowMenuItem>
              ))}
            </RowMenu>
          ) : null}
        </Stack>
      }
    />
  );
}

/** 本台：读通知，点选项就是拍板。 */
export function AskBlock() {
  const now = useNow();
  const q = useNotifications('open');
  const answer = useAnswerNotification();
  const items = q.data ? askItems(q.data.items).filter((i) => i.kind === 'gate') : [];
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
  const list = q.data !== undefined && items.length > 0;
  return (
    <HomeFoldSection
      block="ask"
      flush={list}
      data-home-block="ask"
      title={<BlockTitle name="要你拍的" count={q.data ? items.length : undefined} />}
      summary={askSummary(q.data ? items.length : undefined, Boolean(q.error))}
      actions={
        <Button variant="text" size="sm" href="/notifications">
          全部通知
        </Button>
      }
    >
      {q.error ? (
        <LoadError what="要你拍的" error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <LoadingRows rows={2} />
      ) : items.length === 0 ? (
        <EmptyState icon={CheckCheck} title="没有要你拍的" />
      ) : (
        <>
          <List>
            {items.map((it, i) => (
              <AskRow
                key={it.n.id}
                item={it}
                now={now}
                answering={answering}
                lead={i === 0}
                onAnswer={onAnswer}
              />
            ))}
          </List>
          {q.data.nextCursor ? (
            <FootNote>{`待处理的通知超过 ${q.data.items.length} 条，这里只看了最近的；去通知中心看全`}</FootNote>
          ) : null}
        </>
      )}
    </HomeFoldSection>
  );
}

/** 看远程环境的快照：只读，答要去那台上答。 */
export function RemoteAskBlock({ decisions, machine }: { decisions: HomeDecision[]; machine: string }) {
  const now = useNow();
  const reason = `要去${machine}那台上答`;
  return (
    <HomeFoldSection
      block="ask"
      flush={decisions.length > 0}
      data-home-block="ask"
      title={<BlockTitle name="要你拍的" count={decisions.length} />}
      summary={askSummary(decisions.length, false)}
    >
      {decisions.length === 0 ? (
        <EmptyState icon={CheckCheck} title="没有要你拍的" />
      ) : (
        <List>
          {decisions.map((d) => (
            <ListRow
              key={d.id}
              tall
              wrapTrailing
              data-ask-row="gate"
              title={
                <Text strong title={d.title}>
                  {d.title}
                </Text>
              }
              meta={
                <>
                  <Text size="meta" tone="muted" block>
                    {d.context ? `${d.context}　` : ''}
                    {formatAgo(d.since, now)}
                  </Text>
                  <Text size="meta" tone="muted" block>
                    {reason}
                  </Text>
                </>
              }
              trailing={
                <Button size="sm" disabledReason={reason}>
                  去答
                </Button>
              }
            />
          ))}
        </List>
      )}
    </HomeFoldSection>
  );
}

// —— 卡住报警 ——

const REPAIR_LEVEL = {
  fixing: 'processing',
  waiting: 'warning',
  unknown: 'default',
} as const satisfies Record<WatchdogRepairState, 'processing' | 'warning' | 'default'>;

/** 本台：看门狗报进来的卡。没有「处理」，写谁在修、修了多久、开了多久。 */
export function AlarmBlock() {
  const now = useNow();
  const q = useNotifications('open');
  const items = q.data ? askItems(q.data.items).filter((i) => i.kind === 'watchdog') : [];
  const list = q.data !== undefined && items.length > 0;
  // 摘要要写「几件还没人接」「几件谁在修没查成」：判法和行里那一行用同一个 watchdogRepair
  const states = items.map(({ n }) => watchdogRepair(n, now, q.data?.handlingProblem).state);
  const nobody = states.filter((s) => s === 'waiting').length;
  const unread = states.filter((s) => s === 'unknown').length;
  return (
    <HomeFoldSection
      block="alarm"
      flush={list}
      data-home-block="alarm"
      title={<BlockTitle name="卡住报警" count={q.data ? items.length : undefined} />}
      summary={alarmSummary(q.data ? items.length : undefined, Boolean(q.error), nobody, unread)}
      actions={
        <Button variant="text" size="sm" href="/notifications">
          去处理
        </Button>
      }
    >
      {q.error ? (
        <LoadError what="卡住报警" error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <LoadingRows rows={2} />
      ) : items.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="没有卡住报警" />
      ) : (
        <List>
          {items.map(({ n }) => {
            const repair = watchdogRepair(n, now, q.data?.handlingProblem);
            return (
              <ListRow
                key={n.id}
                tall
                data-ask-row="watchdog"
                title={
                  <Text strong title={n.title}>
                    {n.title}
                  </Text>
                }
                meta={
                  <>
                    <Text size="meta" tone="muted" block title={askLine(n).question}>
                      {askLine(n).question}
                    </Text>
                    <span data-ask-repair={repair.state} title={repair.title}>
                      <Stack direction="horizontal" gap="sm" align="center">
                        <LevelDot level={REPAIR_LEVEL[repair.state]} />
                        <Text size="meta" tone="secondary">
                          {repair.text}
                        </Text>
                      </Stack>
                    </span>
                  </>
                }
                trailing={
                  <Button
                    variant="text"
                    size="sm"
                    href={n.link ?? '/notifications'}
                    aria-label={`看看 ${n.title}`}
                  >
                    看看
                  </Button>
                }
              />
            );
          })}
        </List>
      )}
    </HomeFoldSection>
  );
}

// —— 在跑的任务 ——

/** 事下面的灰字：谁在做、进度，不是「没卡」「等你」这类状态标签已经说了的话。 */
function runSub(row: RunRow): string {
  const covered = new Set(['没卡', '卡住了', '等你']);
  return [row.who, row.progress, covered.has(row.stuck) ? null : row.stuck].filter(Boolean).join(' · ');
}

function RunTitle({ row }: { row: RunRow }) {
  return (
    <Stack direction="horizontal" gap="sm" align="center">
      <Text strong truncate title={row.what}>
        {row.what}
      </Text>
      <FlowModeTag mode={row.flowMode} fallback={row.flowFallback} />
    </Stack>
  );
}

function RunDetail({ row }: { row: RunRow }) {
  return (
    <>
      <Text size="meta" tone="muted" block title={`${row.who} · ${row.progress}`}>
        {runSub(row)}
      </Text>
      {row.why ? (
        <span data-run-why>
          <Text size="meta" tone="secondary" block title={row.why}>
            {row.why}
          </Text>
        </span>
      ) : null}
    </>
  );
}

function RunLink({ row }: { row: RunRow }) {
  // 看远程快照时站内详情读的是本台的库、对不上，不给链接
  if (!row.href || row.external) return null;
  return (
    <Button variant="text" size="xs" href={row.href} aria-label={`查看 ${row.what}`}>
      查看
    </Button>
  );
}

const RUN_COLUMNS: TableColumn<RunRow>[] = [
  {
    key: 'what',
    title: '任务',
    render: (_, row) => (
      <span data-run-row={row.source} data-tone={row.tone}>
        <RunTitle row={row} />
        <RunDetail row={row} />
      </span>
    ),
  },
  { key: 'tone', title: '状态', render: (_, row) => <StatusBadge status={`tone:${row.tone}`} /> },
  { key: 'href', title: '操作', render: (_, row) => <RunLink row={row} /> },
];

function RunRows({ rows }: { rows: RunRow[] }) {
  const phone = usePhone();
  const sorted = sortRunRows(rows);
  if (phone) {
    return (
      <List>
        {sorted.map((row) => (
          <ListRow
            key={row.key}
            tall
            wrapTrailing
            data-run-row={row.source}
            data-tone={row.tone}
            title={<RunTitle row={row} />}
            meta={<RunDetail row={row} />}
            trailing={
              <Stack direction="horizontal" gap="sm" align="center">
                <StatusBadge status={`tone:${row.tone}`} />
                <RunLink row={row} />
              </Stack>
            }
          />
        ))}
      </List>
    );
  }
  return <Table caption="在跑的任务" columns={RUN_COLUMNS} rows={sorted} rowKey="key" />;
}

function RunSection({
  count,
  extra,
  rows,
  all,
}: {
  count: number;
  extra?: ReactNode;
  rows: RunRow[];
  /** 本台：给「全部任务」和「提需求」的入口；看远程快照时站内的任务页读的是本台的库，不给。 */
  all: boolean;
}) {
  const has = rows.length > 0;
  return (
    <HomeFoldSection
      block="run"
      flush={has}
      data-home-block="run"
      title={<BlockTitle name="在跑的任务" count={count} />}
      summary={runSummary(rows, count)}
      actions={
        all ? (
          <Button variant="text" size="sm" href="/tasks">
            全部任务
          </Button>
        ) : undefined
      }
    >
      {has ? (
        <>
          <RunRows rows={rows} />
          {extra}
        </>
      ) : (
        <>
          <EmptyState
            icon={CirclePlay}
            title="现在没有在跑的单"
            action={
              all ? (
                <Button size="sm" href="/intake">
                  提需求
                </Button>
              ) : undefined
            }
          />
          {extra}
        </>
      )}
    </HomeFoldSection>
  );
}

/** 本台：法国引擎的单 + 本机会话。 */
export function RunBlock({ running }: { running: HomeRunning[] }) {
  const now = useNow();
  const local = useLocalSessions();
  // 读不到本机会话时找不到机器名，退回环境编号（localWhoOf 的老写法）；读失败在区块底另写，不在这里当成空
  const machineOf = (id: string) => local.data?.nodes.find((n) => n.id === id)?.machine ?? undefined;
  const engine = running.map((r) => engineRow(r, now, { href: r.link, external: false }, machineOf));
  const lr = local.data ? localRows(local.data, now) : null;
  const rows = [...engine, ...(lr?.kind === 'rows' ? lr.rows : [])];
  const extra = local.error ? (
    <List>
      <ListRow
        summary={<LoadError what="本机会话" error={local.error} onRetry={() => void local.refetch()} />}
      />
    </List>
  ) : lr?.kind === 'rows' && lr.silent.length > 0 ? (
    <span data-run-local="silent" title={lr.silent.map((s) => `${s.machine}：${s.why}`).join('；')}>
      <FootNote>
        {`本机会话没上报（在做什么看不到，不当成没在做）：${lr.silent
          .map((s) => `${s.machine}${s.never ? '一次都没收到' : '上次收到的已过期'}`)
          .join('；')}`}
      </FootNote>
    </span>
  ) : lr?.kind === 'notWired' ? (
    <span data-run-local="notWired">
      <FootNote>{`本机会话没接上：${lr.why}`}</FootNote>
    </span>
  ) : null;
  return <RunSection count={rows.length} rows={rows} extra={extra} all />;
}

/** 看远程环境的快照：那台的引擎单，只读（站内详情读的是本台的库，不给链接）。本机会话只在本台看。 */
export function RemoteRunBlock({ running }: { running: HomeRunning[] }) {
  const now = useNow();
  const rows = running.map((r) => engineRow(r, now, { href: r.link, external: true }));
  return <RunSection count={rows.length} rows={rows} all={false} />;
}

// —— 最近上线 ——

function prHref(repo: string | null, n: number): string | undefined {
  if (!repo) return undefined;
  const cut = repo.indexOf('/');
  if (cut < 0) return undefined;
  return brand.repoLink({ owner: repo.slice(0, cut), name: repo.slice(cut + 1) }, 'pull', n);
}

function PrLink({ repo, n }: { repo: string | null; n: number }) {
  const href = prHref(repo, n);
  return href ? (
    <Button variant="text" size="xs" href={href} external>
      #{n}
    </Button>
  ) : (
    <Text mono tone="muted">
      #{n}
    </Text>
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
    <ListRow
      tall
      data-shipped-row={row.event}
      title={
        row.what !== null ? (
          <Text strong title={row.what}>
            {row.what}
          </Text>
        ) : (
          <Text tone="warning" title={row.whatWhy ?? ''}>
            标题没查成：{row.whatWhy}
          </Text>
        )
      }
      meta={
        <>
          <Stack direction="horizontal" gap="sm" align="center" wrap>
            {row.pr ? (
              <PrLink repo={row.pr.repo} n={row.pr.number} />
            ) : (
              <Text size="meta" tone="muted">
                不是 PR 合进来的
              </Text>
            )}
            <Text size="meta" tone="muted" mono>
              {row.short}
            </Text>
            <Text size="meta" tone="muted" title={formatDateTime(row.at)}>
              {formatAgo(row.at, now)}
            </Text>
          </Stack>
          <span data-shipped-carried>
            <Text size="meta" tone="muted" block title={carried}>
              {carried}
            </Text>
          </span>
        </>
      }
      trailing={
        row.event !== 'release' ? (
          <Tag tone="warning">{row.event === 'rollback' ? '回滚' : '自动回滚'}</Tag>
        ) : null
      }
    />
  );
}

/** 本台：法国的发布历史 + 最近合并的 PR。 */
export function ShippedBlock({ done }: { done: HomeDone[] }) {
  const now = useNow();
  const q = useFranceReleasedCommits();
  const rows = q.data?.state === 'ok' ? shippedRows(q.data.commits, done) : [];
  const failed = Boolean(q.error) || q.data?.state === 'unreadable';
  return (
    <HomeFoldSection
      block="shipped"
      flush={rows.length > 0}
      data-home-block="shipped"
      title={<BlockTitle name="最近上线" />}
      summary={shippedSummary(rows, failed, now)}
      actions={
        <Button variant="text" size="sm" href="/changelog">
          更新日志
        </Button>
      }
    >
      {q.error ? (
        <LoadError what="上线记录" error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <LoadingRows rows={2} />
      ) : q.data.state === 'unreadable' ? (
        <Notice tone="stall">上线记录没查成：{q.data.why}</Notice>
      ) : rows.length === 0 ? (
        <EmptyState icon={Rocket} title="法国的发布历史里还没有发布记录" />
      ) : (
        <List>
          {rows.map((r) => (
            <ShippedLine key={r.key} row={r} now={now} />
          ))}
        </List>
      )}
    </HomeFoldSection>
  );
}

/** 看远程环境：上线记录是法国这台的发布历史，不顶着远程环境的名字列。 */
export function RemoteShippedBlock() {
  return (
    <HomeFoldSection
      block="shipped"
      flush
      data-home-block="shipped"
      title={<BlockTitle name="最近上线" />}
      summary="上线记录只在本台看"
    >
      <EmptyState size="inline" icon={Rocket} title="上线记录只在本台看" hint="切回本台再看。" />
    </HomeFoldSection>
  );
}

/** 看远程环境：看门狗的卡是本台通知里的，不顶着远程环境的名字列。 */
export function RemoteAlarmBlock() {
  return (
    <HomeFoldSection
      block="alarm"
      flush
      data-home-block="alarm"
      title={<BlockTitle name="卡住报警" />}
      summary="卡住报警只在本台看"
    >
      <EmptyState size="inline" icon={ShieldCheck} title="卡住报警只在本台看" hint="切回本台再看。" />
    </HomeFoldSection>
  );
}
