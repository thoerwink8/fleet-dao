// 法国页的「机器」表（#820 的对照、#1221 快照 404、#1888 久没报的收起来；#3509 起照 Arco 样稿 canvas/France.dc.html 是一张表）：
// 第一行是本台（写操作在这里做），后面一台远程环境一行：环境、类型、状态（在线 / 失联 / 没数据）、说明；点行首的箭头展开那一台最后一次报的快照。
// 不再每台一列并排：久没报的环境收在表里，默认收着，不占版面；正在看的那一台（?node=）默认展开。
// 快照怎么读、读不到怎么写：从没收到过写「从没收到过」；404 写「没有这个环境」给回主页的路、不给重试（#1221）；
// 别的读失败写没读成加原因带重试；推送重读不清掉上一次的失败（useShownError）。失联的快照一律灰字、标明是旧数据。
import { SearchX } from 'lucide-react';
import { isNotFound } from '../api/client';
import type { EnvFacts, NodeDetail, NodeListItem } from '../api/types';
import { formatDuration, TIME } from '../lib/format';
import { freshnessNow, nodeAgeText } from '../lib/node';
import { useShownError } from '../lib/shown-error';
import type { StatusKey } from '../theme/status-dict';
import { FactsList, factsSummary } from './env-facts';
import { Button } from './layout/button';
import { LoadError, LoadingRows } from './layout/load-state';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Table, type TableColumn } from './layout/table';
import { Text } from './layout/text';

/** 远程环境超过这么久没报，说明里写「旧数据」（#1888）。24 小时：一天没报的环境，旧的「运行中」「N 项红」不再有对比价值。 */
const STALE_NODE_FOLD_MS = 24 * TIME.HOUR;

type Snap = { error: unknown; data: NodeDetail | undefined; refetch: () => unknown } | undefined;

interface MachineRow {
  id: string;
  name: string;
  kind: '本台' | '远程';
  state: StatusKey;
  note: string;
  node?: NodeListItem;
}

const isLongGone = (n: NodeListItem, now: number): boolean =>
  freshnessNow(n, now) === 'stale' &&
  n.receivedAt !== undefined &&
  now - Date.parse(n.receivedAt) > STALE_NODE_FOLD_MS;

/** 这一台的快照 404：没有这个环境，给回主页的路，不给「重试」（#1221）。 */
function MissingSnapshot({ nodeId }: { nodeId: string }) {
  return (
    <Notice
      tone="fail"
      title="没有这个环境"
      action={
        <Button size="xs" variant="secondary" href="/">
          回主页
        </Button>
      }
    >
      <Stack direction="horizontal" gap="sm" align="center">
        <SearchX aria-hidden width={16} height={16} />
        <span>
          库里没有编号为「<Text mono>{nodeId}</Text>
          」的环境：可能链接里的编号写错了，或这个环境已经不在了。
        </span>
      </Stack>
    </Notice>
  );
}

/** 展开的那一台：最后一次报的快照。读不到各写各的，不画空格子。 */
function RemoteDetail({ n, snap, now }: { n: NodeListItem; snap: Snap; now: number }) {
  const f = freshnessNow(n, now);
  const error = useShownError(n.id, { error: snap?.error, data: snap?.data });
  if (f === 'never' || snap === undefined) {
    return (
      <span data-env-never>
        <Text tone="secondary">
          配了通行证，但从没收到过{n.name}的快照：先去那台上把推送接上（docs/ops.md「接上法国看板」）。
        </Text>
      </span>
    );
  }
  if (error && isNotFound(error)) return <MissingSnapshot nodeId={n.id} />;
  if (error) return <LoadError what={`${n.name}的快照`} error={error} onRetry={() => void snap.refetch()} />;
  if (!snap.data) return <LoadingRows rows={4} />;
  const stale = f !== 'fresh';
  return (
    <Stack gap="md">
      {stale ? (
        <Notice tone="stall">
          失联，以下是旧数据。下面是它最后一次报的样子，不是现在的；要看现在的请去那台上看。
        </Notice>
      ) : (
        <Text size="meta" tone="muted">
          只读快照：写操作（暂停派活、叫停）要去那台上做。
        </Text>
      )}
      <FactsList facts={snap.data.env.facts} now={now} muted={stale} />
    </Stack>
  );
}

export function Machines({
  localName,
  localProblem,
  localFacts,
  nodes,
  nodesLoading,
  snapshotOf,
  selectedId,
  now,
}: {
  localName: string;
  localProblem?: string | undefined;
  localFacts: EnvFacts | undefined;
  nodes: readonly NodeListItem[];
  nodesLoading: boolean;
  snapshotOf: (n: NodeListItem) => Snap;
  selectedId: string | null;
  now: number;
}) {
  const summary = localFacts ? factsSummary(localFacts) : null;
  const rows: MachineRow[] = [
    {
      id: 'local',
      name: localName,
      kind: '本台',
      state: 'machine:node:fresh',
      note: ['就是这台，写操作在这里做', localProblem, summary].filter(Boolean).join(' · '),
    },
    ...nodes.map((n): MachineRow => {
      const f = freshnessNow(n, now);
      const note =
        f === 'fresh'
          ? `上报于 ${nodeAgeText(n, now)}`
          : f === 'never'
            ? '从没收到过快照'
            : isLongGone(n, now) && n.receivedAt !== undefined
              ? `${nodeAgeText(n, now)}，${formatDuration(now - Date.parse(n.receivedAt))}前的旧数据（不跑引擎时正常）`
              : nodeAgeText(n, now);
      return {
        id: n.id,
        name: snapshotOf(n)?.data?.name ?? n.name,
        kind: '远程',
        state:
          f === 'fresh' ? 'machine:node:fresh' : f === 'stale' ? 'machine:node:stale' : 'machine:node:never',
        note,
        node: n,
      };
    }),
  ];
  const columns: TableColumn<MachineRow>[] = [
    {
      key: 'name',
      title: '环境',
      render: (_, r) => (
        <span data-env-row={r.id} data-env-selected={r.id === (selectedId ?? 'local')}>
          <Text strong>{r.name}</Text>
        </span>
      ),
    },
    { key: 'kind', title: '类型', render: (_, r) => <Text tone="secondary">{r.kind}</Text> },
    {
      key: 'state',
      title: '状态',
      render: (_, r) => <StatusBadge status={r.state} variant="dot" />,
    },
    {
      key: 'note',
      title: '说明',
      render: (_, r) => (
        <span data-env-note={r.id}>
          <Text tone="muted">{r.note}</Text>
        </span>
      ),
    },
  ];
  return (
    <Section flush title="机器" data-machines>
      <Table<MachineRow>
        caption="机器"
        columns={columns}
        rows={rows}
        rowKey="id"
        {...(nodesLoading ? { load: { state: 'loading' as const } } : {})}
        selectedKey={selectedId}
        expandable={{
          rowExpandable: (r) => r.node !== undefined,
          render: (r) => (r.node ? <RemoteDetail n={r.node} snap={snapshotOf(r.node)} now={now} /> : null),
          defaultExpandedKeys: selectedId ? [selectedId] : [],
        }}
      />
    </Section>
  );
}
