// 「怎么算做完」里要 diff 外证据的判据（决定 0093）：冷验收只看 diff、测试输出和单子，拒单抽样 15 条里 5 条是验收条看不见。
// 用例里的写法取自本仓真单子（拿近 300 张单校过）：该拦的拦、描述代码和界面的别拦。
import { describe, expect, it } from 'vitest';
import {
  describeOffDiff,
  offDiffAcceptanceItems,
  offDiffWords,
  splitAcceptanceItems,
} from '../src/off-diff-acceptance.ts';

// 真单 #2032 / #2082 的「怎么算做完」原文：这些是现场、线上和 SSH 的
// 运行态证据，不能只靠 PR 的 diff 和测试输出验收。
const ISSUE_2032_DONE = [
  '1. 确认落后的是哪些「相关提交」（人工档路径），是否确需整套 `bash /srv/fleet-dao/deploy/france.sh`（或以 root 等价应用）。',
  '2. 重跑/应用后 healthz `deploy_lag` 回到 `ok:true`（整体是否仍因 #2023 的 github_app 503 另论）。',
  '3. 若属可接受的短暂窗口或已有意暂缓：在本单注明原因与可接受状态后关单，避免监督反复当新断链开单。',
  '4. 顺带：恢复指挥官到法国机的 SSH（见 #1775），以便断链时能做最小恢复。',
].join('\n');

const ISSUE_2082_DONE = [
  '1. 查清 10-14 08:40 那轮 canary 在「记账」失败的具体原因（日志、失败单号、台账写入结果）。',
  '2. 修好后让 canary 再跑通一轮（或明确「无待验」且 healthz canary 不再因本断点报红）。',
  '3. healthz 至少不再因 canary_broken「记账」报红（整体是否仍因 #2023/#2032 503 另论）。',
  '4. 顺带：恢复指挥官到法国机的 SSH（见 #1775），以便断链时能做最小恢复。',
].join('\n');

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
    ['读库', '- 在法国库上读一遍实际的用途→模型→档位。', '在法国库上读'],
    ['读回', '- 读回接口响应里的状态和结论。', '读回接口响应里的状态和结论'],
    ['贴评论', '- 把核对结果贴进本单评论。', '贴进本单评论'],
    ['恢复连接', '- 恢复指挥官到法国机的 SSH。', '恢复指挥官到法国机的 SSH'],
    ['健康检查读回', '- healthz deploy_lag 回到 ok:true。', 'healthz deploy_lag 回到'],
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
    ['保留现场（代码行为）', '- 读取失败保留现场，不清理工作树。'],
    ['现场交还（代码行为）', '- 现场交还后任务行状态不变。'],
    ['现场凭据（代码行为）', '- 输出里不出现别人家的现场凭据。'],
    ['审计代码（改动本身，不是审计结果）', '- 审计 intake 里每条准入关卡，原因都有对应的跳过记录。'],
    ['普通测试条', '- `packages/x/test/a.test.ts` 新增用例：过期的验证码被拒。'],
  ])('%s', (_name, item) => {
    expect(offDiffWords(item)).toEqual([]);
  });
});

describe('offDiffAcceptanceItems / describeOffDiff', () => {
  it('#2032 和 #2082 的原文逐条命中，并保留哪一条、为什么', () => {
    const two = offDiffAcceptanceItems(ISSUE_2032_DONE);
    expect(two).toHaveLength(3);
    expect(two[0]?.words).toContain('healthz `deploy_lag` 回到');
    expect(two[1]?.words).toContain('在本单注明');
    expect(two[2]?.words).toContain('恢复指挥官到法国机的 SSH');

    const eight = offDiffAcceptanceItems(ISSUE_2082_DONE);
    expect(eight).toHaveLength(4);
    expect(eight[0]?.words).toContain('（日志、');
    expect(eight[1]?.words).toContain('healthz canary 不再');
    expect(eight[2]?.words).toContain('healthz 至少不再');
    expect(eight[3]?.words).toContain('恢复指挥官到法国机的 SSH');
    expect(describeOffDiff(eight)).toContain('healthz 至少不再因 canary_broken');
  });

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
