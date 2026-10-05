/**
 * 别的环境推来的快照（node_reports）两套 Store 共用的校验：写进去之前、读回来之后都照 shared 的契约认一遍，
 * 认不出就抛 InvalidNodeReportError，不存半截、不拿坏的冒充有。
 */
import {
  NODE_REPORT_SCHEMA_VERSION,
  NodeIdSchema,
  type NodeReport,
  NodeReportSchema,
  type NodeSnapshot,
} from '@fleet-dao/shared';
import type { z } from 'zod';
import { InvalidNodeReportError, type NodeReportSummary } from './ports.ts';

const SnapshotSchema = NodeReportSchema.pick({ home: true, env: true });

const issuesOf = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '（整份）'}：${i.message}`)
    .join('；');

/** 要写进去的那一行（不含收到的时刻，由各 Store 用自己的钟填）和剥掉多余字段的快照本体。 */
export function nodeReportRow(input: { nodeId: string; report: NodeReport }): {
  row: Omit<NodeReportSummary, 'receivedAt'>;
  snapshot: NodeSnapshot;
} {
  if (!NodeIdSchema.safeParse(input.nodeId).success) {
    throw new InvalidNodeReportError(`环境编号认不出：${JSON.stringify(input.nodeId)}`);
  }
  const parsed = NodeReportSchema.safeParse(input.report);
  if (!parsed.success) {
    throw new InvalidNodeReportError(`${input.nodeId} 推来的快照认不出：${issuesOf(parsed.error)}`);
  }
  const { schemaVersion, reportedAt, codeSha, home, env } = parsed.data;
  return {
    row: { nodeId: input.nodeId, displayName: env.name.name, schemaVersion, codeSha, reportedAt },
    snapshot: { home, env },
  };
}

/** 库里读回来的快照本体：版本对不上、形状坏了都抛错，不当成没有。 */
export function readNodeSnapshot(nodeId: string, schemaVersion: number, payload: unknown): NodeSnapshot {
  if (schemaVersion !== NODE_REPORT_SCHEMA_VERSION) {
    throw new InvalidNodeReportError(
      `${nodeId} 存着的快照是第 ${schemaVersion} 版，这份代码只认第 ${NODE_REPORT_SCHEMA_VERSION} 版`,
    );
  }
  const parsed = SnapshotSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidNodeReportError(`${nodeId} 存着的快照认不出：${issuesOf(parsed.error)}`);
  }
  return parsed.data;
}
