// 「怎么算做完」里要 diff 外证据的判据（决定 0093）：冷验收只看 diff、测试输出和单子，拒单抽样 15 条里 5 条是验收条看不见。
// 用例里的写法取自本仓真单子（拿近 300 张单校过）：该拦的拦、描述代码和界面的别拦。
import { describe, expect, it } from 'vitest';
import {
  describeOffDiff,
  isDiagnosticTitle,
  offDiffAcceptanceItems,
  offDiffHoldOf,
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

// 诊断型（#3591）：真单 #3414 / #3450 / #3413 的「怎么算做完」原文（2026-10-22 从 GitHub 读的）。
// 要的是原场景那一次 CI 里卡在哪一步，冷验收在 diff 和这一次的测试输出里核实不了，反复被拒。
const ISSUE_3414_DONE = [
  '- diff与测试输出能核实原场景卡在哪个COMMIT/等待/收尾边界；新增失败诊断只记录合成数据、阶段与必要资源读数，成功静默，缺采样明确unknown。不能把teardown错误直接当根因。',
  '- 原完整256条样本、固定字节峰值、真实事务/崩溃边界和15000ms限制保持，不能加重试、跳过或rerun碰绿；定位到原因时增加能击中原因的回归并修对应实现。',
  '- 若本PR只交付诊断，需求使用Refs关联并明确分片、关不了它与剩余根因欠项，不能Closes或写欠无。',
  '- 相关测试、类型格式卫生及完整CI/check/独立合并闸通过，不改3249的预算和其它执行护栏，不误关3249或把一次绿称作旧故障已修。',
].join('\n');

const ISSUE_3450_DONE = [
  '1. 在既有失败用例和帮手调用链取得可核的等待阶段证据，区分启动、协议读取、退出和异步收尾；沿用现有测试/错误证据口，不另起巡检器、告警或表。证据不打印环境、凭据、完整命令行或不受限进程原文。原首红5000ms和精确head/run/attempt保持可查；仅有再次通过时明确首次失败的具体等待原因仍未知。',
  '2. 以可控依赖/假帮手或已有精确失败条件验证真实原因并修在必经点；故意延迟、拒绝/异常、缺失输出或不完整回执不得静默变成空/ok。若采用廉价协议单测加最小真实帮手对照，必须仍覆盖实际调用/退出/错误路径，不拿全mock替代协议接线。未取得足够证据时保留明确未知，不编造根因或提前说修复完成。',
].join('\n');

const ISSUE_3413_DONE = [
  '- 用diff可核的回归或失败取证明确原用例实际等待的是哪一步，绑定其真实workflow/run；仅针对合成假端口，失败或既有watchdog时保全完整protobuf/describe与阶段，hash/分帧/缺失明确可核，成功保持静默，不输出凭据或业务正文。',
  '- 保留原60秒、业务断言、worker替换与缓存设置；不加重试、sleep、预算或rerun碰绿，不拿新history替换旧失败历史。已有原证据无论是否重现都保留。',
  '- 定位到可修原因时在对应必经点修并增加真实回归；如只完成诊断，PR需求使用 Refs #本单（分片、关不了它），写明剩余根因欠项，不能写 Closes 或欠无。',
  '- 相关测试、类型格式卫生和完整CI/check/独立闸通过；不能从单次绿推定旧失败已修，也不能把另一台park-kind错误当本用例原因。',
].join('\n');

describe('诊断型验收条（#3591）：要原场景卡在哪的，判成 diff 外', () => {
  it('#3414：「核实原场景卡在哪个…边界」写了 diff 与测试输出也拦，别的条不误拦', () => {
    const hits = offDiffAcceptanceItems(ISSUE_3414_DONE);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.item).toContain('核实原场景卡在哪个COMMIT');
    expect(hits[0]?.words).toContain('核实原场景卡在');
  });

  it('#3450：「明确首次失败的具体等待原因」拦，修在必经点那条不拦', () => {
    const hits = offDiffAcceptanceItems(ISSUE_3450_DONE);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.item).toContain('取得可核的等待阶段证据');
    expect(hits[0]?.words).toContain('明确首次失败的具体等待');
  });

  it('#3413：「明确原用例实际等待的是哪一步」拦，保留原设置、Refs 分片那几条不拦', () => {
    const hits = offDiffAcceptanceItems(ISSUE_3413_DONE);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.item).toContain('明确原用例实际等待的是哪一步');
    expect(hits[0]?.words).toContain('明确原用例实际等待');
  });

  it.each([
    [
      '定位…的真实阶段',
      '- 定位 admission-alert-crash 那条用例超时的真实阶段（只要求定位不要求修）。',
      '定位 admission-alert-crash 那条用例超时的真实阶段',
    ],
    ['完整 CI 的 N 秒超时', '- 查清它在完整 CI 的 15 秒超时。', '完整 CI 的 15 秒超时'],
  ])('%s', (_name, item, word) => {
    expect(offDiffWords(item)).toContain(word);
  });

  it.each([
    [
      '界面显示卡在哪一步（diff 里看得见）',
      '- 驾驶舱任务页显示卡在哪一步（`packages/web/test/task-page.test.ts` 断言）。',
    ],
    [
      '保留原失败原因（代码行为）',
      '- 合并失败时保留原失败原因，`packages/engine/test/merge.test.ts` 断言 notes 里有原文。',
    ],
    [
      '定位到冲突文件（代码行为）',
      '- 冲突提示定位到冲突文件和行号（`packages/engine/test/conflict.test.ts` 断言）。',
    ],
  ])('反例不拦：%s', (_name, item) => {
    expect(offDiffWords(item)).toEqual([]);
  });
});

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
    ['现场状态（代码行为）', '- 现场状态写进任务行，下一轮能接着用。'],
    ['现场快照（代码行为）', '- 失败时保存现场快照到 `result.json`。'],
    ['现场工作树（代码行为）', '- 现场工作树原样留给本机，不重置。'],
    ['破坏现场（代码行为）', '- 清理步骤不破坏现场。'],
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

  it('offDiffHoldOf（#3602）：#3414 的验收条原文命中三个入口，普通单和没有验收条的不命中；同样的条目同一个键', () => {
    for (const action of ['continue', 'task.redo', 'commander.redo'] as const) {
      const hold = offDiffHoldOf(splitAcceptanceItems(ISSUE_3414_DONE), action);
      expect(hold?.hits).toHaveLength(1);
      expect(hold?.why).toContain('已交回本机做');
      expect(hold?.comment).toContain('本机做');
      expect(hold?.key).toMatch(new RegExp(`^off-diff-hold:${action.replace('.', '\\.')}:[0-9a-f]{12}$`));
    }
    const a = offDiffHoldOf(splitAcceptanceItems(ISSUE_3414_DONE), 'continue');
    const b = offDiffHoldOf(splitAcceptanceItems(ISSUE_3414_DONE), 'continue');
    expect(a?.key).toBe(b?.key);
    expect(
      offDiffHoldOf(['- 新增 foo.test.ts，断言 bar 返回 3。', '- pnpm check 通过。'], 'continue'),
    ).toBeNull();
    expect(offDiffHoldOf([], 'task.redo')).toBeNull();
  });

  it('splitAcceptanceItems：列表项各一条，非列表的连续行合成一段', () => {
    expect(splitAcceptanceItems('1. a\n2) b\n续行\n\nc\nd')).toEqual(['1. a', '2) b\n续行', 'c\nd']);
  });
});

