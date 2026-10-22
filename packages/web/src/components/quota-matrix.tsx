// 额度页的表（#3509 照 Arco 重做，#3533；样稿 canvas/Quota.dc.html）：一个池的一个窗口一行，
// 列是 账号池 / 窗口 / 用量（进度条）/ 清零 / 状态 / 启用；渠道名和它的「全部暂停」是通栏的组头；
// 展开一行看读法、上游原话、按时间该用到；点开关或「全部暂停」在那一行下面就地展开原因表单。
// 改这里之前必须知道：
// - 一行一个状态：池的暂停状态（没查成 / 封号 / 该复查）> 池的毛病（额度读不到 / 凭据过期）> 池整个没读成 > 窗口自己的状态。
// - 同一个池同一类窗有新旧两张时，过期的收成窗口名下一行灰字，不再占一整行（isExpiredWindow）。
// - 没有任何额度窗的池只画一行：用量那格写「无额度窗」，一次没读成过的状态写「没查成」。
import type { PoolView, QuotaWindowView } from '../api/types';
import {
  billingLabel,
  isUpstreamFull,
  poolTitle,
  utilOf,
  windowRank,
  windowRawNote,
  windowTitle,
} from '../lib/catalog';
import { formatDate, formatInDays } from '../lib/format';
import type { PoolProblem } from '../lib/pool-problems';
import { problemLine } from '../lib/pool-problems';
import { routeSlots } from '../lib/routing';
import { InfoTip } from './layout/info-tip';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Table, type TableColumn } from './layout/table';
import { Tag } from './layout/tag';
import { Text } from './layout/text';
import { PoolProblemLine } from './pool-problem';
import {
  ChannelHoldControls,
  ChannelHoldForm,
  PoolFlagBadge,
  PoolHoldNote,
  PoolSwitch,
  PoolSwitchForm,
  usePoolFlag,
  usePoolSwitchOpen,
} from './pool-switch';
import { ExpiredQuotaLine, isExpiredWindow, QuotaDetail, QuotaReset, QuotaUsage, windowFacts } from './quota';

/** 表里的一行：池的一个窗口（没有额度窗的池是 w = null 的一行）。 */
export interface QuotaRow {
  key: string;
  pool: PoolView;
  w: QuotaWindowView | null;
  /** 这个池的第一行：池名、开关、池的状态都在这一行。 */
  first: boolean;
  /** 同类窗有新旧两张时，这一行下面补一句「旧读数，已过期」。 */
  expiredNote: boolean;
  hot: boolean;
  full: boolean;
  /** 「读数过期或没查成」那一栏：池有毛病、池没读成，或这个窗读数过期、用量没读到、上游这次没报。 */
  stale: boolean;
}

/** 池 × 窗口摊成行。窗口按类排（5 小时、周……），同类窗按后端给的顺序。 */
export function buildRows(
  pools: readonly PoolView[],
  now: number,
  problems: ReadonlyMap<string, PoolProblem>,
): QuotaRow[] {
  const rows: QuotaRow[] = [];
  for (const pool of pools) {
    const poolStale = problems.has(pool.id) || pool.quotaStatus === 'unread';
    const push = (w: QuotaWindowView | null, expiredNote: boolean) => {
      const facts = w ? windowFacts(w, now) : null;
      // 读成了但没有用量比例（只报了清零时间，或只有已用没有上限）：不参与「先用它」和排序，但要列出来
      const unknownUse = w
        ? !w.stale && !w.staleSince && !isUpstreamFull(w) && utilOf(w) === undefined
        : false;
      const unreported = w ? !w.stale && Boolean(w.staleSince) : false;
      rows.push({
        key: rows.some((r) => r.pool.id === pool.id) ? `${pool.id}#${rows.length}` : pool.id,
        pool,
        w,
        first: !rows.some((r) => r.pool.id === pool.id),
        expiredNote,
        hot: facts?.hot ?? false,
        full: facts?.full ?? false,
        stale: poolStale || Boolean(w?.stale) || unknownUse || unreported,
      });
    };
    if (pool.windows.length === 0) {
      push(null, false);
      continue;
    }
    const kinds = [...new Set(pool.windows.map((w) => w.window))].sort(
      (a, b) => windowRank[a] - windowRank[b],
    );
    for (const k of kinds) {
      const ws = pool.windows.filter((x) => x.window === k);
      const expired = ws.filter((w) => isExpiredWindow(w, now));
      const current = ws.filter((w) => !isExpiredWindow(w, now));
      const collapse = expired.length > 0 && current.length > 0;
      (collapse ? current : ws).forEach((w, i) => {
        push(w, collapse && i === 0);
      });
    }
  }
  return rows;
}

/** 池名下面一行灰字：在跑几个、几号到期还有几天。 */
function PoolMeta({ pool: p, now }: { pool: PoolView; now: number }) {
  const slots = routeSlots({
    inFlight: p.running,
    reserved: p.reserved,
    maxConcurrency: p.maxConcurrency,
  }).text;
  const expiry = p.expiresAt
    ? `${formatDate(p.expiresAt)} 到期 · ${formatInDays(p.expiresAt, now)}`
    : '没有到期日';
  return (
    <span data-pool-meta title={`${slots} · ${expiry}`}>
      <Text size="meta" tone="muted">
        <span className="num">
          {slots} · {expiry}
        </span>
      </Text>
    </span>
  );
}

