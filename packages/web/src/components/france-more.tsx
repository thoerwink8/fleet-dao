// 法国页的「更多」（#3509，样稿 canvas/France.dc.html 最下面一块）：零散页的入口——定时任务、资源、发布记录、操作记录、渠道状态——
// 加一格「命令行工具」，点开才在下面摆（#1969）：两个会话用户和全局 npm 各装了哪一版、官方最新是哪一版、落后几个；升过的同一行还有升上去的版本和上次升级时间（#1971）。
// 命令行工具没有升级按钮，只读。读不到写「没读到」和原因，不当成最新。
// 定时任务那一格带一个标签：有失败标红（失败 N），没查全或过期标橙；读不到写没读到和原因，不拿 0 冒充「没有失败」。
import type { UseQueryResult } from '@tanstack/react-query';
import { Terminal } from 'lucide-react';
import { useState } from 'react';
import { errorText } from '../api/client';
import type { CliToolsResponse, Jobs } from '../api/types';
import { formatAgo } from '../lib/format';
import type { StatusKey } from '../theme/status-dict';
import { Entry, EntryGrid } from './layout/entry';
import { LoadError, LoadingRows } from './layout/load-state';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Table, type TableColumn } from './layout/table';
import { Text } from './layout/text';
import { rowTone } from './schedule-row';
import { NAV_HIDDEN } from './shell/nav';

type CliOk = Extract<CliToolsResponse, { state: 'ok' }>;
type CliGroup = CliOk['groups'][number];
type CliRow = CliGroup['rows'][number];

function upgradeKey(outcome: NonNullable<CliRow['upgrade']>['outcome']): StatusKey | null {
  switch (outcome) {
    case 'ok':
      return 'machine:cli:upgraded';
    case 'current':
      return 'machine:cli:upgrade-current';
    case 'skipped':
      return 'machine:cli:upgrade-skipped';
    case 'failed':
      return 'release:step:failed';
    case 'rolled-back':
      return 'machine:cli:upgrade-rolled-back';
    case 'refused':
      return 'machine:cli:upgrade-refused';
    default:
      return null;
  }
}

function cliKey(kind: CliRow['status']['kind']): StatusKey {
  switch (kind) {
    case 'current':
      return 'machine:cli:current';
    case 'behind':
      return 'machine:cli:behind';
    case 'behind-uncounted':
      return 'machine:cli:behind-uncounted';
    case 'unread':
      return 'machine:cli:unread';
    case 'unreadable':
      return 'machine:cli:unreadable';
  }
}

/** 在用 / 官方最新这一格：读成了写版本号，没读成写原因（不空白）。 */
function VersionCell({ cell }: { cell: CliRow['installed'] }) {
  return cell.state === 'ok' ? (
    <Text mono>{cell.version}</Text>
  ) : (
    <Text size="meta" tone="warning">
      {cell.why}
    </Text>
  );
}

function groupColumns(now: number): TableColumn<CliRow>[] {
  return [
    {
      key: 'name',
      title: '工具',
      render: (_, r) => (
        <span data-cli-tool={r.tool}>
          <Text strong>{r.name}</Text>
        </span>
      ),
    },
    { key: 'installed', title: '在用', render: (_, r) => <VersionCell cell={r.installed} /> },
    { key: 'latest', title: '官方最新', render: (_, r) => <VersionCell cell={r.latest} /> },
    {
      key: 'status',
      title: '状态',
      render: (_, r) => <StatusBadge status={cliKey(r.status.kind)} variant="dot" />,
    },
    {
      key: 'upgrade',
      title: '上次升级',
      render: (_, r) => {
        const key = r.upgrade ? upgradeKey(r.upgrade.outcome) : null;
        if (!r.upgrade || !key) return '—';
        const version =
          r.upgrade.version && (r.upgrade.outcome === 'ok' || r.upgrade.outcome === 'current')
            ? r.upgrade.version
            : null;
        return (
          <Stack direction="horizontal" gap="sm" align="center">
            <StatusBadge status={key} variant="dot" />
            {version ? <Text mono>{version}</Text> : null}
            {r.upgrade.upgradedAt ? (
              <Text size="meta" tone="muted">
                上次升级 {formatAgo(r.upgrade.upgradedAt, now)}
              </Text>
            ) : null}
          </Stack>
        );
      },
    },
    {
      key: 'note',
      title: '说明',
      render: (_, r) => {
        const reason = 'reason' in r.status ? r.status.reason : null;
        const installedWhy = r.installed.state === 'ok' ? null : r.installed.why;
        const latestWhy = r.latest.state === 'ok' ? null : r.latest.why;
        const extra = reason && reason !== installedWhy && reason !== latestWhy ? reason : null;
        const parts = [
          r.status.kind === 'current' ? null : r.status.label,
          extra,
          r.checkedAt ? `检查于 ${formatAgo(r.checkedAt, now)}` : '还没检查',
        ].filter(Boolean);
        return (
          <Text size="meta" tone="muted">
            {parts.join(' · ')}
          </Text>
        );
      },
    },
  ];
}