describe('诊断型单的标题（#3597）：「定位……原 N 秒超时」判成本机做', () => {
  it.each([
    // 真单标题（2026-10-22 从 GitHub 读的）
    '定位权限交还测试在worker替换后原六十秒超时，保留自身历史',
    '定位SQLite COMMIT峰值测试在完整CI的原十五秒超时',
    '定位cleanup-status命名空间测试在完整CI的原五秒超时，保留帮手等待阶段',
    // 写法变体
    '定位 task-budget 用例在完整 CI 的 180 秒超时',
    '查明 push-handback 契约测试在完整 CI 的原 60s 超时',
  ])('诊断型：%s', (title) => {
    expect(isDiagnosticTitle(title)).toBe(true);
  });

  it.each([
    // 改代码的单、不是定位某次运行的单：照常派
    '『第257条明确capacity』用例改成在限定时间内跑完并留下实测分段耗时',
    'CI test (3/8) 台上 admission-alert-crash 32 进程重负载用例让同台 5 秒用例偶发超时：先对照实验，再给重负载文件单独排台',
    '修复登录接口在完整 CI 的 30 秒超时',
    '定位按钮在窄屏下错位',
    '定位并修复请求超时（没有写是哪一秒）',
    '重型和不确定测试移出必过 CI，进每个 PR 都跑的独立 job、发版前必须绿；诊断型单不派引擎',
    '',
  ])('不是诊断型：%s', (title) => {
    expect(isDiagnosticTitle(title)).toBe(false);
  });
});
