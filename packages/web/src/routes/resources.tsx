// 资源页（/resources，#1986）：法国这台机器此刻的整机内存、CPU、磁盘，每个上线项目各占多少、放在哪，按目录的磁盘占用榜。
// 创始人原话（2026-10-13）：「资源页展示的是每个上线项目占用多少，比如驾驶舱占用」「磁盘占用我需要的是整个 vps 使用多少/总量多少」。
//
// 数据从哪来：和主页同一份（useHome 的 resources；选了远程环境读那台推来的快照）。整机和每个项目的 CPU、内存每 5 秒随推送换；
// 按目录的磁盘占用后端每 10 分钟测一回（遍历文件较重），带着推，这页写「N 分钟前测的」。不整页轮询。
// 每一格怎么写（读成了、没在占用、没读到、不全）在 components/resources/view.ts，这里只管排版。
//
// 版式：三段（整机 → 上线项目 → 磁盘占用榜），区块里只有行和分隔线。上线项目一行：名字 + 放在哪 | CPU | 内存 | 磁盘，
// 点开是单元、口径、名下的目录和库；手机上一行折成卡片（名字、路径各一行，三格并排在下面），字不截断。
import { HardDrive, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { isNotFound, useHome, useLiveState, useNodeHome } from '../api/client';
import { hostMeters, type Meter } from '../components/home/resources';
import type { HomeResources, HomeRunning } from '../components/home/types';
import { EmptyState } from '../components/layout/empty-state';
import { List, ListRow, RowDetail } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { Section, SectionGrid } from '../components/layout/section';
import { StatusBadge } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
import { SnapshotBanner, useSelectedNodeName } from '../components/node-notice';
import { NotBuilt } from '../components/not-built';
import {
  type AppRow,
  appRows,
  type BoardResult,
  type Cell,
  type DiskCell,
  type DiskPart,
  diskBoard,
} from '../components/resources/view';
import { Button } from '../components/ui/button';
import { formatAgo, formatDuration, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useSelectedNodeId } from '../lib/node';
import { useShownError } from '../lib/shown-error';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('资源') }];
}

const STALE_AFTER_MS = 5 * TIME.MIN;

// ---------- 整机 ----------

