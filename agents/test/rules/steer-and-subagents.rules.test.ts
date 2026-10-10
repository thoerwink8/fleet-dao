// 钉住创始人 2026-10-10 13:02 同意的「引导三条」（决定 0078；改标准：改这个文件要创始人同意，agents/test/rules/ 在清单里）。
// 命令行里中途打的字在两次工具调用之间送到主会话；Mirasim 的「引导」要等这一轮结束才送到（#1743 补 0078，见第 4 条）：
// 1. 引导一送到，下一次调工具之前先回他一句，不然他不知道收到没有；
// 2. 派 Agent 子代理一律后台跑，主对话留在这一轮等完成通知、单次前台等待不超过 60 秒——前台子代理一跑几分钟，他的引导这期间送不进来；
//    以前这条只写在无人值守里，现在不分无人值守与否；
// 3. 引导关系到某个在跑的子代理的活，用 SendMessage 把原话转给它，不等它跑完、不另起一个。
// 4. Mirasim 的引导在等，就让这一轮先结束（#1743）：调工具前钩子拒调用、叫它写一句收到马上收尾，无人值守的收尾钩子放行；
//    第 2 条「派了这一轮不结束」因此有个例外。钩子本身钉在 mirasim-steer.rules.test.ts，这里钉文字。
// 四条都要在通用段（每台机器的全局说明，只写要点）和 commander 技能（指挥官派活时读，写细则）里读得到。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const SHARED = read('../../shared-rules.md');
const SKILL = read('../../skills/commander/SKILL.md');

/** 通用段里以这个开头的那一条（整行）；没有就是空串。 */
const bullet = (text: string, head: string) => text.split('\n').find((l) => l.startsWith(head)) ?? '';

/**
 * 通用段：三条各自要写着的几样。通用段有字数上限（agents-md-budget.test.ts），这里只写要点；
 * 「为什么」「怎么等」「不另起一个」的细则在 commander 技能和决定 0078，下面 SKILL_RULES 钉。
 */
const SHARED_RULES: Record<string, (t: string) => boolean> = {
  调工具前先回引导: (t) => bullet(t, '- 我中途的引导').includes('一送到，先回我一句再调工具'),
  子代理一律后台跑: (t) => {
    const l = bullet(t, '- Agent 子代理');
    return (
      l.includes('一律后台跑') &&
      l.includes('派了这一轮不结束、等完成通知') &&
      l.includes('单次前台等待不超过 60 秒') &&
      !l.includes('无人值守')
    );
  },
  引导用SendMessage转给子代理: (t) =>
    bullet(t, '- 我中途的引导').includes('涉及在跑的子代理，用 `SendMessage` 原话转它'),
  Mirasim引导在等就结束这一轮: (t) => {
    const l = bullet(t, '- 我中途的引导');
    return l.includes('Mirasim 的引导要等这一轮结束才送到') && l.includes('回一句收到、马上结束这一轮');
  },
  留在本轮等有例外: (t) =>
    bullet(t, '- Agent 子代理').includes('派了这一轮不结束、等完成通知（有引导在等时除外）'),
};

/** commander 技能「派活」的引导那条（#1743 起不再说「只在两次工具调用之间送到」） */
const STEER_HEAD = '- 他的引导怎么送到';

/** commander 技能「派活」：四条各自要写着的几样。 */
const SKILL_RULES: Record<string, (t: string) => boolean> = {
  调工具前先回引导: (t) => bullet(t, STEER_HEAD).includes('下一次调工具之前先回他一句'),
  子代理一律后台跑: (t) => {
    const l = bullet(t, '- **默认用 Agent 子代理');
    return (
      l.includes('一律后台跑') &&
      l.includes('`run_in_background: false`') &&
      l.includes('派了它这一轮就不结束') &&
      l.includes('前台单次等待不超过 60 秒')
    );
  },
  引导用SendMessage转给子代理: (t) => {
    const l = bullet(t, STEER_HEAD);
    return l.includes('`SendMessage` 把原话转给它') && l.includes('不等它跑完、也不另起一个');
  },
  Mirasim引导在等就结束这一轮: (t) => {
    const l = bullet(t, STEER_HEAD);
    return (
      l.includes('Mirasim 的「引导」要等这一轮结束才送到') &&
      l.includes('`agents/hooks/main-thread.mjs`') &&
      l.includes('写一句收到、马上结束这一轮') &&
      l.includes('无人值守的收尾钩子这时放行')
    );
  },
  留在本轮等有例外: (t) =>
    bullet(t, '- **默认用 Agent 子代理').includes('派了它这一轮就不结束（Mirasim 里有引导在等时除外') &&
    bullet(t, '- **无人值守**（').includes('Mirasim 里有引导在等时也放行'),
};