/** 展开后的命令行工具：两个用户和全局 npm 分开列。 */
function CliTools({ query, now }: { query: UseQueryResult<CliToolsResponse>; now: number }) {
  if (query.error) {
    return <LoadError what="命令行工具" error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (query.isLoading || !query.data) return <LoadingRows rows={4} />;
  if (query.data.state === 'unreadable') {
    return (
      <Notice tone="stall" title="没读到命令行工具">
        {query.data.why}
      </Notice>
    );
  }
  const columns = groupColumns(now);
  return (
    <div data-cli-tools>
      <Stack>
        {query.data.upgradeNote ? (
          <Notice tone="stall" title="升级结果没读到">
            {query.data.upgradeNote}
          </Notice>
        ) : null}
        {query.data.groups.map((group) => (
          <div
            key={`${group.scope}:${group.owner}`}
            data-cli-group={group.scope === 'npm' ? 'npm' : group.owner}
          >
            <Stack gap="sm">
              <Text size="meta" tone="muted">
                {group.title}
              </Text>
              <Table<CliRow> caption={group.title} columns={columns} rows={group.rows} rowKey="tool" />
            </Stack>
          </div>
        ))}
        <Text size="meta" tone="muted">
          只读：看两个会话用户和全局 npm 各装了哪一版，没有升级按钮。
        </Text>
      </Stack>
    </div>
  );
}

function cliMeta(query: UseQueryResult<CliToolsResponse>, open: boolean): string {
  if (query.error) return `没读到：${errorText(query.error)}`;
  if (!query.data) return '正在读…';
  if (query.data.state === 'unreadable') return `没读到：${query.data.why}`;
  if (open) return '收起';
  const rows = query.data.groups.flatMap((g) => g.rows);
  const behind = rows.filter(
    (r) => r.status.kind === 'behind' || r.status.kind === 'behind-uncounted',
  ).length;
  return behind > 0 ? `${rows.length} 个，${behind} 个落后` : `${rows.length} 个`;
}

/** 零散页的入口和各自一行灰字（没有就不写）；图标、名字取菜单里不进菜单那几页的（nav.ts）。 */
const ENTRIES: readonly { to: string; meta?: string }[] = [
  { to: '/schedules' },
  { to: '/resources', meta: '每个项目占多少，机器的内存、CPU、磁盘' },
  { to: '/changelog' },
  { to: '/audit', meta: '谁在什么时候做了什么' },
  { to: '/routing/status', meta: '每个渠道近 60 次探测' },
];

/** 定时任务那一格的标签和灰字：有失败标红，没查全或过期标橙；读不到写没读到和原因。 */
function schedulesEntry(jobs: UseQueryResult<Jobs>): {
  tag?: string;
  tagTone?: 'error' | 'warning';
  meta?: string;
} {
  if (jobs.error) return { meta: `没读到：${errorText(jobs.error)}` };
  if (!jobs.data) return { meta: '正在读…' };
  const list = jobs.data.jobs;
  if (list.length === 0) return { meta: '这台环境一个定时任务都没有' };
  const failed = list.filter((j) => j.lastRun?.outcome === 'failed').length;
  const warn = list.filter((j) => rowTone(j) === 'stall').length;
  const meta = `共 ${list.length} 项`;
  if (failed > 0) return { tag: `失败 ${failed}`, tagTone: 'error', meta };
  if (warn > 0) return { tag: `没查全或过期 ${warn}`, tagTone: 'warning', meta };
  return { meta };
}

export function More({
  jobs,
  cli,
  now,
}: {
  jobs: UseQueryResult<Jobs>;
  cli: UseQueryResult<CliToolsResponse>;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const sched = schedulesEntry(jobs);
  return (
    <Section title="更多">
      <Stack>
        <EntryGrid>
          {ENTRIES.map(({ to, meta }) => {
            const item = NAV_HIDDEN.find((h) => h.to === to);
            if (!item) return null;
            const own = to === '/schedules' ? sched : { meta };
            return (
              <Entry
                key={to}
                icon={item.icon}
                title={item.label}
                href={to}
                {...(own.meta ? { meta: own.meta } : {})}
                {...('tag' in own && own.tag ? { tag: own.tag } : {})}
                {...('tagTone' in own && own.tagTone ? { tagTone: own.tagTone } : {})}
              />
            );
          })}
          <Entry
            icon={Terminal}
            title="命令行工具"
            meta={cliMeta(cli, open)}
            expanded={open}
            onClick={() => setOpen((o) => !o)}
          />
        </EntryGrid>
        {open ? <CliTools query={cli} now={now} /> : null}
      </Stack>
    </Section>
  );
}
