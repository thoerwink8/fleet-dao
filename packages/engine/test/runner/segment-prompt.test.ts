// 动手会话的提示词（runner/segment-prompt.ts）：交代、一次性会话的规矩、返工意见都在，且规矩和引擎后面做的事对得上。
import { describe, expect, it } from 'vitest';
import { ManualBriefSchema } from '../../src/runner/brief.ts';
import {
  FEEDBACK_ITEM_MAX,
  renderResumePrompt,
  renderSegmentPrompt,
} from '../../src/runner/segment-prompt.ts';

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

describe('续会话的提示词（决定 0088）', () => {
  it('只补被打断的原因和这一轮要改的，不重述整张单：交代、规矩、验收条都不重复出现', () => {
    const text = renderSegmentPrompt({
      brief,
      feedback: ['CI 红了：test (engine)'],
      interrupted: '被人暂停（frank）：发版',
      resumed: true,
    });
    expect(text).toContain('打断了（被人暂停（frank）：发版）');
    expect(text).toContain('## 这一轮要改的');
    expect(text).toContain('CI 红了：test (engine)');
    expect(text).toContain('git commit');
    expect(text).not.toContain('# 任务：给驾驶舱加状态');
    expect(text).not.toContain('页面上能看到「验收中」');
    expect(text).not.toContain('## 怎么干');
    expect(text).not.toContain('需求文档');
  });

  it('没有打断原因、没有返工意见也交得出提示词：说一句接着做，不交空提示词', () => {
    const text = renderResumePrompt({ feedback: [] });
    expect(text).toContain('接着这个会话往下做');
    expect(text).not.toContain('这一轮要改的');
    expect(text.length).toBeGreaterThan(20);
  });
});

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

  it('不指向会话读不到的东西（Refs、GitHub 历史单），并说明 AGENTS.md 里开 PR、进度单、开单的约定这次不适用', () => {
    for (const specDir of ['specs/12-驾驶舱状态', undefined]) {
      const text = render({ specDir });
      expect(text).not.toContain('Refs');
      expect(text).toContain('AGENTS.md 里开 PR、进度单、开单的约定这次不适用，引擎替你做');
    }
  });

  it('老单指着的需求文档在主线上：告诉它别改；需求在单子里的新单没有这一行，也不叫它写需求.md', () => {
    expect(render({ specDir: 'specs/12-驾驶舱状态' })).toContain('已经在主线上，不要改它');
    const fresh = render({ specDir: undefined });
    expect(fresh).not.toContain('已经在主线上，不要改它');
    expect(fresh).not.toContain('需求.md');
    expect(fresh).not.toContain('整理成');
  });

  it('最后一条回复：逐条一行回验收条，再加一行欠什么（不再说「三句话以内」，和「逐条都要回」不冲突）；它是最后一条规矩', () => {
    const text = render();
    expect(text).not.toContain('三句话');
    expect(text).toContain('逐条一行回验收条，再加一行欠什么');
    expect(text).not.toContain('`Explore`');
    expect(text.trimEnd().endsWith('再加一行欠什么。')).toBe(true);
  });

  it('派前探测探通且没换路不进返工意见；换路、探不通的仍按条带上', () => {
    const onlyPass = render({ feedback: ['派前探测：grok-4.7 通'] });
    expect(onlyPass).not.toContain('派前探测');
    expect(onlyPass).not.toContain('返工意见');
    const resumed = renderResumePrompt({ feedback: ['派前探测：grok-4.7 通'] });
    expect(resumed).not.toContain('派前探测');
    expect(resumed).not.toContain('这一轮要改的');
    const mixed = render({
      feedback: ['派前探测：grok-4.7 通', '没提交：M .claude/settings.json'],
    });
    expect(mixed).not.toContain('grok-4.7');
    expect(mixed).toContain('1. 没提交：M .claude/settings.json');
    expect(mixed).not.toContain('2. ');
    const switched = renderResumePrompt({
      feedback: ['派前探测：glm-5.3-flash 不通，换到 grok-4.7', '派前探测：glm 不通（网络不通）'],
    });
    expect(switched).toContain('1. 派前探测：glm-5.3-flash 不通，换到 grok-4.7');
    expect(switched).toContain('2. 派前探测：glm 不通（网络不通）');
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

describe('首轮预载和通用技能（决定 0093）', () => {
  it('新会话：「已给你的文件」紧跟交代、在「怎么干」之前；规矩里写明别去读家目录的通用技能', () => {
    const text = render({ preload: [{ path: 'a.ts', kind: 'text', content: 'export const a = 1;\n' }] });
    expect(text.indexOf('## 已给你的文件（别再读）')).toBeGreaterThan(text.indexOf('# 任务：给驾驶舱加状态'));
    expect(text.indexOf('## 已给你的文件（别再读）')).toBeLessThan(text.indexOf('## 怎么干'));
    expect(text).toContain('export const a = 1;');
    expect(text).toContain('~/.agents/skills、~/.claude/skills 下的 SKILL.md）这次用不上，别去读');
  });

  it('没预载到文件：不出这一节；续会话不出这一节', () => {
    expect(render()).not.toContain('已给你的文件');
    expect(render({ resumed: true, preload: [{ path: 'a.ts', kind: 'text', content: 'x' }] })).not.toContain(
      '已给你的文件',
    );
  });
});
