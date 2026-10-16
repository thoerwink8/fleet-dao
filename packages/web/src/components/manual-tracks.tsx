// 路由页「动手战绩」：模型 × 档。数是后端算好的（和选路的 modelTierTracks、质量下界同一份），这里只画表。
// 没接上（响应里没有 manualTracks）不画空表；读不成写原因；读成了但这一窗没有分档战绩，写明没有，不拿 0 顶。
import type { RoutingLayers } from '../api/types';
import { tierLabel } from '../lib/segments';
import { Section } from './layout/section';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

export type ManualTrackRow = NonNullable<RoutingLayers['manualTracks']>[number];

const HEADS = ['模型', '派工档', '一段过', '单数', '下界', '没做成', '平均分钟'] as const;

function cell(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n));
}

export function ManualTracksTable({ rows }: { rows: readonly ManualTrackRow[] }) {
  return (
    <Table aria-label="动手战绩">
      <TableHeader>
        <TableRow>
          {HEADS.map((name) => (
            <TableHead key={name}>{name}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.modelId}:${row.tier}`} data-manual-track={row.modelId} data-tier={row.tier}>
            <TableCell>{row.modelName}</TableCell>
            <TableCell>{tierLabel[row.tier]}</TableCell>
            <TableCell className="num" data-track="onePass">
              {cell(row.onePass)}
            </TableCell>
            <TableCell className="num" data-track="tasks">
              {cell(row.tasks)}
            </TableCell>
            <TableCell className="num" data-track="lower">
              {row.lower.toFixed(2)}
            </TableCell>
            <TableCell className="num" data-track="notDone">
              {cell(row.notDone)}
            </TableCell>
            <TableCell className="num" data-track="avgMinutes">
              {cell(row.avgMinutes)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
        <p role="note">动手战绩没读成：{data.manualTracksUnavailable}</p>
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
        <p className="text-body text-muted-foreground">近 14 天没有到终态的分档动手单</p>
      ) : (
        <ManualTracksTable rows={data.manualTracks} />
      )}
    </Section>
  );
}
