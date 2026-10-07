// 三段和路由页用途的对照只有这一份（#1224）。引擎验收选路用的用途必须是页面上叫「验收」的那一格：
// 对不上就红——改了一边没改另一边，验收会按页面上调不到的顺序走。
import { describe, expect, it } from 'vitest';
import { acceptancePurpose, ROUTING_PURPOSES, SCOPE_NO_ROUTE, SEGMENT_STAGE } from '../src/flow-purposes.ts';

describe('三段 → 用途', () => {
  it('对题不选路，页面上只写这一句', () => {
    expect(SCOPE_NO_ROUTE).toBe('在对话里做，不选路');
  });

  it('页面只列动手、动手 · 界面、验收、Jev 判断；判断单列，不是流程里的一段', () => {
    expect(ROUTING_PURPOSES.map((p) => [p.purpose, p.label, p.aside])).toEqual([
      ['execute', '动手', false],
      ['ui', '动手 · 界面', false],
      ['verify', '验收', false],
      ['judge', 'Jev 判断', true],
    ]);
  });

  it('triage、spec、plan、research、review 不在用途列表里（库里的枚举留着，这里不列）', () => {
    const ids = ROUTING_PURPOSES.map((p) => p.purpose);
    for (const gone of ['triage', 'spec', 'plan', 'research', 'review'] as const) {
      expect(ids).not.toContain(gone);
    }
  });

  it('【故意造出的失败】验收选路的用途不是页面上叫「验收」的那一格就红', () => {
    expect(acceptancePurpose()).toBe('verify');
    expect(SEGMENT_STAGE.verify).toBe(acceptancePurpose());
    expect(SEGMENT_STAGE.manual).toBe('execute');
    expect(ROUTING_PURPOSES.find((p) => p.purpose === 'ui')?.label).toBe('动手 · 界面');
  });
});
