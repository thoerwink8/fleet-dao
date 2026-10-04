import { describe, expect, it } from 'vitest';
import { annotation, checkPlanValue } from '../src/pr-fields.ts';

const PLAN = [
  '# 计划',
  '',
  '## 三、分阶段',
  '',
  '### P0 地基（约 6 小时）',
  '',
  '- 仓骨架：pnpm、CI。',
  '',
  '**验收**：装两遍。',
  '',
  '### P1 核心闭环（约 12 小时）',
  '',
  '- 工作流：需求、子任务。',
  '- 错误按「下一步动作」分流、路由熔断。',
  '',
].join('\n');

describe('只核「对应计划」一栏的值（引擎收需求文档时用）', () => {
  it('对得上 plan.md 的条目就没问题；带不带 plan.md 前缀、跨两条都认', () => {
    expect(checkPlanValue('plan.md P1「工作流」', PLAN)).toEqual([]);
    expect(checkPlanValue('P0「仓骨架」、P1「错误按」', PLAN)).toEqual([]);
  });

  it('认不出、没写哪一条、引号空着、条目不在、阶段不在：各报一句', () => {
    expect(checkPlanValue('plan.md P0 的验收', PLAN)).toEqual([expect.stringContaining('P0 没写是哪一条')]);
    expect(checkPlanValue('P1「」', PLAN)).toEqual([expect.stringContaining('引号里是空的')]);
    expect(checkPlanValue('P1「没有这一条」', PLAN)).toEqual([expect.stringContaining('找不到')]);
    expect(checkPlanValue('P9「工作流」', PLAN)).toEqual([expect.stringContaining('没有 P9 这个阶段')]);
    expect(checkPlanValue('无', PLAN)).toEqual([expect.stringContaining('认不出：写版本全名')]);
  });

  it('版本全名、#<单号>、未排期：不用 plan.md 核，直接过', () => {
    expect(checkPlanValue('v1 Fusion 接活', PLAN)).toEqual([]);
    expect(checkPlanValue('#189', PLAN)).toEqual([]);
    expect(checkPlanValue('未排期', PLAN)).toEqual([]);
  });

  it('plan.md 里一个阶段都认不出：算一条问题，不当成过了', () => {
    expect(checkPlanValue('P1「工作流」', '# 计划\n\n没有阶段标题')).toEqual([
      expect.stringContaining('一个阶段'),
    ]);
  });

  it('【故意造出的失败】值是空的：报一句，不当成填了', () => {
    expect(checkPlanValue('', PLAN)).toEqual([expect.stringContaining('一栏是空的')]);
  });
});

describe('Actions 注解', () => {
  it('报错是 error、提醒是 warning；% 和换行转义掉', () => {
    expect(annotation('缺了 100%\n第二行')).toBe('::error::缺了 100%25%0A第二行');
    expect(annotation('提醒：没贴类别标签', 'warning')).toBe('::warning::提醒：没贴类别标签');
  });
});
