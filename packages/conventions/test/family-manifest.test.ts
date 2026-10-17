import { describe, expect, it } from 'vitest';
import { reconcileFamily } from '../src/family-manifest.ts';
import type { GitHubFamilyReader, GitHubFamilyWriter, GitHubReader, PlanIssue } from '../src/github-api.ts';
import { readManifest, withManifest } from '../src/mother-manifest.ts';
import { parentField } from '../src/parent-field.ts';
import { fakeReader, issue } from './fake-github.ts';

const child = (n: number, extra: Partial<PlanIssue> = {}) => issue(n, { body: '正文', ...extra });
const mother = (n: number, children?: number[], extra: Partial<PlanIssue> = {}) =>
  child(n, {
    labels: ['需求', '母单'],
    body: children === undefined ? '母单正文' : withManifest('母单正文', children),
    ...extra,
  });
type Options = {
  failAll?: boolean;
  failSub?: boolean;
  failWrite?: boolean;
  failLink?: boolean;
  staleBody?: boolean;
  staleLink?: boolean;
  beforeRead?: (n: number, rows: PlanIssue[], calls: number) => void;
};
function setup(input: PlanIssue[], opts: Options = {}) {
  const rows = structuredClone(input);
  const writes: { type: 'body' | 'link'; n: number; body?: string; mother?: number; replace?: boolean }[] =
    [];
  let reads = 0;
  const view = (r: PlanIssue) => ({
    ...r,
    labels: [...r.labels],
    subIssues: rows.filter((i) => i.parent === r.number).length,
  });
  const base = fakeReader({ issues: rows, milestones: [], subs: {} }).reader;
  const gh: GitHubReader & GitHubFamilyReader = {
    ...base,
    async allIssues() {
      if (opts.failAll) throw new Error('全量读取 502');
      return rows.filter((i) => !i.isPr).map(view);
    },
    async issue(n) {
      opts.beforeRead?.(n, rows, ++reads);
      const found = rows.find((i) => i.number === n);
      return found ? view(found) : undefined;
    },
    async subIssues(n) {
      if (opts.failSub) throw new Error('子单读取 502');
      return rows.filter((i) => i.parent === n).map(view);
    },
  };
  const writer: GitHubFamilyWriter = {
    async updateIssueBody(n, body) {
      writes.push({ type: 'body', n, body });
      if (opts.failWrite) throw new Error('正文 PATCH 403');
      const row = rows.find((i) => i.number === n);
      if (!row) throw new Error('不存在');
      if (!opts.staleBody) row.body = body;
    },
    async addSubIssue(m, n, replace) {
      writes.push({ type: 'link', n, mother: m, ...(replace === undefined ? {} : { replace }) });
      if (opts.failLink) throw new Error('挂接 POST 422');
      const row = rows.find((i) => i.number === n);
      if (!row) throw new Error('不存在');
      if (!opts.staleLink) row.parent = m;
    },
  };
  return { rows, gh, writer, writes, run: () => reconcileFamily(gh, writer) };
}
const keys = (r: { findings: { key: string }[] }) => r.findings.map((f) => f.key);
const manifest = (s: ReturnType<typeof setup>, n: number) =>
  readManifest(s.rows.find((i) => i.number === n)?.body ?? '');