function NameCell({
  row,
  now,
  problems,
}: {
  row: QuotaRow;
  now: number;
  problems: ReadonlyMap<string, PoolProblem>;
}) {
  const { pool } = row;
  if (!row.first) {
    return (
      <Text tone="muted" title={pool.id}>
        <span className="num">{pool.id}</span>
      </Text>
    );
  }
  const problem = problems.get(pool.id);
  return (
    <Stack gap="sm">
      <Text strong title={poolTitle(pool)}>
        <span className="num">{pool.id}</span>
      </Text>
      <PoolMeta pool={pool} now={now} />
      <PoolHoldNote poolId={pool.id} />
      {problem ? <PoolProblemLine problem={problem} oneLine /> : null}
    </Stack>
  );
}

/** 状态列：一行一个状态。 */
function StatusCell({ row, problems }: { row: QuotaRow; problems: ReadonlyMap<string, PoolProblem> }) {
  const flag = usePoolFlag(row.pool.id);
  const { pool, w } = row;
  if (row.first) {
    if (flag) return <PoolFlagBadge flag={flag} />;
    const problem = problems.get(pool.id);
    if (problem) {
      return (
        <StatusBadge
          status={problem.kind === 'unreadable' ? 'quota:quota:unreadable' : 'quota:quota:stale'}
          title={problemLine(problem)}
        />
      );
    }
    if (pool.quotaStatus === 'unread') return <StatusBadge status="quota:quota:fetch-failed" />;
  }
  if (!w) return <Text tone="muted">—</Text>;
  if (w.stale) return <StatusBadge status="quota:quota:stale" />;
  if (w.staleSince) return <StatusBadge status="quota:quota:unreported" />;
  if (row.full) return <StatusBadge status="quota:quota:near-used" />;
  if (row.hot) return <StatusBadge status="quota:quota:use-first" />;
  if (!isUpstreamFull(w) && utilOf(w) === undefined) return <StatusBadge status="quota:quota:bar-unread" />;
  return <Text tone="muted">—</Text>;
}

export function QuotaMatrix({
  rows,
  pools,
  now,
  problems,
}: {
  /** 筛选后要画的行。 */
  rows: readonly QuotaRow[];
  /** 全部池：整渠道的暂停 / 放开动的是渠道下所有池，不是筛出来的那几个。 */
  pools: readonly PoolView[];
  now: number;
  problems: ReadonlyMap<string, PoolProblem>;
}) {
  const open = usePoolSwitchOpen();
  // 每个渠道的第一行（筛选后）上面画组头
  const channelFirst = new Map<string, string>();
  for (const r of rows) if (!channelFirst.has(r.pool.channelId)) channelFirst.set(r.pool.channelId, r.key);

  const columns: TableColumn<QuotaRow>[] = [
    {
      key: 'pool',
      title: '账号池',
      fill: true,
      width: 280,
      render: (_v, r) => <NameCell row={r} now={now} problems={problems} />,
    },
    {
      key: 'window',
      title: '窗口',
      render: (_v, r) =>
        r.w ? (
          <Stack gap="sm">
            <Text tone="secondary" title={windowRawNote(r.w)}>
              {windowTitle(r.w)}
            </Text>
            {r.expiredNote ? <ExpiredQuotaLine /> : null}
          </Stack>
        ) : (
          <Text tone="muted">—</Text>
        ),
    },
    {
      key: 'usage',
      title: (
        <Stack direction="horizontal" gap="sm" align="center">
          用量
          <InfoTip
            label="实读和估算是什么意思"
            content="实读：从官方接口或它自家网页的用量接口读到的。估算：读不到，按我们自己的用量算，撞到限额时记下上限。"
          />
        </Stack>
      ),
      render: (_v, r) =>
        r.w ? (
          <QuotaUsage w={r.w} now={now} />
        ) : r.pool.quotaStatus === 'unread' ? (
          <Text tone="muted">—</Text>
        ) : (
          <span data-quota-empty>
            <Text tone="muted">无额度窗</Text>
          </span>
        ),
    },
    {
      key: 'reset',
      title: '清零',
      render: (_v, r) => (r.w ? <QuotaReset w={r.w} now={now} /> : <Text tone="muted">—</Text>),
    },
    { key: 'status', title: '状态', render: (_v, r) => <StatusCell row={r} problems={problems} /> },
    {
      key: 'enabled',
      title: '启用',
      render: (_v, r) => (r.first ? <PoolSwitch poolId={r.pool.id} /> : <Text tone="muted">—</Text>),
    },
  ];

  return (
    <div data-quota-matrix>
      <Table
        caption="每个账号池、每个时间窗的额度"
        columns={columns}
        rows={rows}
        rowKey="key"
        empty="这一栏下面没有账号池"
        expandable={{
          rowExpandable: (r) => r.w !== null,
          render: (r) => (r.w ? <QuotaDetail w={r.w} now={now} /> : null),
        }}
        groupRow={(r) => {
          if (channelFirst.get(r.pool.channelId) !== r.key) return null;
          const ids = pools.filter((p) => p.channelId === r.pool.channelId).map((p) => p.id);
          return (
            <Stack gap="sm">
              <Stack direction="horizontal" gap="md" align="center" justify="between" wrap>
                <Stack direction="horizontal" gap="md" align="center">
                  <Text strong>{r.pool.channelName}</Text>
                  <Tag>{r.pool.billing ? billingLabel[r.pool.billing] : '计费未知'}</Tag>
                  {r.pool.channelEnabled ? null : <StatusBadge status="route:retired" variant="dot" />}
                </Stack>
                <ChannelHoldControls channelId={r.pool.channelId} poolIds={ids} />
              </Stack>
              <ChannelHoldForm channelId={r.pool.channelId} channelName={r.pool.channelName} poolIds={ids} />
            </Stack>
          );
        }}
        subRow={(r) =>
          r.first && open?.kind === 'pool' && open.id === r.pool.id ? (
            <PoolSwitchForm poolId={r.pool.id} />
          ) : null
        }
      />
    </div>
  );
}
