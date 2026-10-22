import { describe, expect, it } from 'vitest';
import {
  collectGuardInventory,
  GUARD_REGISTRY_PATH,
  type GuardEntry,
  renderGuardInventory,
} from '../src/guard-inventory.ts';
import { memRepo } from './helpers.ts';

const NOW = new Date('2026-10-23T00:00:00Z');
const ALARM = 'packages/engine/src/jobs/reconcile-checks.ts';
const entry = (overrides: Partial<GuardEntry> = {}): GuardEntry => ({
  id: 'hook:a',
  kind: 'hook',
  path: 'agents/hooks/a.mjs',
  evidence: [],
  proposer: 'unknown',
  expires: '2026-11-22',
  keepIf: '到期前真拦下过才留',
  hitSource: null,
  outFor: null,
  whyNotRemove: null,
  ...overrides,
});
const files = (entries = [entry()]): Record<string, string> => ({
  [GUARD_REGISTRY_PATH]: JSON.stringify({ asOf: '2026-10-23', entries }),
  'agents/hooks/a.mjs': '',
  '.github/workflows/ci.yml': '',
  [ALARM]: 'export const A_ALERT_PREFIX = \'a:\';\nconst B_ALERT_PREFIX = "b:";',
});

describe('只读护栏库存', () => {
  it('新增/删除真实文件改变库存及登记基线差，不数子目录或非目标文件', () => {
    const added = files();
    added['agents/hooks/b.mjs'] = '';
    added['agents/hooks/nested/c.mjs'] = '';
    added['agents/hooks/d.mjs/'] = '';
    added['.github/workflows/notes.md'] = '';
    added['.github/workflows/second.yaml'] = '';
    const report = collectGuardInventory(memRepo(added), NOW);
    expect(report.counts.hook).toEqual({ actual: 2, registered: 1, net: 1 });
    expect(report.counts.workflow.actual).toBe(2);
    expect(report.counts.alarm.actual).toBe(2);
    expect(report.advisories.join('\n')).toContain('未登记');
    const removed = files();
    delete removed['agents/hooks/a.mjs'];
    removed['agents/hooks/'] = '';
    expect(collectGuardInventory(memRepo(removed), NOW).counts.hook).toEqual({
      actual: 0,
      registered: 1,
      net: -1,
    });
  });

  it('缺目录/读取失败是unknown，已知空目录才是0', () => {
    const missing = files();
    delete missing['agents/hooks/a.mjs'];
    const repo = memRepo(missing);
    const report = collectGuardInventory(repo, NOW);
    expect(report.counts.hook.actual).toBeNull();
    expect(report.problems.join('\n')).toContain('agents/hooks');
    const denied = {
      ...memRepo(files()),
      list: () => {
        throw new Error('denied');
      },
    };
    expect(collectGuardInventory(denied, NOW).counts.workflow.actual).toBeNull();
  });

  it.each(['{', '{}', '{"asOf":"2026-10-23","entries":[{}]}'])('坏登记表不假造基线0: %s', (raw) => {
    const report = collectGuardInventory(memRepo({ ...files(), [GUARD_REGISTRY_PATH]: raw }), NOW);
    expect(report.counts.hook).toEqual({ actual: 1, registered: null, net: null });
    expect(report.problems).toHaveLength(1);
  });

  it('到期和未知拦截只告知，不等于未拦过，不自动删除', () => {
    const source = files([entry({ expires: '2026-10-23' })]);
    const report = collectGuardInventory(memRepo(source), NOW);
    expect(report.entries).toHaveLength(1);
    expect(report.problems).toEqual([]);
    expect(report.advisories.join('\n')).toContain('已到期');
    expect(renderGuardInventory(report)).toContain('次数未知，不能当 0');
    expect(renderGuardInventory(report)).toContain('不自动删除或拦 PR');
    expect(source['agents/hooks/a.mjs']).toBe('');
  });

  it.each([{ evidence: [] }, { evidence: ['存量未自证'] }])(
    '缺真实证据/一进一出只告知，超30天也不阻断：$evidence',
    ({ evidence }) => {
      const report = collectGuardInventory(
        memRepo(files([entry({ evidence, proposer: 'known', expires: '2026-11-23' })])),
        NOW,
      );
      expect(report.problems).toEqual([]);
      expect(report.advisories.join('\n')).toContain('evidence 缺真实证据');
      expect(report.advisories.join('\n')).toContain('未记录一进一出');
      expect(report.advisories.join('\n')).toContain('超出登记日起 30 天');
      expect(renderGuardInventory(report)).toContain('不是滚动一周');
    },
  );

  it.each([undefined, 'const A_ALERT_PREFIX = getPrefix();', "const A_ALERT_PREFIX: string = 'a:';"])(
    '读不到或动态报警前缀不记0: %s',
    (source) => {
      const input = files();
      if (source === undefined) delete input[ALARM];
      else input[ALARM] = source;
      const report = collectGuardInventory(memRepo(input), NOW);
      expect(report.counts.alarm.actual).toBeNull();
      expect(report.problems.join('\n')).toContain('报警前缀没查成');
    },
  );

  it('注释/模板里的示例不算报警声明，已知没有声明才记0', () => {
    const source =
      "/*\nconst COMMENT_ALERT_PREFIX = 'fake:';\n*/\nconst example = `\nconst TEMPLATE_ALERT_PREFIX = 'fake:';\n`;";
    const report = collectGuardInventory(memRepo({ ...files(), [ALARM]: source }), NOW);
    expect(report.counts.alarm.actual).toBe(0);
    expect(report.problems).toEqual([]);
  });
});