describe('母清单维护：全量集合和幂等修复', () => {
  it('开放母单缺段补完整清单，包含closed、未排期及仅正文关系的子单；第二轮零写无差异', async () => {
    const s = setup([
      mother(10),
      child(11, { parent: 10, body: 'parent: #10' }),
      child(12, { parent: 10, body: 'parent: #10', state: 'closed' }),
      child(13, { body: 'parent: #10' }),
    ]);
    const first = await s.run();
    expect(first.notQueried).toEqual([]);
    expect(keys(first)).toContain('manifest-drift:10:11,12,13');
    expect(manifest(s, 10)).toMatchObject({ kind: 'valid', children: [11, 12, 13] });
    expect(s.rows.find((i) => i.number === 13)?.parent).toBe(10);
    expect(first.findings.every((f) => f.text.includes('已'))).toBe(true);
    s.writes.length = 0;
    expect(await s.run()).toEqual({ findings: [], notQueried: [] });
    expect(s.writes).toEqual([]);
  });

  it('普通目录母单可有空清单，既不报family-empty也不附着子单', async () => {
    const s = setup([mother(10)]);
    const r = await s.run();
    expect(keys(r)).toEqual(['manifest-drift:10:']);
    expect(manifest(s, 10)).toMatchObject({ kind: 'valid', children: [] });
    expect((await s.run()).findings).toEqual([]);
  });

  it('仅清单内的关闭子单也恢复原生关系和正文，代码示例保持原样', async () => {
    const example = '```\nparent: #999\n```\n> parent: #998\n正文';
    const s = setup([mother(10, [11]), child(11, { state: 'closed', body: example })]);
    const r = await s.run();
    expect(r.notQueried).toEqual([]);
    const c = s.rows.find((i) => i.number === 11);
    expect(c?.parent).toBe(10);
    expect(c?.body).toContain(example);
    expect(parentField(c?.body ?? '')).toEqual({ kind: 'parent', number: 10 });
    expect((await s.run()).findings).toEqual([]);
  });

  it('唯一清单A修原生B和错正文；不会把子单误补到B的清单', async () => {
    const s = setup([mother(10, [11]), mother(20, []), child(11, { parent: 20, body: 'parent: #20' })]);
    const r = await s.run();
    expect(r.notQueried).toEqual([]);
    expect(s.writes).toContainEqual({ type: 'link', n: 11, mother: 10, replace: true });
    expect(s.rows.find((i) => i.number === 11)).toMatchObject({
      parent: 10,
      body: expect.stringContaining('parent: #10'),
    });
    expect(manifest(s, 20)).toMatchObject({ children: [] });
    expect((await s.run()).findings).toEqual([]);
  });

  it('无writer只报告计划，不改变数据', async () => {
    const s = setup([mother(10, [11]), child(11)]);
    const r = await reconcileFamily(s.gh);
    expect(keys(r)).toEqual(['family-parent-drift:11:10']);
    expect(s.writes).toEqual([]);
    expect(s.rows[1]?.parent).toBeUndefined();
  });
});

describe('母清单维护：权威冲突不能靠覆盖解决', () => {
  it('两节点唯一manifest成环时在任何写入前停止', async () => {
    const s = setup([mother(10, [20]), mother(20, [10])]);
    expect(keys(await s.run())).toContain('family-cycle:10,20');
    expect(s.writes).toEqual([]);
  });

  it('三节点混合manifest、原生及body fallback的环也在第一笔写入前停止', async () => {
    const s = setup([
      mother(10, [20], { parent: 30, body: withManifest('parent: #30', [20]) }),
      mother(20, []),
      mother(30, [], { body: withManifest('parent: #20', []) }),
    ]);
    expect(keys(await s.run())).toContain('family-cycle:10,20,30');
    expect(s.writes).toEqual([]);
  });

  it('双manifest争抢停止该母单的所有写入', async () => {
    const s = setup([mother(10, [11]), mother(20, [11]), child(11, { parent: 20, body: 'parent: #20' })]);
    const r = await s.run();
    expect(keys(r)).toEqual(['manifest-conflict:11:10,20']);
    expect(s.writes).toEqual([]);
  });

  it('closed母单的manifest保护归属，不把其子单补进开放母单', async () => {
    const s = setup([
      mother(10, [11], { state: 'closed' }),
      mother(20, []),
      child(11, { parent: 20, body: 'parent: #20', state: 'closed' }),
    ]);
    const r = await s.run();
    expect(r.notQueried).toEqual([]);
    expect(s.writes).toEqual([]);
    expect(manifest(s, 20)).toMatchObject({ children: [] });
  });

  it('closed和open清单同时认领同样停止修复', async () => {
    const s = setup([mother(10, [11], { state: 'closed' }), mother(20, [11]), child(11)]);
    expect(keys(await s.run())).toEqual(['manifest-conflict:11:10,20']);
    expect(s.writes).toEqual([]);
  });

  it('无清单裁定且原生与body冲突只报，不制造两份清单认领', async () => {
    const s = setup([mother(10, []), mother(20, []), child(11, { parent: 10, body: 'parent: #20' })]);
    expect(keys(await s.run())).toEqual(['family-unclaimed-conflict:11']);
    expect(s.writes).toEqual([]);
  });

  it('404/PR/自引用不挂接，原清单保留，修不了也不会下一轮假绿', async () => {
    const s = setup([mother(10, [10, 11, 12]), child(12, { isPr: true })]);
    const r = await s.run();
    expect(keys(r)).toEqual([
      'manifest-self:10',
      'manifest-child-invalid:10:11',
      'manifest-child-invalid:10:12',
    ]);
    expect(s.writes).toEqual([]);
    expect(manifest(s, 10)).toMatchObject({ children: [10, 11, 12] });
    expect((await s.run()).findings).toHaveLength(3);
  });
});

