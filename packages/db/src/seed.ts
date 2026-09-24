// 种子：通用的族、模型、渠道类型示例，每个阶段一行空顺序。
// 不放任何账号信息：账号池、路由、成员、额度都不放（公开仓，账号在机器本地配置）。跑几遍结果都一样。
// 全局禁令（GPT 不做 UI、不用 Fable）写死在 @fleet-dao/shared 的 bans.ts，不进库；bans 表只放创始人另加的。
import type { Db } from './client.ts';
import { STAGE_KINDS } from './schema/enums.ts';
import { channels, families, models, stagePolicies } from './schema/index.ts';

export const SEED = {
  families: [
    { id: 'claude', displayName: 'Claude', vendor: 'Anthropic' },
    { id: 'gpt', displayName: 'GPT', vendor: 'OpenAI' },
    { id: 'grok', displayName: 'Grok', vendor: 'xAI' },
    { id: 'kimi', displayName: 'Kimi', vendor: 'Moonshot AI' },
    { id: 'deepseek', displayName: 'DeepSeek', vendor: 'DeepSeek' },
    { id: 'cursor', displayName: 'Cursor', vendor: 'Anysphere' },
  ],
  models: [
    { id: 'opus-5.5', family: 'claude', displayName: 'Opus 5.5' },
    { id: 'fable-5.1', family: 'claude', displayName: 'Fable 5.1' },
    { id: 'gpt-5.6-luna', family: 'gpt', displayName: 'GPT 5.6 luna' },
    { id: 'grok-4.7', family: 'grok', displayName: 'Grok 4.7' },
    { id: 'kimi-k3', family: 'kimi', displayName: 'Kimi k3' },
    { id: 'cursor-auto', family: 'cursor', displayName: 'Cursor Auto' },
  ],
  channels: [
    { id: 'claude-subscription', name: 'Claude 订阅', billing: 'subscription', enabled: true },
    { id: 'mirasim-cloud', name: 'Mirasim 云端', billing: 'subscription', enabled: true },
    { id: 'cursor', name: 'Cursor 订阅', billing: 'subscription', enabled: true },
    { id: 'grok-subscription', name: 'Grok 订阅', billing: 'subscription', enabled: true },
    { id: 'kimi-subscription', name: 'Kimi Code 订阅', billing: 'subscription', enabled: true },
    // 按量 = 花钱（人闸）：先由创始人定月度上限再打开。
    { id: 'api-metered', name: '按量接口', billing: 'metered', enabled: false },
  ],
} as const satisfies {
  families: (typeof families.$inferInsert)[];
  models: (typeof models.$inferInsert)[];
  channels: (typeof channels.$inferInsert)[];
};

/** 写入种子；已存在的行不动。返回这次新写了几行。 */
export async function seed(
  db: Db,
): Promise<Record<'families' | 'models' | 'channels' | 'stagePolicies', number>> {
  return db.transaction(async (tx) => {
    const insertedFamilies = await tx
      .insert(families)
      .values([...SEED.families])
      .onConflictDoNothing()
      .returning();
    const insertedModels = await tx
      .insert(models)
      .values([...SEED.models])
      .onConflictDoNothing()
      .returning();
    const insertedChannels = await tx
      .insert(channels)
      .values([...SEED.channels])
      .onConflictDoNothing()
      .returning();
    const insertedPolicies = await tx
      .insert(stagePolicies)
      .values(STAGE_KINDS.map((stage) => ({ stage })))
      .onConflictDoNothing()
      .returning();
    return {
      families: insertedFamilies.length,
      models: insertedModels.length,
      channels: insertedChannels.length,
      stagePolicies: insertedPolicies.length,
    };
  });
}
