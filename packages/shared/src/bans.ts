// 全局硬禁令：创始人定的，写死在代码里，不靠数据库配置——库里的禁令表清空了也照样生效。
// 驾驶舱改路由顺序、换路由，引擎选路由，都先过这里，再并上库里的 bans。
import type { Model, StageKind } from './domain.ts';

export interface HardBan {
  id: string;
  reason: string;
  applies(model: Pick<Model, 'id' | 'family' | 'displayName'>, stage: StageKind | undefined): boolean;
}

export const HARD_BANS: readonly HardBan[] = [
  {
    id: 'gpt-no-ui',
    reason: 'GPT 不做 UI 类活',
    applies: (model, stage) => stage === 'ui' && model.family.trim().toLowerCase() === 'gpt',
  },
  {
    // Fable 算在 claude 族里，只能按模型本身认。
    id: 'no-fable',
    reason: '不用 Fable（出比 5.1 更高的版本之前）',
    applies: (model) => /fable/i.test(model.id) || /fable/i.test(model.displayName),
  },
];

export function hardBanFor(
  model: Pick<Model, 'id' | 'family' | 'displayName'>,
  stage: StageKind | undefined,
): HardBan | undefined {
  return HARD_BANS.find((ban) => ban.applies(model, stage));
}