describe('母清单维护：读写失败与并发修改', () => {
  it.each([{ failAll: true }, { failSub: true }])('全量或子单读取失败，本轮零写 %j', async (o) => {
    const s = setup([mother(10), child(11)], o);
    expect((await s.run()).notQueried).toContainEqual(expect.stringContaining('本轮不写'));
    expect(s.writes).toEqual([]);
  });

  it('任意closed单缺正文也禁止全局写；缺失不能当空', async () => {
    const missingBody = child(11, { state: 'closed' });
    delete missingBody.body;
    const s = setup([mother(10), missingBody]);
    expect((await s.run()).notQueried).toContainEqual(expect.stringContaining('#11 的正文'));
    expect(s.writes).toEqual([]);
  });

  it('closed母单坏manifest也禁止全局写', async () => {
    const bad = withManifest('', [11]).replace('[11]', '[bad]');
    const s = setup([mother(10), mother(20, [], { state: 'closed', body: bad }), child(11)]);
    expect(keys(await s.run())).toContain('manifest-invalid:20');
    expect(s.writes).toEqual([]);
  });

  it('目标body并发修改不被覆盖，不继续挂接子单', async () => {
    let changed = false;
    const s = setup([mother(10, [11]), child(11)], {
      beforeRead(n, rows) {
        if (n === 10 && !changed) {
          const m = rows.find((i) => i.number === n);
          if (m) m.body += '\n人工编辑';
          changed = true;
        }
      },
    });
    expect((await s.run()).notQueried).toContainEqual(expect.stringContaining('未覆盖并发修改'));
    expect(s.writes).toEqual([]);
    expect(s.rows[0]?.body).toContain('人工编辑');
  });

  it('子单parent并发变化不迁移、不改正文', async () => {
    let changed = false;
    const s = setup([mother(10, [11]), mother(20, []), child(11)], {
      beforeRead(n, rows) {
        if (n === 11 && !changed) {
          const c = rows.find((i) => i.number === n);
          if (c) c.parent = 20;
          changed = true;
        }
      },
    });
    expect((await s.run()).notQueried).toContainEqual(expect.stringContaining('未覆盖并发修改'));
    expect(s.writes).toEqual([]);
  });

  it.each([{ failWrite: true }, { staleBody: true }])(
    '正文写失败或回读未更新，不冒充已修复 %j',
    async (o) => {
      const s = setup([mother(10)], o);
      const r = await s.run();
      expect(r.notQueried).toHaveLength(1);
      expect(r.findings[0]?.text).not.toContain('已自动补齐');
    },
  );

  it.each([{ failLink: true }, { staleLink: true }])(
    '原生挂接失败或回读未确认，不继续改body %j',
    async (o) => {
      const s = setup([mother(10, [11]), child(11)], o);
      const r = await s.run();
      expect(r.notQueried).toHaveLength(1);
      expect(s.writes.map((w) => w.type)).toEqual(['link']);
      expect(r.findings[0]?.text).not.toContain('已按唯一归属自动修复');
    },
  );
});
