// 引擎提问：按 id 幂等地写一条 asks（runId 对不上会话时退成不挂会话），挂得上会话就同事务补一条进度事件。
import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { asks, progressEvents } from '../schema/index.ts';

/** 按约束名认错误，不认报错措辞：postgres.js 和 PGlite 的报错文案不同，但都会把约束名放进 message。 */
function isConstraintError(err: unknown, constraint: string): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e.message.includes(constraint)) return true;
  }
  return false;
}

/**
 * 引擎提问：按 id 幂等（已有 → created=false）。runId 给了但撞上 (run_id, md5(question)) 唯一（会话已经用
 * fleet ask 问过同一句）或 (task_id, run_id) 外键不满足（这个 runId 不属于这个 taskId 名下的会话）时，
 * 改用 run_id=null 再插一次，runLinked=false；任务不在照常抛。
 * recommended、scope（#259）给了就照抄进这一行，只给一个也照写——scope 给了但 recommended 不在 options 里
 * 会被 asks_scoped_recommendation 约束拦下，这里不重复判。
 */
export async function openEngineAsk(
  db: Db,
  input: {
    id: string;
    taskId: string;
    runId: string | null;
    question: string;
    options: string[];
    recommended?: string;
    scope?: 'task' | 'outside';
  },
): Promise<{ created: boolean; runLinked: boolean }> {
  return db.transaction(async (tx) => {
    const askedAt = new Date();
    const values = (runId: string | null) => ({
      id: input.id,
      taskId: input.taskId,
      runId,
      question: input.question,
      options: input.options,
      recommended: input.recommended ?? null,
      scope: input.scope ?? null,
      askedAt,
    });

    let rows: (typeof asks.$inferSelect)[];
    if (input.runId === null) {
      rows = await tx.insert(asks).values(values(null)).onConflictDoNothing().returning();
    } else {
      try {
        // (run_id, question) 唯一冲突会被 onConflictDoNothing 接住（返回空，不抛）；只有外键不满足会抛错。
        // 抛错会让外层事务作废，用子事务（保存点）兜住这一步，抛了照样能接着往下走。
        rows = await tx.transaction((sp) =>
          sp.insert(asks).values(values(input.runId)).onConflictDoNothing().returning(),
        );
      } catch (err) {
        if (!isConstraintError(err, 'asks_run_in_task_fk')) throw err;
        rows = [];
      }
    }

    let row = rows[0];
    let created = row !== undefined;
    if (!row) {
      const [existing] = await tx.select().from(asks).where(eq(asks.id, input.id));
      if (existing) {
        row = existing;
      } else {
        const [fallback] = await tx.insert(asks).values(values(null)).onConflictDoNothing().returning();
        if (!fallback) throw new Error(`引擎提问 ${input.id} 写不进也读不到`);
        row = fallback;
        created = true;
      }
    }

    if (created && row.runId !== null) {
      // 和 api 的 openAsk 一样：同一事务里补一条进度事件，不会出现「追问开了、进度没记」的半截。
      await tx.insert(progressEvents).values({
        runId: row.runId,
        at: askedAt,
        kind: 'ask',
        payload: { askId: row.id, question: input.question },
      });
    }
    return { created, runLinked: row.runId !== null };
  });
}
