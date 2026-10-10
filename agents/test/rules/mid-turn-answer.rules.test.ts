// 钉住通用段里关于「引导」和「子代理后台跑」的几句（改标准：改这个文件要创始人同意）。
// 2026-10-05 的原条是「这一轮结束不了的时候把答案 deliver 出去」。没开无人值守时这一轮可以结束（决定 0026），
// 最后一条就是答复；没塞进来的引导由下一轮开头补上（无人值守开着、这一轮被挡住的情形见决定 0028）。说过的不重说、没新结果不写话，这两样留下。
// 2026-10-10 决定 0078（创始人 13:02「都按你的推荐来。」）：收到的引导下一句先回、涉及在跑的子代理用 SendMessage 转并告诉他；
// 子代理一律后台跑、主对话留在这一轮、单次前台等待不超过 60 秒、跑完再收尾（钩子 agents/hooks/main-thread.mjs 管着，
// 但别家没有这个钩子，只能照文字做）。「单次前台等待不超过 60 秒」从无人值守那条挪到子代理这句，并成一处。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RULES = readFileSync(fileURLToPath(new URL('../../shared-rules.md', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** 通用段里必须写着的几样，缺了哪样就列出哪样。 */
const MID_TURN_RULES: Record<string, RegExp> = {
  引导下一句先回: /我中途的引导下一句先回/,
  引导转给子代理: /涉及子代理就 `SendMessage` 转它并告诉我/,
  引导下一轮补上: /没进到这一轮的，下一轮开头会补上，先答那个/,
  说过的不重说: /说过的不在后面每一步开头重说/,
  没新结果不写话: /两次工具调用之间没有新结果就不写话/,
  子代理后台跑: /子代理一律后台跑/,
  主对话留在这一轮: /主对话留在本轮等它跑完，单次前台等待不超过 60 秒/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

describe('规矩：引导先回、转给子代理、没进来就等下一轮补上；子代理一律后台跑（决定 0026、0078）', () => {
  it('通用段里这几样都在', () => {
    expect(missing(MID_TURN_RULES, RULES)).toEqual([]);
  });

  it('紧跟在「我问了问题，答案放在这一轮的最后一条」那条后面，两条挨着', () => {
    expect(RULES).toMatch(
      /- 我问了问题，答案放在这一轮的最后一条[^\n]*\n- 我中途的引导下一句先回[^\n]*\n- 子代理一律后台跑[^\n]*\n/,
    );
  });

  it('旧说法删干净：没有「引导如果这一轮没进到你这里」那种只管下一轮补的写法；60 秒只写一处', () => {
    expect(RULES).not.toMatch(/我中途的引导如果这一轮没进到你这里/);
    expect(RULES.match(/单次前台等待不超过 60 秒/g) ?? []).toHaveLength(1);
  });

  it('【故意造出的失败】两条整条删掉：每样都查得出缺', () => {
    const cut = RULES.replace(/- 我中途的引导下一句先回[^\n]*\n- 子代理一律后台跑[^\n]*\n/, '');
    expect(cut).not.toBe(RULES);
    expect(missing(MID_TURN_RULES, cut)).toEqual(Object.keys(MID_TURN_RULES));
  });

  it('【故意造出的失败】退回旧写法（只等下一轮补、不先回、不转、不管子代理）：查得出缺', () => {
    const old = RULES.replace(
      /- 我中途的引导下一句先回[^\n]*\n- 子代理一律后台跑[^\n]*\n/,
      '- 我中途的引导如果这一轮没进到你这里，下一轮开头会补上，先答那个；说过的不在后面每一步开头重说，两次工具调用之间没有新结果就不写话。\n',
    );
    expect(missing(MID_TURN_RULES, old)).toEqual([
      '引导下一句先回',
      '引导转给子代理',
      '引导下一轮补上',
      '子代理后台跑',
      '主对话留在这一轮',
    ]);
  });
});
