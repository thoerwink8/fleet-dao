// 「提示词里加一句可以派哪些子代理」的开关（#1641 第 4c 片）：设置表里 engine.subagentHint 那一行。
// 默认关：验收量完（specs/1641-子代理分档/法国实装.md 第六节）再由指挥官开。没设过、值不是 true 都按关。
import { SUBAGENT_HINT_SETTING } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { settings } from '../schema/index.ts';

/** 库读不了照抛，调用方决定怎么办；没设过、值不是 true 回 false。 */
export async function readSubagentHint(db: Db): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SUBAGENT_HINT_SETTING));
  return row?.value === true;
}
