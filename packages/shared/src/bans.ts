// 全局硬禁令：创始人定的，写死在代码里，不靠数据库配置——库里的禁令表清空了也照样生效。
// 驾驶舱改路由顺序、换路由，引擎选路由，目录装载器收配置，都先过这里，再并上库里的 bans。
import type { Model, StageKind } from './domain.ts';

/**
 * 被判的对象：模型本身，外加（判路由时）插头实际发给上游的模型串和别名。
 * 只看模型 id 不够：目录里模型 id 写成 opus、上游串却是 Fable，照样要拦。
 */
export type BanSubject = Pick<Model, 'id' | 'family' | 'displayName'> & {
  upstreamModel?: string | null | undefined;
  upstreamAliases?: readonly string[] | undefined;
};

export interface HardBan {
  id: string;
  reason: string;
  applies(subject: BanSubject, stage: StageKind | undefined): boolean;
}

const names = (s: BanSubject) => [s.id, s.displayName, s.upstreamModel ?? '', ...(s.upstreamAliases ?? [])];

/** GPT：族写成 gpt 或 openai（不分大小写），或者任何一个名字里带 gpt。 */
const isGpt = (s: BanSubject) =>
  ['gpt', 'openai'].includes(s.family.trim().toLowerCase()) || names(s).some((n) => /gpt/i.test(n));

export const HARD_BANS: readonly HardBan[] = [
  {
    id: 'gpt-no-ui',
    reason: 'GPT 不做 UI 类活',
    applies: (subject, stage) => stage === 'ui' && isGpt(subject),
  },
  {
    // Fable 算在 claude 族里，只能按名字认：模型 id、显示名、上游串、别名，哪个带 fable 都算。
    id: 'no-fable',
    reason: '不用 Fable（出比 5.1 更高的版本之前）',
    applies: (subject) => names(subject).some((n) => /fable/i.test(n)),
  },
];

export function hardBanFor(subject: BanSubject, stage: StageKind | undefined): HardBan | undefined {
  return HARD_BANS.find((ban) => ban.applies(subject, stage));
}