function missing(rules: Record<string, (t: string) => boolean>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, ok]) => !ok(text))
    .map(([name]) => name);
}

describe('规矩：引导三条（决定 0078）和 Mirasim 引导在等就收尾（#1743）', () => {
  it('通用段里四条都在', () => {
    expect(missing(SHARED_RULES, SHARED)).toEqual([]);
  });

  it('commander 技能「派活」里四条都在', () => {
    expect(missing(SKILL_RULES, SKILL)).toEqual([]);
  });

  it('旧说法「他的引导只在两次工具调用之间送到」已删（对 Mirasim 的引导不成立）', () => {
    expect(SKILL).not.toContain('他的引导只在两次工具调用之间送到');
  });

  it('【故意造出的失败】把 Mirasim 那句、例外那句删掉：查得出缺', () => {
    const noMirasim = SHARED.replace('Mirasim 的引导要等这一轮结束才送到', '引导两次工具调用之间送到');
    expect(noMirasim).not.toBe(SHARED);
    expect(missing(SHARED_RULES, noMirasim)).toEqual(['Mirasim引导在等就结束这一轮']);
    const noException = SHARED.replace('（有引导在等时除外）', '');
    expect(noException).not.toBe(SHARED);
    expect(missing(SHARED_RULES, noException)).toEqual(['留在本轮等有例外']);
    const noRelease = SKILL.replace('Mirasim 里有引导在等时也放行', '');
    expect(noRelease).not.toBe(SKILL);
    expect(missing(SKILL_RULES, noRelease)).toEqual(['留在本轮等有例外']);
    const oldHead = SKILL.replace(STEER_HEAD, '- 他的引导只在两次工具调用之间送到');
    expect(oldHead).not.toBe(SKILL);
    expect(missing(SKILL_RULES, oldHead)).toEqual([
      '调工具前先回引导',
      '引导用SendMessage转给子代理',
      'Mirasim引导在等就结束这一轮',
    ]);
  });

  it('等待上限只有一个数：通用段只在「Agent 子代理」那条写一次，技能里不再写 55 秒', () => {
    expect(bullet(SHARED, '- 无人值守')).not.toContain('前台等待');
    expect(SHARED.match(/前台等待不超过 \d+ 秒/g)).toEqual(['前台等待不超过 60 秒']);
    expect(SKILL).not.toMatch(/前台单次等待不超过 55 秒/);
  });

  it('【故意造出的失败】三处各删一样：每条都查得出缺', () => {
    const noReply = SHARED.replace('先回我一句再调工具', '接着调工具');
    expect(noReply).not.toBe(SHARED);
    expect(missing(SHARED_RULES, noReply)).toEqual(['调工具前先回引导']);

    const foreground = SHARED.replace('一律后台跑', '前台跑');
    expect(foreground).not.toBe(SHARED);
    expect(missing(SHARED_RULES, foreground)).toEqual(['子代理一律后台跑']);

    const onlyUnattended = SHARED.replace(/^- Agent 子代理([^\n]*)$/m, '- Agent 子代理$1无人值守时');
    expect(onlyUnattended).not.toBe(SHARED);
    expect(missing(SHARED_RULES, onlyUnattended)).toEqual(['子代理一律后台跑']);

    const noForward = SKILL.replace('`SendMessage` 把原话转给它', '等它跑完再说');
    expect(noForward).not.toBe(SKILL);
    expect(missing(SKILL_RULES, noForward)).toEqual(['引导用SendMessage转给子代理']);
  });

  it('【故意造出的失败】那几条整条删掉：三样都查得出缺', () => {
    const cutShared = SHARED.replace(/^- 我中途的引导[^\n]*\n/m, '').replace(/^- Agent 子代理[^\n]*\n/m, '');
    expect(missing(SHARED_RULES, cutShared)).toEqual(Object.keys(SHARED_RULES));
    const cutSkill = SKILL.replace(/^- 他的引导怎么送到[^\n]*\n/m, '').replace(
      /^- \*\*默认用 Agent 子代理[^\n]*\n/m,
      '',
    );
    expect(missing(SKILL_RULES, cutSkill)).toEqual(Object.keys(SKILL_RULES));
  });
});
