import { describe, expect, it } from 'vitest';
import { projectAgentDrift } from '../src/project-agents.ts';

describe('项目级子代理由 agents/subagents 原样生成', () => {
  it('【故意造出的失败】缺一份、多一个字：都报不一致', () => {
    expect(projectAgentDrift([{ file: 'fleet-builder.md', source: '一样\n', committed: undefined }])).toEqual(
      ['fleet-builder.md：.claude/agents/ 里没有，该由 agents/subagents/ 原样生成'],
    );
    expect(
      projectAgentDrift([{ file: 'fleet-builder.md', source: '一样\n', committed: '一样\n多\n' }]),
    ).toEqual(['fleet-builder.md：.claude/agents/ 和 agents/subagents/ 不一致']);
  });

  it('haiku55 不拿来比；逐字一样是空的', () => {
    expect(projectAgentDrift([{ file: 'haiku55.md', source: 'a', committed: 'b' }])).toEqual([]);
    expect(projectAgentDrift([{ file: 'fleet-builder.md', source: '一样\n', committed: '一样\n' }])).toEqual(
      [],
    );
  });
});
