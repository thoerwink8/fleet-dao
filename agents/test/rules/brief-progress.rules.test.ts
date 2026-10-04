import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 钉住一条规矩（创始人 2026-10-02 夜：「你为什么没有遵守 fleet-dao 约定的，反馈的时候，要带进度，是哪里有断链？」）：
// 派工的交代里必须写清「按通用段『报进度』那两条汇报、进度随做随更落盘」。工人只读交代、不读通用段，
// 交代漏了这两条，进度就断在工人这一环——云端 agents-sync 分发的通用段管不到派出去的那一段对话。
describe('派工交代必须带上「报进度」和进度落盘', () => {
  const skill = readFileSync(join(import.meta.dirname, '../../skills/commander/SKILL.md'), 'utf8');

  it('派活一节要求交代里写进度格式与落盘', () => {
    const para = skill.split('\n').find((l) => l.includes('写一份交代')) ?? '';
    expect(para, '找不到写交代那一条').toContain('交代');
    expect(para, '交代里必须要求按「报进度」格式汇报').toContain('报进度');
    expect(para, '交代里必须要求进度落盘').toMatch(/specs|落盘/);
  });

  it('【故意造出的失败】旧写法（只说改什么、测什么）必须被判不合格', () => {
    const old =
      '- **本机工人**：写一份交代（单号或要改什么、「怎么算做完」、要跑哪些测试、别碰什么），派给 Claude 子代理。';
    expect(old).not.toContain('报进度');
  });
});
