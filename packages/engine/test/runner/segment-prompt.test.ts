// 动手会话的提示词（runner/segment-prompt.ts）：交代、一次性会话的规矩、返工意见都在，且规矩和引擎后面做的事对得上。
import { describe, expect, it } from 'vitest';
import { ManualBriefSchema } from '../../src/runner/brief.ts';
import { FEEDBACK_ITEM_MAX, renderSegmentPrompt } from '../../src/runner/segment-prompt.ts';

const brief = ManualBriefSchema.parse({
  kind: 'manual',
  title: '给驾驶舱加状态',
  request: '## 场景\n\n要看到每张单走到哪一步。',
  acceptance: ['页面上能看到「验收中」'],
  touches: ['`packages/web/src/pages/`：驾驶舱页面'],
  branch: 'fleet/12-t1a2b3c4d',
  baseSha: 'a'.repeat(40),
});

const render = (over: Partial<Parameters<typeof renderSegmentPrompt>[0]> = {}) =>
  renderSegmentPrompt({ brief, specDir: 'specs/12-驾驶舱状态', feedback: [], ...over });

describe('动手会话的提示词', () => {
  it('交代在最前面，一次性会话的规矩在后面：分支、提交、不推不开 PR、不用 fleet 命令；不要求写需求文档、结果文档（#654）', () => {
    const text = render();
    expect(text.indexOf('# 任务：给驾驶舱加状态')).toBe(0);
    expect(text).toContain('页面上能看到「验收中」');
    expect(text).toContain('分支 `fleet/12-t1a2b3c4d` 已经切好');
    expect(text).toContain('git commit');
    expect(text).toContain('不要推送、不要开 PR');
    expect(text).toContain('不要用 `fleet` 命令');
    expect(text).toContain('不要新建需求文档、结果文档');
    expect(text).not.toContain('结果.md');
  });

  it('老单指着的需求文档在主线上：告诉它别改；需求在单子里的新单没有这一行，也不叫它写需求.md', () => {
    expect(render({ specDir: 'specs/12-驾驶舱状态' })).toContain('已经在主线上，不要改它');
    const fresh = render({ specDir: undefined });
    expect(fresh).not.toContain('已经在主线上，不要改它');
    expect(fresh).not.toContain('需求.md');
    expect(fresh).not.toContain('整理成');
  });

  it('返工意见按条编号带进来；一条没有就不出这一节（不留空标题）', () => {
    const none = render({ feedback: [] });
    expect(none).not.toContain('返工意见');
    expect(render({ feedback: ['  ', ''] })).not.toContain('返工意见');
    const some = render({
      feedback: ['CI 红了：test (engine)\nFAIL task.test.ts', '没做到验收条：看不到「验收中」'],
    });
    expect(some).toContain('## 上几轮留下的返工意见');
    expect(some).toContain('1. CI 红了：test (engine)');
    expect(some).toContain('2. 没做到验收条');
  });

  it('【故意造出的失败】一条意见长得离谱（几万字的日志）：截断并写明后面还有多少，不把整份日志塞进提示词', () => {
    const huge = `ERR ${'x'.repeat(FEEDBACK_ITEM_MAX * 3)}`;
    const text = render({ feedback: [huge] });
    expect(text.length).toBeLessThan(FEEDBACK_ITEM_MAX + 3000);
    expect(text).toMatch(/后面还有 \d+ 个字，已截断/);
    // 保留的是开头（先红的那条是根因）
    expect(text).toContain('ERR xxxx');
  });
});
