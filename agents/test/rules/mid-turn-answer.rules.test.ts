// 钉住通用段「引导没进到这一轮就等下一轮补上，说过的不重说」（改标准：改这个文件要创始人同意）。
// 2026-10-05 的原条是「这一轮结束不了的时候把答案 deliver 出去」。没开无人值守时这一轮可以结束（决定 0026），
// 最后一条就是答复；没塞进来的引导由下一轮开头补上（无人值守开着、这一轮被挡住的情形见决定 0028）。说过的不重说、没新结果不写话，这两样留下。
// 2026-10-10 这条开头加了「一送到先回一句、关系到子代理就 SendMessage 转」（决定 0078，钉在 steer-and-subagents.rules.test.ts），
// 「下一轮补上」那句改成「这一轮没进到你这里的，……」接在后面。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RULES = readFileSync(fileURLToPath(new URL('../../shared-rules.md', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** 通用段里必须写着的几样，缺了哪样就列出哪样。 */
const MID_TURN_RULES: Record<string, RegExp> = {
  引导下一轮补上: /这一轮没进到你这里的，下一轮开头会补上，先答那个/,
  说过的不重说: /说过的不在后面每一步开头重说/,
  没新结果不写话: /两次工具调用之间没有新结果就不写话/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

describe('规矩：引导没进来就等下一轮补上，说过的不重说（决定 0026）', () => {
  it('通用段里这几样都在', () => {
    expect(missing(MID_TURN_RULES, RULES)).toEqual([]);
  });

  it('紧跟在「我问了问题，答案放在这一轮的最后一条」那条后面', () => {
    expect(RULES).toMatch(
      /- 我问了问题，答案放在这一轮的最后一条[^\n]*\n- 我中途的引导只在两次工具调用之间送到[^\n]*这一轮没进到你这里的/,
    );
  });

  it('【故意造出的失败】整条删掉：三样都查得出缺', () => {
    const cut = RULES.replace(/- 我中途的引导只在两次工具调用之间送到[^\n]*\n/, '');
    expect(cut).not.toBe(RULES);
    expect(missing(MID_TURN_RULES, cut)).toEqual(Object.keys(MID_TURN_RULES));
  });
});
