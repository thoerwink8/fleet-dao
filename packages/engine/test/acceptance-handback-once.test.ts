// 一次性把还开着的旧验收责任交回原单（#3630，jobs/acceptance-handback-once.ts）：默认只读；--apply 才留言、贴「本机做」、
// 标成已交回；三步按序，前一步没成后一步不做；重跑时已交回的不再列出，所以不重复留言；留言按 key 幂等。
import { describe, expect, it } from 'vitest';
import {
  type AcceptanceHandbackDeps,
  HANDBACK_BY,
  type HandbackDuty,
  handbackBody,
  runAcceptanceHandbackOnce,
} from '../src/jobs/acceptance-handback-once.ts';

const NOW = new Date('2026-10-23T02:00:00Z');
const duty = (over: Partial<HandbackDuty> = {}): HandbackDuty => ({
  id: 11,
  generation: 2,
  repo: 'acme/shop',
  issueNumber: 3483,
  prNumber: 3500,
  head: 'a'.repeat(40),
  items: ['线上审计记录', '现场截图'],
  ...over,
});

/** 假世界：一张「库」（还开着的行）+ 单上的留言（按 key 去重）和标签。 */
function world(rows: HandbackDuty[]) {
  const open = new Map(rows.map((r) => [r.id, r]));
  const comments = new Map<string, { issue: string; body: string }>();
  const labels: string[] = [];
  const marked: { id: number; by: string; evidence: string }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const steps: string[] = [];
  const deps: AcceptanceHandbackDeps = {
    openDuties: async () => [...open.values()],
    comment: async ({ repo, issueNumber, key, body }) => {
      steps.push(`comment ${key}`);
      if (!comments.has(key)) comments.set(key, { issue: `${repo}#${issueNumber}`, body });
      return { url: `https://github.com/${repo}/issues/${issueNumber}#${key}` };
    },
    label: async ({ repo, issueNumber }) => {
      steps.push(`label ${repo}#${issueNumber}`);
      labels.push(`${repo}#${issueNumber}`);
    },
    markHandedBack: async (input, at) => {
      steps.push(`mark ${input.id}`);
      expect(at).toBe(NOW);
      const row = open.get(input.id);
      if (!row) return 'already';
      if (row.generation !== input.generation) throw new Error('代次已变');
      open.delete(input.id);
      marked.push({ id: input.id, by: input.by, evidence: input.evidence });
      return 'handed_back';
    },
    now: () => NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, open, comments, labels, marked, out, err, steps };
}

describe('旧验收责任一次性交回原单（#3630）', () => {
  it('默认只读：列出会交回哪些，不留言、不贴标签、不改行', async () => {
    const w = world([duty(), duty({ id: 12, prNumber: 0, head: '', items: ['协调'] })]);
    expect(await runAcceptanceHandbackOnce([], w.deps)).toBe(0);
    expect(w.steps).toEqual([]);
    expect(w.out.join('\n')).toContain('会交回：acme/shop#3483 责任 11（PR #3500');
    expect(w.out.join('\n')).toContain('协调验收责任（没有 PR）');
    expect(w.out.at(-1)).toContain('共 2 条；只读');
  });

  it('--apply：每条按序留言（写明 PR、头、原验收项）→ 贴「本机做」→ 标成已交回（不删行）', async () => {
    const w = world([duty(), duty({ id: 12, issueNumber: 3579, prNumber: 0, head: '', items: ['协调'] })]);
    expect(await runAcceptanceHandbackOnce(['--apply'], w.deps)).toBe(0);
    expect(w.steps).toEqual([
      'comment acceptance-handback:3630:11',
      'label acme/shop#3483',
      'mark 11',
      'comment acceptance-handback:3630:12',
      'label acme/shop#3579',
      'mark 12',
    ]);
    const body = w.comments.get('acceptance-handback:3630:11')?.body ?? '';
    expect(body).toBe(handbackBody(duty()));
    expect(body).toContain(`PR #3500（头 ${'a'.repeat(40)}）`);
    expect(body).toContain('- 线上审计记录');
    expect(body).toContain('- 现场截图');
    expect(body).toContain('本机做');
    expect(w.marked).toEqual([
      expect.objectContaining({
        id: 11,
        by: HANDBACK_BY,
        evidence: expect.stringContaining('acme/shop#3483'),
      }),
      expect.objectContaining({ id: 12, by: HANDBACK_BY }),
    ]);
    expect(w.marked[0]?.evidence).toContain('https://github.com/acme/shop/issues/3483');
    expect(w.err).toEqual([]);
  });

  it('幂等：跑第二次，已经交回的不再列出、不重复留言', async () => {
    const w = world([duty()]);
    expect(await runAcceptanceHandbackOnce(['--apply'], w.deps)).toBe(0);
    const before = w.steps.length;
    expect(await runAcceptanceHandbackOnce(['--apply'], w.deps)).toBe(0);
    expect(w.steps.slice(before)).toEqual([]);
    expect(w.comments.size).toBe(1);
    expect(w.out.at(-1)).toContain('没有还开着的验收责任');
  });

  it('【故意造出的失败】贴标签没成：行不改，返回 1；重跑接着做，同一条留言按 key 不重复', async () => {
    const w = world([duty()]);
    let fail = true;
    const label = w.deps.label;
    w.deps.label = async (input) => {
      if (fail) throw new Error('GitHub 502');
      return label(input);
    };
    expect(await runAcceptanceHandbackOnce(['--apply'], w.deps)).toBe(1);
    expect(w.marked).toEqual([]);
    expect(w.open.size).toBe(1);
    expect(w.err.join('\n')).toContain('「本机做」没贴成，行没改：GitHub 502');
    fail = false;
    expect(await runAcceptanceHandbackOnce(['--apply'], w.deps)).toBe(0);
    expect(w.marked).toHaveLength(1);
    expect(w.comments.size).toBe(1);
  });

  it('【故意造出的失败】留言没成：不贴标签、不改行；一条失败不挡别的条', async () => {
    const w = world([duty(), duty({ id: 12, issueNumber: 3579 })]);
    const comment = w.deps.comment;
    w.deps.comment = async (input) => {
      if (input.issueNumber === 3483) throw new Error('没权限');
      return comment(input);
    };
    expect(await runAcceptanceHandbackOnce(['--apply'], w.deps)).toBe(1);
    expect(w.labels).toEqual(['acme/shop#3579']);
    expect(w.marked.map((m) => m.id)).toEqual([12]);
    expect(w.err.join('\n')).toContain('责任 11：留言没留成');
  });

  it('【故意造出的失败】库读不成：一行都不动，返回 1，不当成没有要交回的', async () => {
    const w = world([duty()]);
    w.deps.openDuties = async () => {
      throw new Error('连接断了');
    };
    expect(await runAcceptanceHandbackOnce(['--apply'], w.deps)).toBe(1);
    expect(w.steps).toEqual([]);
    expect(w.err[0]).toContain('没读成，一行都没动：连接断了');
  });

  it('参数不对返回 2、不连库；--help 只打用法', async () => {
    const w = world([duty()]);
    let read = false;
    w.deps.openDuties = async () => {
      read = true;
      return [];
    };
    expect(await runAcceptanceHandbackOnce(['--force'], w.deps)).toBe(2);
    expect(await runAcceptanceHandbackOnce(['--help'], w.deps)).toBe(0);
    expect(read).toBe(false);
  });
});
