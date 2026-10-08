// 全局硬禁令：创始人定的，写死在代码里，不靠数据库配置——库里的禁令表清空了也照样生效。
// 驾驶舱改路由顺序、换路由，引擎选路由，目录装载器收配置，都先过这里，再并上库里的 bans。
// 现在只剩 GPT × 界面一条（Fable 在 2026-10-08 起改成「只有创始人本人能开」，见文件下半，决定 0033）。
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
];

export function hardBanFor(subject: BanSubject, stage: StageKind | undefined): HardBan | undefined {
  return HARD_BANS.find((ban) => ban.applies(subject, stage));
}

// —— 只有创始人本人能开的（决定 0033，取代 0017 第 1、3 条）——
// Fable 不再是硬禁令：它能进目录、能入库（默认关着、不在任何用途里）。但把它的路由 / 模型打开、或加进任何用途，
// 只认驾驶舱里创始人本人的登录态。开关、拖动、加进用途的接口都先过这里，同一个判法；引擎、临时指挥官（groom）、
// `fleet-api` 命令、机器通行证来的一律拒，并写明原因。

/** Fable 算在 claude 族里，只能按名字认：模型 id、显示名、上游串、别名，哪个带 fable 都算。 */
export const isFable = (s: BanSubject): boolean => names(s).some((n) => /fable/i.test(n));

export interface FounderOnlyRule {
  id: string;
  reason: string;
}

const FABLE_FOUNDER_ONLY: FounderOnlyRule = {
  id: 'fable-founder-only',
  reason: 'Fable 只有创始人本人在驾驶舱能打开、能配进用途（决定 0033）',
};

/** 这个模型 / 路由是不是「只有创始人本人能开」的：是就返回规则，不是返回 undefined。 */
export function founderOnlyFor(subject: BanSubject): FounderOnlyRule | undefined {
  return isFable(subject) ? FABLE_FOUNDER_ONLY : undefined;
}

/**
 * 谁在动手。founderInCockpit 只有「驾驶舱里创始人本人的浏览器登录态」才是 true：
 * 网关通行证、fleet 令牌、引擎、临时指挥官、命令行都是 false，不管它代表谁。
 */
export interface Operator {
  /** 引擎 / 临时指挥官 / 命令行 / 通行证这类写它自己的名字，原因里原样带上。 */
  label: string;
  founderInCockpit: boolean;
}

/** 这个人能不能对 subject 做「打开 / 配进用途 / 拖动」：能返回 undefined，不能返回白话原因。 */
export function founderOnlyDenial(subject: BanSubject, operator: Operator): string | undefined {
  const rule = founderOnlyFor(subject);
  if (rule === undefined || operator.founderInCockpit) return undefined;
  return `${rule.reason}；${operator.label}不行`;
}
