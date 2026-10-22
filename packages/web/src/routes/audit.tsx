// 操作记录（#3533 照 Arco 改版，样稿 canvas/Audit.dc.html）：谁在什么时候做了什么，只追加、不改。
// 一张表：谁 / 做了什么 / 对象 / 时间 / 操作；没做成的在「做了什么」后面一个红标签，下面一行出错原因，展开里有全文。
// 低频的收进展开行：理由、改了什么（人话差异）、只看这个对象、看原始数据（含动作原文）。
// 读失败不画成空表（写「没读到操作记录，这里空着不代表没人操作过」），刷新失败照旧画上一次的并顶上橙条。
// 页面只拼 components/layout 的件，不写样式类（lint-design R13–R20）。
import { ScrollText, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { brand } from '#brand';
import { AUDIT_PAGE_SIZE, useAllBoards, useAudit, useMe, useNotifications, useRouting } from '../api/client';
import type { AuditEntry } from '../api/types';
import { Button } from '../components/layout/button';
import { Collapse } from '../components/layout/collapse';
import { Descriptions } from '../components/layout/descriptions';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabs } from '../components/layout/filter-tabs';
import { TextLink } from '../components/layout/link';
import { LoadError, LoadingRows, LoadStale } from '../components/layout/load-state';
import { NativeSelect } from '../components/layout/native-select';
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { SearchInput } from '../components/layout/search-input';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { Table, type TableColumn } from '../components/layout/table';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { Toolbar } from '../components/layout/toolbar';
import {
  actionLabel,
  actorKindLabel,
  actorName,
  auditChangeLines,
  notificationIndex,
  routeModelNames,
  targetLabel,
  taskHintsFromAudit,
  taskIndex,
  viaLabel,
} from '../lib/audit';
import { describeAction, targetHref } from '../lib/audit-actions';
import { formatAgo, formatDateTime, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';

export function meta() {
  return [{ title: brand.title('操作记录') }];
}

// 操作记录靠推送重拉，没有自己的轮询。安静超过 5 分钟还没再读成，才标「数据已过期」。
const AUDIT_STALE_AFTER_MS = 5 * TIME.MIN;

const FILTERS: { id: 'all' | AuditEntry['actor']['kind']; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'user', label: '人' },
  { id: 'ai', label: brand.terms.marshal },
  { id: 'engine', label: '引擎' },
  { id: 'agent', label: '会话' },
];

function json(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/** 一行：表里要的都在这里算好。 */
interface Row {
  id: string;
  a: AuditEntry;
  who: string;
  text: string;
  target: string;
  href: string | null;
  /** 动作有中文对照；没有的显示「其他操作」，原文放在看原始数据里。 */
  translated: boolean;
}

/**
 * 行下面展开的明细：先写全出错原因和理由（行里一行放不下会截断），有改动再看人话差异，
 * 「看原始数据」收在里面那层，默认合上，里面有动作原文。路由编号换成模型名，对不上的留编号。
 */
function RecordDetails({
  row,
  routeNames,
  onTarget,
}: {
  row: Row;
  routeNames: ReadonlyMap<string, string>;
  onTarget: (target: string) => void;
}) {
  const { a } = row;
  const { before, after } = a;
  const hasChange = before !== undefined || after !== undefined;
  const lines = hasChange ? auditChangeLines(before, after, routeNames) : [];
  const items = [
    ...(a.reason ? [{ label: '理由', value: a.reason }] : []),
    ...lines.map((line) => ({
      label: line.label,
      value: `${line.before} → ${line.after}`,
    })),
  ];
  return (
    <Stack gap="md" data-audit-detail="">
      {a.error ? <Notice tone="fail">出错原因：{a.error}</Notice> : null}
      {items.length > 0 ? <Descriptions columns={1} items={items} /> : null}
      {hasChange && lines.length === 0 ? (
        <Text size="meta" tone="muted">
          这些字段都没变
        </Text>
      ) : null}
      <Stack direction="horizontal" gap="sm">
        <Button size="xs" variant="text" onClick={() => onTarget(a.target)}>
          只看这个对象
        </Button>
      </Stack>
      {hasChange || !row.translated ? (
        <Collapse title="看原始数据">
          <Stack gap="sm">
            <Stack gap="sm">
              <Text size="meta" tone="muted">
                动作原文
              </Text>
              <Text mono pre>
                {a.action}
              </Text>
            </Stack>
            {before !== undefined ? (
              <Stack gap="sm">
                <Text size="meta" tone="muted">
                  之前
                </Text>
                <Text mono pre>
                  {json(before)}
                </Text>
              </Stack>
            ) : null}
            {after !== undefined ? (
              <Stack gap="sm">
                <Text size="meta" tone="muted">
                  之后
                </Text>
                <Text mono pre>
                  {json(after)}
                </Text>
              </Stack>
            ) : null}
          </Stack>
        </Collapse>
      ) : null}
    </Stack>
  );
}

function OlderRecordsButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <Button size="sm" loading={pending} onClick={onClick}>
      {pending ? '正在读更早的…' : `再看 ${AUDIT_PAGE_SIZE} 条`}
    </Button>
  );
}

