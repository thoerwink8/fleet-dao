// 别家验证要的：写这张单的会话用过哪几族（验证只派别家）。
import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { models, routes, sessionRuns } from '../schema/index.ts';

/**
 * 不算「写这张单」的阶段：验证、审查（第二意见、方案评审）只看不写，判断题不起会话。别的阶段（分诊、需求文档、方案、写码……）
 * 宁可多算：多算一族只是少一个能验的，少算了就可能派到同族自己验自己。
 */
const NOT_AUTHORING = ['verify', 'review', 'judge'] as const;

/**
 * 写这张单的会话用过的路由的族（去重、按字母排）：这张单上真起过（有开工时刻）的会话，按路由查模型目录里的族。
 * 一个都没有返回空数组——调用方要明确报错（判不了是不是别家），不当成「谁都能验」。
 */
export async function authorFamiliesOfTask(db: Db, taskId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ family: models.family })
    .from(sessionRuns)
    .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
    .innerJoin(models, eq(models.id, routes.modelId))
    .where(
      and(
        eq(sessionRuns.taskId, taskId),
        isNotNull(sessionRuns.startedAt),
        notInArray(sessionRuns.stage, [...NOT_AUTHORING]),
      ),
    );
  return rows.map((r) => r.family).sort();
}
