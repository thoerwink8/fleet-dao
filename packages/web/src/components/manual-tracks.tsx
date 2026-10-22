// 路由页「动手战绩」：模型 × 档。数是后端算好的（和选路的 modelTierTracks、质量下界同一份），这里只画表。
// 没接上（响应里没有 manualTracks）不画空表；读不成写原因；读成了但这一窗没有分档战绩，写明没有，不拿 0 顶。
import type { RoutingLayers } from '../api/types';
import { tierLabel } from '../lib/segments';
import { Section } from './layout/section';
import { Table, type TableColumn } from './layout/table';
import { Text } from './layout/text';

export type ManualTrackRow = NonNullable<RoutingLayers['manualTracks']>[number];

function cell(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n));
}

/** 一个数字格：data-track 标出是哪一列（测试、e2e 按它找）。 */
function numCol(
  key: 'onePass' | 'tasks' | 'lower' | 'notDone' | 'avgMinutes',
  title: string,
  show: (row: ManualTrackRow) => string,
): TableColumn<ManualTrackRow> {
  return {
    key,
    title,
    align: 'right',
    render: (_v, row) => (
      <span className="num" data-track={key}>
        {show(row)}
      </span>
    ),
  };
}

const COLUMNS: readonly TableColumn<ManualTrackRow>[] = [
  { key: 'modelName', title: '模型' },
  { key: 'tier', title: '派工档', render: (_v, row) => tierLabel[row.tier] },
  numCol('onePass', '一段过', (r) => cell(r.onePass)),
  numCol('tasks', '单数', (r) => cell(r.tasks)),
  numCol('lower', '下界', (r) => r.lower.toFixed(2)),
  numCol('notDone', '没做成', (r) => cell(r.notDone)),
  numCol('avgMinutes', '平均分钟', (r) => cell(r.avgMinutes)),
];

export function ManualTracksTable({ rows }: { rows: readonly ManualTrackRow[] }) {
  return (
    <Table
      caption="动手战绩"
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => `${row.modelId}:${row.tier}`}
      rowData={(row) => ({ 'data-manual-track': row.modelId, 'data-tier': row.tier })}
    />
  );
}

/** 路由页用途页签上的一块。没给 manualTracks 就不画（这一层没接上，不拿空表冒充没有战绩）。 */
export function ManualTracks({
  data,
}: {
  data: Pick<RoutingLayers, 'manualTracks' | 'manualTracksUnavailable'>;
}) {
  if (data.manualTracksUnavailable) {
    return (
      <Section title="动手战绩">
        <div role="note">
          <Text as="p">动手战绩没读成：{data.manualTracksUnavailable}</Text>
        </div>
      </Section>
    );
  }
  if (!data.manualTracks) return null;
  return (
    <Section
      title="动手战绩"
      description="近 14 天第一段动手，按模型和派工档（单子的难易档，不是模型的强弱档）。下界和选路用的是同一份。"
      flush={data.manualTracks.length > 0}
    >
      {data.manualTracks.length === 0 ? (
        <Text as="p" tone="muted">
          近 14 天没有到终态的分档动手单
        </Text>
      ) : (
        <ManualTracksTable rows={data.manualTracks} />
      )}
    </Section>
  );
}