export default function Audit() {
  const [params, setParams] = useSearchParams();
  const target = params.get('target') ?? undefined;
  const audit = useAudit(target);
  const { boards } = useAllBoards();
  const { data: me } = useMe();
  const notices = useNotifications('all');
  const now = useNow();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  // 「经哪里」：每行不再重复标「经引擎」，要看某条渠道进来的记录在这里筛（悬停时间能看到每行的来路）。
  const [via, setVia] = useState<'all' | AuditEntry['via']>('all');
  const [q, setQ] = useState('');
  const routing = useRouting();
  const routeNames = routeModelNames(routing.data);
  // 没读到时 audit.data 为空，页面下面先判出错、加载、空再画；这里的空数组只喂搜索和索引，不画成「没有记录」
  const all = audit.data ? audit.data.pages.flatMap((p) => p.items) : [];
  // 看板索引还没到时，先用记录里自带的单号占位；看板到了盖上标题。提醒标题另从通知列表对。
  const tasks = useMemo(() => {
    const merged = taskHintsFromAudit(all);
    for (const [id, ref] of taskIndex(boards.flatMap((b) => b.tasks))) merged.set(id, ref);
    return merged;
  }, [all, boards]);
  const notifications = useMemo(
    () => notificationIndex(notices.data ? notices.data.items : []),
    [notices.data],
  );
  const query = q.trim();
  const list = all
    .filter((a) => filter === 'all' || a.actor.kind === filter)
    .filter((a) => via === 'all' || a.via === via)
    .filter(
      (a) =>
        !query ||
        `${actorName(a.actor, me)} ${actorName(a.actor)} ${actionLabel(a.action)} ${a.action} ${targetLabel(a.target, tasks, notifications)} ${a.reason ?? ''} ${a.error ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  const rows: Row[] = list.map((a) => {
    const described = describeAction(a.action);
    return {
      id: a.id,
      a,
      who: actorName(a.actor, me),
      text: described.text,
      translated: described.translated,
      target: targetLabel(a.target, tasks, notifications),
      href: described.translated ? targetHref(a.target) : null,
    };
  });

  const setTarget = (t: string | null) => {
    const p = new URLSearchParams(params);
    if (t) p.set('target', t);
    else p.delete('target');
    setParams(p, { replace: true });
  };
  const hasOlder = Boolean(audit.hasNextPage);
  const loadOlder = () => void audit.fetchNextPage();
  const searching = query.length > 0;
  const filtered = filter !== 'all' || via !== 'all' || searching || Boolean(target);
  const clearAll = () => {
    setFilter('all');
    setVia('all');
    setQ('');
    setTarget(null);
  };

  const columns: TableColumn<Row>[] = [
    {
      key: 'who',
      title: '谁',
      render: (_v, r) => (
        <span data-audit-who title={`${actorKindLabel[r.a.actor.kind]} · ${r.a.actor.id}`}>
          {r.who}
        </span>
      ),
    },
    {
      key: 'text',
      title: '做了什么',
      render: (_v, r) => (
        <Stack gap="sm">
          <Stack direction="horizontal" gap="sm" align="center">
            <Text strong title={r.a.action}>
              {r.text}
            </Text>
            {r.a.ok ? null : <Tag tone="error">没做成</Tag>}
          </Stack>
          {r.a.ok || !r.a.error ? null : (
            <Text size="meta" tone="danger" truncate title={r.a.error}>
              {r.a.error}
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: 'target',
      title: '对象',
      render: (_v, r) => <span data-audit-what>{r.target}</span>,
    },
    {
      key: 'at',
      title: '时间',
      render: (_v, r) => (
        <Text title={`${formatDateTime(r.a.at)} · 经${viaLabel[r.a.via]}`}>{formatAgo(r.a.at, now)}</Text>
      ),
    },
    {
      key: 'href',
      title: '操作',
      render: (_v, r) => (r.href ? <TextLink to={r.href}>查看</TextLink> : null),
    },
  ];

  // 搜索无结果且还有更早的：说清只搜了已加载的，点了继续往前翻。过滤空了才提换条件。
  const emptyHint = searching
    ? hasOlder
      ? `只搜了已加载的 ${all.length} 条。`
      : '换个过滤条件。'
    : hasOlder
      ? '换个过滤条件，或往前翻更早的。'
      : filtered
        ? '换个过滤条件。'
        : undefined;
  const empty = (
    <EmptyState
      icon={ScrollText}
      title="没有符合条件的记录"
      hint={emptyHint}
      action={
        <>
          {hasOlder ? <OlderRecordsButton pending={audit.isFetchingNextPage} onClick={loadOlder} /> : null}
          {filtered ? (
            <Button size="sm" onClick={clearAll}>
              清除过滤
            </Button>
          ) : null}
        </>
      }
    />
  );

  return (
    <Page
      title="操作记录"
      description={`谁在什么时候做了什么：人、${brand.terms.marshal}、引擎的动作都记在这里，只追加、不改。`}
      // 刷新走页头的固定槽位（#1940）。共用秒表一拍最多慢 1 秒：刚读成的时间戳比「现在」新时压回这一拍，避免显示成「1 秒后」。
      refresh={{
        onRefresh: () => void audit.refetch(),
        isFetching: audit.isFetching,
        dataUpdatedAt: audit.dataUpdatedAt > now ? now : audit.dataUpdatedAt,
        staleAfterMs: AUDIT_STALE_AFTER_MS,
      }}
    >
      <Stack>
        {audit.error && audit.data ? <LoadStale what="操作记录" error={audit.error} /> : null}
        <Toolbar
          start={
            <>
              <FilterTabs aria-label="按谁做的" items={FILTERS} value={filter} onChange={setFilter} />
              {target ? (
                // 只看某个对象：一个描边按钮写着对象名，点一下取消
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTarget(null)}
                  aria-label="不再只看这个对象"
                  title="不再只看这个对象"
                  data-audit-target
                >
                  只看 {targetLabel(target, tasks, notifications)}
                  <X aria-hidden />
                </Button>
              ) : null}
            </>
          }
          end={
            <>
              <NativeSelect
                aria-label="按来路筛选"
                value={via}
                onChange={(e) => setVia(e.target.value as typeof via)}
              >
                <option value="all">全部来路</option>
                {(Object.keys(viaLabel) as AuditEntry['via'][]).map((v) => (
                  <option key={v} value={v}>
                    经{viaLabel[v]}
                  </option>
                ))}
              </NativeSelect>
              <SearchInput
                value={q}
                onChange={setQ}
                inline
                placeholder="搜人、动作、对象、理由"
                aria-label="搜索操作记录"
              />
            </>
          }
        />
        {audit.error && !audit.data ? (
          <LoadError what="操作记录" error={audit.error} />
        ) : (
          <Section flush>
            {audit.isLoading ? (
              <LoadingRows rows={6} />
            ) : !audit.data ? (
              <Text tone="danger">没读到操作记录，这里空着不代表没人操作过</Text>
            ) : (
              <>
                <Table
                  caption="操作记录"
                  columns={columns}
                  rows={rows}
                  rowKey="id"
                  empty={empty}
                  expandable={{
                    render: (r) => <RecordDetails row={r} routeNames={routeNames} onTarget={setTarget} />,
                    rowExpandable: () => true,
                  }}
                />
                {rows.length > 0 && hasOlder ? (
                  <Stack align="center">
                    <OlderRecordsButton pending={audit.isFetchingNextPage} onClick={loadOlder} />
                  </Stack>
                ) : null}
              </>
            )}
          </Section>
        )}
      </Stack>
    </Page>
  );
}