/** 整机一大格：名字、「已用 / 总量」、细条、百分比和一句短话；读不到写没读到和原因。 */
function Gauge({ id, name, meter, stale }: { id: string; name: string; meter: Meter; stale: boolean }) {
  if (meter.kind === 'unread') {
    return (
      <div data-gauge={id} data-tone="stop" className="min-w-0">
        <div className="text-meta text-muted-foreground">{name}</div>
        <div className="mt-1 text-heading text-muted-foreground">没读到</div>
        <p className="mt-1 text-meta break-words text-muted-foreground">{meter.why}</p>
      </div>
    );
  }
  const [used, total] = meter.amount.kind === 'ok' ? meter.amount.text.split(' / ') : [undefined, undefined];
  const strong = meter.tight && !stale;
  return (
    <div
      data-gauge={id}
      data-tone={strong ? 'stall' : stale ? 'stop' : 'done'}
      className="min-w-0"
      title={meter.detail}
    >
      <div className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
        <span>{name}</span>
        {strong ? <StatusBadge tone="stall" variant="dot" label="紧" /> : null}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5 whitespace-nowrap">
        {used === undefined ? (
          <span className="text-heading text-muted-foreground">数值没读到</span>
        ) : (
          <>
            <span data-gauge-used className={cn('num text-display', strong && 'text-ink-stall')}>
              {used}
            </span>
            <span className="num text-heading font-normal text-muted-foreground">/ {total}</span>
          </>
        )}
      </div>
      <div aria-hidden className="mt-3 h-1.5 overflow-hidden rounded-full bg-selected">
        <span
          className={cn(
            'block h-full rounded-full transition-[width] duration-300 ease-out',
            strong ? 'bg-st-stall' : 'bg-muted-foreground',
          )}
          style={{ width: `${Math.min(100, Math.max(1, meter.percent))}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-meta whitespace-nowrap text-muted-foreground">
        <span className="min-w-0 truncate">{meter.brief}</span>
        <span
          data-gauge-percent
          className={cn('num font-medium', strong ? 'text-ink-stall' : 'text-foreground')}
        >
          {meter.text}
        </span>
      </div>
    </div>
  );
}

function HostSection({
  resources,
  remote,
  machine,
  now,
}: {
  resources: HomeResources | undefined;
  remote: boolean;
  machine: string;
  now: number;
}) {
  const m = hostMeters(resources, now, { remote });
  const when = resources
    ? `读于 ${formatAgo(resources.at, Math.max(now, Date.parse(resources.at)))}${remote ? '（那台推来的快照）' : ` · 每 ${Math.round(resources.everyMs / 1000)} 秒更新`}${m.stale ? ' · 读数旧了' : ''}`
    : undefined;
  return (
    <Section title="整机" description={when ? `${machine} · ${when}` : machine} data-resources-host>
      {m.missing ? (
        <p className="text-body text-muted-foreground" data-resources-missing>
          {m.missing}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3 md:gap-8">
          <Gauge id="memory" name="内存" meter={m.memory} stale={m.stale} />
          <Gauge id="cpu" name="CPU" meter={m.cpu} stale={m.stale} />
          <Gauge id="disk" name="磁盘" meter={m.disk} stale={m.stale} />
        </div>
      )}
    </Section>
  );
}

// ---------- 上线项目 ----------

function CellText({ cell }: { cell: Cell }) {
  switch (cell.kind) {
    case 'ok':
      return (
        <span className={cn('num', cell.tight ? 'text-ink-stall' : 'text-foreground')} title={cell.title}>
          {cell.text}
        </span>
      );
    case 'sampling':
      return (
        <span className="text-muted-foreground" title={cell.why}>
          采样中
        </span>
      );
    case 'idle':
      return (
        <span className="text-muted-foreground" title={cell.why}>
          没在占用
        </span>
      );
    case 'none':
      return (
        <span className="text-muted-foreground" title={cell.why}>
          不单算
        </span>
      );
    case 'unread':
      return (
        <span className="text-muted-foreground" title={cell.why}>
          没读到
        </span>
      );
  }
}

function DiskText({ cell }: { cell: DiskCell }) {
  switch (cell.kind) {
    case 'ok':
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={cell.incomplete}>
          <span className="num text-foreground">{cell.incomplete ? `≥ ${cell.text}` : cell.text}</span>
          {cell.incomplete ? <StatusBadge tone="stall" variant="dot" label="不全" /> : null}
        </span>
      );
    case 'pending':
      return (
        <span className="text-muted-foreground" title={cell.why}>
          还没测完
        </span>
      );
    case 'none':
      return (
        <span className="text-muted-foreground" title={cell.why}>
          不单算
        </span>
      );
    case 'unread':
      return (
        <span className="text-muted-foreground" title={cell.why}>
          没读到
        </span>
      );
  }
}

/** 一格的原因（明细里写全文；手机上没有悬停）。 */
function why(cell: Cell | DiskCell): string | undefined {
  if (cell.kind === 'ok')
    return 'incomplete' in cell ? cell.incomplete : 'title' in cell ? cell.title : undefined;
  return 'why' in cell ? cell.why : undefined;
}

/** 列：名字 6 份，三格各 2 份；手机上三格并成一排。 */
function AppGrid({
  name,
  cpu,
  memory,
  disk,
  head = false,
}: {
  name: ReactNode;
  cpu: ReactNode;
  memory: ReactNode;
  disk?: ReactNode;
  head?: boolean;
}) {
  const cell = (label: string, value: ReactNode) => (
    <div className="min-w-0 md:col-span-2 md:text-right">
      {head ? null : <div className="text-meta text-muted-foreground md:hidden">{label}</div>}
      <div className={cn(head ? 'text-meta text-muted-foreground' : 'text-body')}>{value}</div>
    </div>
  );
  return (
    <div className="grid w-full min-w-0 grid-cols-1 gap-y-2 md:grid-cols-12 md:items-center md:gap-x-4">
      <div className={cn('min-w-0 md:col-span-6', head && 'text-meta text-muted-foreground')}>{name}</div>
      <div className="grid grid-cols-3 gap-x-4 md:contents">
        {cell('CPU', cpu)}
        {cell('内存', memory)}
        {disk === undefined ? <div aria-hidden className="md:col-span-2" /> : cell('磁盘', disk)}
      </div>
    </div>
  );
}

function AppDetail({ row, totalCores }: { row: AppRow; totalCores: number | undefined }) {
  const lines: { label: string; value: ReactNode }[] = [
    { label: '放在哪', value: <span className="font-mono text-meta break-all">{row.place}</span> },
    {
      label: 'systemd 单元',
      value: row.units.length ? (
        <span className="font-mono text-meta break-all">{row.units.join('、')}</span>
      ) : (
        '没有（不是进程，只占磁盘）'
      ),
    },
  ];
  const cpuWhy = why(row.cpu);
  lines.push({
    label: 'CPU',
    value: `${row.cpu.kind === 'ok' ? `忙 ${row.cpu.text}${totalCores ? `（整机 ${totalCores} 核）` : ''}` : cellWord(row.cpu)}${
      row.cpu.kind !== 'ok' && cpuWhy ? `：${cpuWhy}` : ''
    }`,
  });
  const memWhy = why(row.memory);
  lines.push({
    label: '内存',
    value:
      row.memory.kind === 'ok'
        ? (row.memory.title ?? row.memory.text)
        : `${cellWord(row.memory)}${memWhy ? `：${memWhy}` : ''}`,
  });
  const diskWhy = why(row.disk);
  lines.push({
    label: '磁盘',
    value:
      row.disk.kind === 'ok'
        ? `${row.disk.text}${row.disk.incomplete ? `（${row.disk.incomplete}，数是下限）` : ''}`
        : `${diskWord(row.disk)}${diskWhy ? `：${diskWhy}` : ''}`,
  });
  return (
    <RowDetail indent={false} className="pb-4" data-app-detail={row.id}>
      <dl className="grid gap-y-1.5 text-body">
        {lines.map((l) => (
          <div key={l.label} className="grid grid-cols-1 gap-x-4 md:grid-cols-12">
            <dt className="text-meta text-muted-foreground md:col-span-2">{l.label}</dt>
            <dd className="min-w-0 break-words md:col-span-10">{l.value}</dd>
          </div>
        ))}
      </dl>
      {row.diskParts.length ? (
        <div className="mt-3">
          <div className="text-meta text-muted-foreground">名下的目录和库</div>
          <ul className="mt-1 divide-y divide-border">
            {row.diskParts.map((p) => (
              <PartLine key={p.key} part={p} />
            ))}
          </ul>
        </div>
      ) : null}
      {row.children?.length ? (
        <div className="mt-3" data-app-children>
          <div className="text-meta text-muted-foreground">按所属仓</div>
          <ul className="mt-1 divide-y divide-border">
            {row.children.map((c) => (
              <li key={c.key} className="py-1.5">
                <AppGrid
                  name={
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 truncate" title={c.name}>
                        {c.name}
                      </span>
                      <span className="shrink-0 text-meta text-muted-foreground">{c.sessions} 个会话</span>
                    </span>
                  }
                  cpu={<CellText cell={c.cpu} />}
                  memory={<CellText cell={c.memory} />}
                />
              </li>
            ))}
          </ul>
          <p className="mt-1 text-meta text-muted-foreground">会话的磁盘算在上面的工作树目录里，不按仓分。</p>
        </div>
      ) : null}
    </RowDetail>
  );
}

function cellWord(cell: Cell): string {
  return { ok: '', sampling: '采样中', idle: '没在占用', none: '不单算', unread: '没读到' }[cell.kind];
}

function diskWord(cell: DiskCell): string {
  return { ok: '', pending: '还没测完', none: '不单算', unread: '没读到' }[cell.kind];
}

function PartLine({ part }: { part: DiskPart }) {
  const note =
    part.size.kind === 'unread' ? part.size.why : part.size.kind === 'ok' ? part.size.incomplete : undefined;
  return (
    <li className="py-1.5">
      <div className="flex items-center justify-between gap-4">
        <span
          className={cn('min-w-0 truncate', part.kind === 'dir' ? 'font-mono text-meta' : 'text-body')}
          title={part.label}
        >
          {part.label}
        </span>
        <span className="shrink-0 text-body">
          <DiskText cell={part.size} />
        </span>
      </div>
      {/* 手机上没有悬停：原因直接写在下面 */}
      {note ? <p className="mt-0.5 text-meta break-words text-muted-foreground">{note}</p> : null}
    </li>
  );
}

function AppsSection({
  resources,
  running,
  remote,
}: {
  resources: HomeResources | undefined;
  running: readonly HomeRunning[];
  remote: boolean;
}) {
  const result = appRows(resources, running, { remote });
  const totalCores = resources?.cpu.state === 'ok' ? resources.cpu.cores : undefined;
  return (
    <Section title="上线项目" description="此刻的 CPU、内存，名下目录和库的磁盘" flush data-resources-apps>
      {result.kind === 'unread' ? (
        <div className="p-4 text-body text-muted-foreground" data-resources-apps-missing>
          没读到：{result.why}
        </div>
      ) : (
        <List>
          <ListRow
            aria-hidden
            className="max-md:hidden"
            summary={
              <>
                <span className="block min-w-0 flex-1">
                  <AppGrid head name="项目 · 放在哪" cpu="CPU" memory="内存" disk="磁盘" />
                </span>
                {/* 和下面各行的展开箭头同宽、同间距，列对齐 */}
                <span className="size-4 shrink-0" />
              </>
            }
          />
          {result.rows.map((row) => (
            <ListRow
              key={row.id}
              data-app={row.id}
              expandable
              summary={
                <span className="block min-w-0 flex-1 py-1">
                  <AppGrid
                    name={
                      <span className="block min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="text-body font-medium">{row.name}</span>
                          {row.external ? <Tag>不归本仓管</Tag> : null}
                        </span>
                        <span
                          className={cn(
                            'block truncate text-meta text-muted-foreground',
                            row.place.startsWith('/') && 'font-mono',
                          )}
                          title={row.place}
                        >
                          {row.place}
                        </span>
                      </span>
                    }
                    cpu={<CellText cell={row.cpu} />}
                    memory={<CellText cell={row.memory} />}
                    disk={<DiskText cell={row.disk} />}
                  />
                </span>
              }
              details={<AppDetail row={row} totalCores={totalCores} />}
            />
          ))}
        </List>
      )}
    </Section>
  );
}

// ---------- 磁盘占用榜 ----------

function BoardSection({
  resources,
  remote,
  now,
}: {
  resources: HomeResources | undefined;
  remote: boolean;
  now: number;
}) {
  const board: BoardResult = diskBoard(resources, { remote });
  const description =
    board.kind === 'ok'
      ? `${formatAgo(board.measuredAt, now)}测的 · 每 ${Math.round(board.everyMs / TIME.MIN)} 分钟测一次 · 测了 ${formatDuration(board.tookMs)}`
      : '每 10 分钟测一次（要遍历文件，不随每 5 秒的读数一起测）';
  const max =
    board.kind === 'ok'
      ? Math.max(1, ...board.rows.map((r) => (r.size.kind === 'ok' ? r.size.bytes : 0)))
      : 1;
  return (
    <Section title="磁盘占用（按目录）" description={description} flush data-resources-board>
      {board.kind === 'pending' ? (
        <div className="p-4">
          <EmptyState icon={HardDrive} title="还没测完" hint={board.why} />
        </div>
      ) : board.kind === 'unread' ? (
        <div className="p-4 text-body text-muted-foreground" data-resources-board-missing>
          没读到：{board.why}
        </div>
      ) : (
        <>
          {board.databasesWhy ? (
            <div className="px-4 pt-4 lg:px-5">
              <Notice tone="stall" title="库的大小没读成">
                {board.databasesWhy}
              </Notice>
            </div>
          ) : null}
          <List>
            {board.rows.map((r) => (
              <ListRow
                key={r.key}
                data-board-row={r.label}
                summary={
                  <span className="flex min-w-0 flex-1 items-center gap-4 py-1">
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block truncate',
                          r.kind === 'dir' ? 'font-mono text-meta md:text-body' : 'text-body',
                        )}
                        title={r.label}
                      >
                        {r.label}
                      </span>
                      <span className="block truncate text-meta text-muted-foreground">
                        {r.appName}
                        {r.share !== undefined ? ` · 占整盘 ${sharePercent(r.share)}` : ''}
                        {r.size.kind === 'ok' && r.size.incomplete ? ` · ${r.size.incomplete}` : ''}
                        {r.size.kind === 'unread' ? ` · ${r.size.why}` : ''}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-selected max-sm:hidden"
                    >
                      {r.size.kind === 'ok' ? (
                        <span
                          className="block h-full rounded-full bg-muted-foreground"
                          style={{ width: `${Math.max(1, (r.size.bytes / max) * 100)}%` }}
                        />
                      ) : null}
                    </span>
                    <span className="w-24 shrink-0 text-right text-body max-sm:w-auto">
                      <DiskText cell={r.size} />
                    </span>
                  </span>
                }
              />
            ))}
          </List>
        </>
      )}
    </Section>
  );
}

function sharePercent(share: number): string {
  const p = share * 100;
  return p < 1 ? '不到 1%' : `${Math.round(p)}%`;
}

// ---------- 页 ----------

function MissingEnv({ nodeId }: { nodeId: string }) {
  return (
    <Section>
      <div role="alert">
        <EmptyState
          icon={SearchX}
          title="没有这个环境"
          hint={
            <>
              <span className="block">
                库里没有编号为「<span className="num">{nodeId}</span>
                」的环境：可能链接里的编号写错了，或这个环境已经不在了。
              </span>
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to="/resources">回本台</Link>
              </Button>
            </>
          }
        />
      </div>
    </Section>
  );
}

export default function Resources() {
  const nodeId = useSelectedNodeId();
  const nodeName = useSelectedNodeName();
  const local = useHome({ enabled: nodeId === null });
  const remote = useNodeHome(nodeId);
  const push = useLiveState().status;
  const now = useNow();
  const main = nodeId === null ? local : remote;
  const remoteError = useShownError(nodeId ?? undefined, { error: remote.error, data: remote.node });
  const state =
    nodeId !== null && remoteError
      ? { status: 'error' as const, error: remoteError, retry: () => void remote.refetch() }
      : nodeId === null
        ? local.data
        : remote.data;
  const isRemote = nodeId !== null;
  const machine = isRemote ? (nodeName ?? nodeId) : '这台机器';

  return (
    <Page
      title="资源"
      description="整机此刻的内存、CPU、磁盘，每个上线项目各占多少、放在哪"
      detail="CPU、内存每 5 秒随推送更新（读各 systemd 单元的 cgroup，1 核 = 占满一个核）；按目录的磁盘占用每 10 分钟测一次。读不到写「没读到」，读不全写「不全」，不拿 0 顶。"
      refresh={{
        variant: 'dot',
        onRefresh: () => void main.refetch(),
        isFetching: main.isFetching,
        dataUpdatedAt: main.dataUpdatedAt,
        staleAfterMs: STALE_AFTER_MS,
        push,
      }}
    >
      {isRemote && remote.node ? (
        <div className="mb-4">
          <SnapshotBanner
            name={remote.node.name}
            receivedAt={remote.node.receivedAt}
            reportedAt={remote.node.reportedAt}
          />
        </div>
      ) : null}
      {nodeId !== null && state.status === 'error' && isNotFound(state.error) ? (
        <MissingEnv nodeId={nodeId} />
      ) : state.status === 'loading' ? (
        <LoadingRows rows={8} />
      ) : state.status === 'error' ? (
        <LoadError what={isRemote ? '这个环境' : '资源读数'} error={state.error} onRetry={state.retry} />
      ) : state.status === 'notWired' ? (
        <NotBuilt notWired={state.notWired} />
      ) : (
        <SectionGrid cols={1}>
          <HostSection resources={state.data.resources} remote={isRemote} machine={machine} now={now} />
          <AppsSection resources={state.data.resources} running={state.data.running} remote={isRemote} />
          <BoardSection resources={state.data.resources} remote={isRemote} now={now} />
        </SectionGrid>
      )}
    </Page>
  );
}
