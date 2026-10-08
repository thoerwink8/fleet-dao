// 决定 0033：Fable 不再是硬禁令，改成「只有创始人本人在驾驶舱能开、能配进用途」。GPT × 界面照旧是硬禁令。
import { describe, expect, it } from 'vitest';
import {
  type BanSubject,
  founderOnlyDenial,
  founderOnlyFor,
  hardBanFor,
  type Operator,
} from '../src/bans.ts';

const fable: BanSubject = { id: 'claude-fable-5.2', family: 'claude', displayName: 'Claude Fable 5.2' };
const opus: BanSubject = { id: 'opus-5.5', family: 'claude', displayName: 'Opus 5.5' };
const gpt: BanSubject = { id: 'gpt-5.6', family: 'gpt', displayName: 'GPT 5.6' };

const founder: Operator = { label: '创始人（驾驶舱）', founderInCockpit: true };
const nonFounders: Operator[] = [
  { label: '引擎', founderInCockpit: false },
  { label: '临时指挥官（groom）', founderInCockpit: false },
  { label: 'fleet-api 命令', founderInCockpit: false },
  { label: '机器通行证', founderInCockpit: false },
];

describe('Fable：不是硬禁令，是只有创始人本人能开', () => {
  it('哪个阶段都不被硬禁令挡', () => {
    for (const stage of ['execute', 'ui', 'review', 'groom', undefined] as const) {
      expect(hardBanFor(fable, stage)).toBeUndefined();
    }
  });

  it('按模型 id、显示名、上游串、别名认，不分大小写', () => {
    expect(founderOnlyFor(fable)?.id).toBe('fable-founder-only');
    expect(founderOnlyFor({ ...opus, id: 'x-FABLE' })?.id).toBe('fable-founder-only');
    expect(founderOnlyFor({ ...opus, displayName: 'Fable 5.1' })?.id).toBe('fable-founder-only');
    expect(founderOnlyFor({ ...opus, upstreamModel: 'claude-fable-5-1' })?.id).toBe('fable-founder-only');
    expect(founderOnlyFor({ ...opus, upstreamAliases: ['fable'] })?.id).toBe('fable-founder-only');
    expect(founderOnlyFor(opus)).toBeUndefined();
  });

  it('创始人本人在驾驶舱里：放行；别的模型谁来都放行', () => {
    expect(founderOnlyDenial(fable, founder)).toBeUndefined();
    for (const who of [founder, ...nonFounders]) expect(founderOnlyDenial(opus, who)).toBeUndefined();
  });

  it('【故意造出的失败】引擎、临时指挥官、fleet-api 命令、机器通行证碰 Fable：都拒，原因写明是谁、为什么', () => {
    for (const who of nonFounders) {
      const why = founderOnlyDenial(fable, who);
      expect(why, who.label).toContain('只有创始人本人在驾驶舱');
      expect(why, who.label).toContain(who.label);
      expect(why, who.label).toContain('0033');
    }
    // 路由带的上游串是 Fable 也一样
    expect(
      founderOnlyDenial({ ...opus, upstreamModel: 'claude-fable-5-1' }, nonFounders[0] as Operator),
    ).toBeDefined();
  });
});

describe('GPT × 界面照旧是硬禁令', () => {
  it('界面用途挡、别的用途不挡', () => {
    expect(hardBanFor(gpt, 'ui')?.id).toBe('gpt-no-ui');
    expect(hardBanFor(gpt, 'execute')).toBeUndefined();
  });
});
