// 「怎么算做完」里要 diff 外证据的判据（决定 0093）：冷验收只看 diff、测试输出和单子，拒单抽样 15 条里 5 条是验收条看不见。
// 用例里的写法取自本仓真单子（拿近 300 张单校过）：该拦的拦、描述代码和界面的别拦。
import { describe, expect, it } from 'vitest';
import {
  describeOffDiff,
  offDiffAcceptanceItems,
  offDiffWords,
  splitAcceptanceItems,
} from '../src/off-diff-acceptance.ts';

describe('offDiffWords：该拦的', () => {
  it.each([
    ['截图', '- 手机宽度（390）下按钮点击区不小于 44px，截图贴在 PR 里。', '截图'],
    ['线上点验', '- 发版后线上点验 12 页。', '线上'],
    ['现场', '- 现场证据贴回本单。', '现场'],
    ['审计结果', '- 审计结果写进评论。', '审计结果'],
    ['看日志', '1. 查清那轮失败的原因，翻一下日志。', '翻一下日志'],
    ['证据是日志', '1. 单上留言写明是谁发起的，证据是日志行。', '证据是日志'],
    ['飞书收到', '- 5 分钟内飞书收到报警。', '飞书收到'],
    ['收到飞书消息', '- 指挥官收到飞书消息。', '收到飞书消息'],
    ['发版后', '1. 确认发版后总开关恢复了。', '发版后'],
    ['法国上', '- 法国上的驾驶舱三个宽度都能打开。', '法国上'],
    ['真机', '- 真机上点发布能看到结论。', '真机'],
    ['人工确认', '- 人工确认页面不乱。', '人工确认'],
    ['创始人确认', '- 创始人看过后确认可以。', '创始人看过后确认'],
  ])('%s', (_name, item, word) => {
    expect(offDiffWords(item)).toContain(word);
  });

  it('硬词有测试锚点也拦：截图不在测试输出里', () => {
    expect(offDiffWords('- playwright 测试跑完带截图')).toEqual(['截图']);
  });
});

describe('offDiffWords：不该拦的', () => {
  it.each([
    ['只记日志（代码行为）', '4. 写不进库只记日志，不挡工作流。'],
    ['更新日志（界面名）', '- 更新日志提交行标题带 `min-w-0`。'],
    ['手机上（界面描述）', '- 手机上选项按钮整宽。'],
    ['看板上（界面描述）', '1. 看板上有独立一块「本机会话」。'],
    ['飞书网关收到消息后（描述代码）', '- 飞书网关收到群聊消息后不再写意图库。'],
    ['等创始人同意（流程，不是证据）', '- 列到了就按改标准办（等创始人同意再合）。'],
    ['软词带测试锚点', '- 单测断言部署后第一轮对账把孤儿行补记。'],
    ['软词带 diff', '- diff 里 release 脚本法国上用 systemd-run 起发布。'],
    ['普通测试条', '- `packages/x/test/a.test.ts` 新增用例：过期的验证码被拒。'],
  ])('%s', (_name, item) => {
    expect(offDiffWords(item)).toEqual([]);
  });
});

describe('offDiffAcceptanceItems / describeOffDiff', () => {
  it('按条切开，只回命中的那几条，原文带列表符号', () => {
    const hits = offDiffAcceptanceItems('- 测试 a 过。\n- 带两张截图。\n\n上线后看一眼\n监控面板。');
    expect(hits).toEqual([
      { item: '- 带两张截图。', words: ['截图'] },
      { item: '上线后看一眼\n监控面板。', words: ['上线后', '监控面板'] },
    ]);
    expect(describeOffDiff(hits)).toBe(
      '- 带两张截图。（认出：截图）\n- 上线后看一眼\n监控面板。（认出：上线后、监控面板）',
    );
  });

  it('splitAcceptanceItems：列表项各一条，非列表的连续行合成一段', () => {
    expect(splitAcceptanceItems('1. a\n2) b\n续行\n\nc\nd')).toEqual(['1. a', '2) b\n续行', 'c\nd']);
  });
});
