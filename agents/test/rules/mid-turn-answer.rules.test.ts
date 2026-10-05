// 钉住通用段「这一轮结束不了的时候我说了话」那条（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 2026-10-05 审会话 f9867ba1 量出来的：无人值守、后台活开着时创始人插话问了一句，答案只写在对话中间（他只看得到每轮最后一条），
// 之后每一步开头又把同一个答案重说一遍，两次工具调用之间没新结果也写话。创始人同日约 12:10 选定「全都按照你推荐的改」。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RULES = readFileSync(fileURLToPath(new URL('../../shared-rules.md', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** 通用段里必须写着的几样，缺了哪样就列出哪样。 */
const MID_TURN_RULES: Record<string, RegExp> = {
  只管这一轮结束不了的时候: /这一轮结束不了的时候（无人值守、后台活开着）我说了话/,
  完整答案一次送到手上: /查清就把完整答案一次发到我手上（`deliver_artifact`，没有就推送通知），再接着干/,
  说过的不重说: /说过的不在后面每一步开头重说/,
  没新结果不写话: /两次工具调用之间没有新结果就不写话/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

describe('规矩：这一轮结束不了时我说了话，答案一次送到、不重说（2026-10-05）', () => {
  it('通用段里这几样都在', () => {
    expect(missing(MID_TURN_RULES, RULES)).toEqual([]);
  });

  it('紧跟在「我问了问题，答案放在这一轮的最后一条」那条后面（一个讲收得了尾、一个讲收不了尾）', () => {
    expect(RULES).toMatch(/- 我问了问题，答案放在这一轮的最后一条[^\n]*\n- 这一轮结束不了的时候/);
  });

  it('【故意造出的失败】整条删掉：四样都查得出缺', () => {
    const cut = RULES.replace(/- 这一轮结束不了的时候[^\n]*\n/, '');
    expect(cut).not.toBe(RULES);
    expect(missing(MID_TURN_RULES, cut)).toEqual(Object.keys(MID_TURN_RULES));
  });
});
