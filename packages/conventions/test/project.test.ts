// pnpm project add|check（#2749）：七步各自先查、再补、再核，可重复跑；owner 下没装过 App 时提示先在网页装；
// check 有一项不过就不打开接活；冒烟单四节齐。GitHub、法国都换成内存里的假世界，不打真接口。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REPO_PROFILE_KEYS } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { Gh } from '../src/issue-new.ts';
import { checkIssueBody } from '../src/issue-new.ts';
import {
  type AppInstallConfig,
  closeOnMergeCaller,
  detectProfile,
  FILL_BRANCH,
  type FleetApiResult,
  ISSUE_SECTIONS,
  issueTemplate,
  mergeGateCaller,
  type ProjectContext,
  type ProjectWorld,
  parseProjectArgv,
  projectAdd,
  projectCheck,
  REQUIRED_FILES,
  type RepoLabel,
  SMOKE_TITLE,
  smokeIssueBody,
} from '../src/project.ts';
import { ghProjectWorld } from '../src/project-world.ts';

const STD = 'acme/fleet';
const SLUG = 'acme/flux';
const REPO_ID = 1418484822;
const LABELS: RepoLabel[] = [
  { name: '需求', color: 'a2eeef', description: '要新东西' },
  { name: '本机做', color: '1D76DB', description: '留给本机' },
];
const APPS: AppInstallConfig = {
  apps: {
    agent: { slug: 'fleet-dao-agent', installations: { acme: 11 } },
    engine: { slug: 'fleet-dao-engine', installations: { acme: 22 } },
  },
};

/** 内存里的 GitHub + 法国。writes 记下每一次写（步名 → 次数），测「重跑不写」。 */
class FakeWorld implements ProjectWorld {
  writes: string[] = [];
  installs = new Map<number, Set<number>>([
    [11, new Set()],
    [22, new Set([REPO_ID])],
  ]);
  labelsBy = new Map<string, RepoLabel[]>([
    [STD, LABELS.map((l) => ({ ...l }))],
    [SLUG, [{ name: '需求', color: 'ffffff', description: '旧的' }]],
  ]);
  files = new Map<string, string>([
    ['go.mod', 'module flux'],
    ['cmd/flux/main.go', 'package main'],
    ['internal/x/x.go', 'package x'],
  ]);
  branchFiles = new Map<string, string>();
  openPr: { number: number; url: string } | null = null;
  issues: { number: number; title: string; body: string; labels: string[] }[] = [];
  /** 法国库里的这一行；null＝没登记。 */
  row: {
    githubId: number | null;
    profile: Record<string, unknown>;
    autoDispatchSince: string | null;
  } | null = null;

  async repo(slug: string) {
    if (slug !== SLUG) throw new Error(`没有 ${slug}`);
    return { id: REPO_ID, owner: 'acme', name: 'flux', defaultBranch: 'main', archived: false };
  }
  async installationRepoIds(id: number) {
    return new Set(this.installs.get(id) ?? []);
  }
  async addToInstallation(id: number, repoId: number) {
    this.writes.push('install');
    this.installs.get(id)?.add(repoId);
  }
  async labels(slug: string) {
    return (this.labelsBy.get(slug) ?? []).map((l) => ({ ...l }));
  }
  async createLabel(slug: string, l: RepoLabel) {
    this.writes.push('label');
    this.labelsBy.get(slug)?.push({ ...l });
  }
  async editLabel(slug: string, l: RepoLabel) {
    this.writes.push('label');
    const list = this.labelsBy.get(slug) ?? [];
    this.labelsBy.set(
      slug,
      list.map((x) => (x.name === l.name ? { ...l } : x)),
    );
  }
  async listDir(_slug: string, _ref: string, dir: string) {
    const prefix = dir ? `${dir}/` : '';
    const seen = new Map<string, 'file' | 'dir'>();
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const [head, ...more] = p.slice(prefix.length).split('/');
      if (head) seen.set(head, more.length > 0 ? 'dir' : 'file');
    }
    return [...seen].map(([name, type]) => ({ name, type }));
  }
  async fileText(_slug: string, _ref: string, path: string) {
    return this.files.get(path) ?? null;
  }
  async openPrFrom(_slug: string, head: string) {
    return head === FILL_BRANCH ? this.openPr : null;
  }
  async openFillPr(_slug: string, input: { files: { path: string; text: string }[] }) {
    this.writes.push('fill-pr');
    for (const f of input.files) this.branchFiles.set(f.path, f.text);
    this.openPr = { number: 7, url: 'https://github.com/acme/flux/pull/7' };
    return this.openPr;
  }
  /** 补齐 PR 合了：分支上的文件进默认分支。 */
  mergeFillPr() {
    for (const [p, t] of this.branchFiles) this.files.set(p, t);
    this.openPr = null;
  }
  async findIssue(_slug: string, title: string) {
    const i = this.issues.find((x) => x.title === title);
    return i ? { number: i.number, state: 'OPEN' } : null;
  }
  async createIssue(_slug: string, input: { title: string; body: string; labels: string[] }) {
    this.writes.push('issue');
    const number = 100 + this.issues.length;
    this.issues.push({ number, ...input });
    return number;
  }
  async fleetApi(args: string[], stdin?: string): Promise<FleetApiResult> {
    const [cmd, sub, slug] = args;
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (slug !== SLUG && !(cmd === 'dispatch' && sub === SLUG))
      return { code: 2, stdout: '', stderr: '认不出' };
    if (cmd === 'project' && sub === 'show') {
      if (!this.row) return { code: 1, stdout: '', stderr: `没查成：库里没有仓 ${SLUG}` };
      const gaps = REPO_PROFILE_KEYS.filter((k) => !(k in (this.row?.profile ?? {})));
      return ok(JSON.stringify({ ...this.row, testCommand: 'pnpm check', gaps }));
    }
    if (cmd === 'project' && sub === 'register') {
      this.writes.push('register');
      const id = Number(args[args.indexOf('--github-id') + 1]);
      this.row = this.row
        ? { ...this.row, githubId: id }
        : { githubId: id, profile: {}, autoDispatchSince: null };
      return ok('已登记');
    }
    if (cmd === 'project' && sub === 'set-profile') {
      this.writes.push('profile');
      if (!this.row) return { code: 1, stdout: '', stderr: '库里没有仓' };
      this.row.profile = JSON.parse(stdin ?? '{}') as Record<string, unknown>;
      return ok('已改');
    }
    if (cmd === 'dispatch' && args[2] === 'on') {
      this.writes.push('dispatch');
      if (this.row) this.row.autoDispatchSince = '2026-10-16T10:00:00.000Z';
      return ok('已打开');
    }
    return { code: 2, stdout: '', stderr: `认不出 ${args.join(' ')}` };
  }
}

function ctxOf(world: ProjectWorld, apps = APPS): ProjectContext & { lines: string[] } {
  const lines: string[] = [];
  return { world, standardRepo: STD, apps, out: (l) => lines.push(l), lines };
}

describe('参数', () => {
  it('只认 add、check 加 owner/仓', () => {
    expect(parseProjectArgv(['check', SLUG])).toEqual({ action: 'check', slug: SLUG });
    for (const argv of [[], ['add'], ['list', SLUG], ['add', 'flux'], ['add', SLUG, 'x']])
      expect(() => parseProjectArgv(argv)).toThrow(/用法/);
  });
});

describe('project add', () => {
  const statuses = (r: { results: { step: string; status: string }[] }) =>
    Object.fromEntries(r.results.map((x) => [x.step, x.status]));

  it('从头跑到底：第一遍补好前四步、开补齐 PR，check 没全绿就不开接活、不开冒烟单；PR 合了再跑才开接活和冒烟单；每遍重跑不重复写', async () => {
    const w = new FakeWorld();

    // 第一遍
    const first = await projectAdd(ctxOf(w), SLUG);
    expect(first.code).toBe(1);
    expect(statuses(first)).toEqual({
      '1 登记仓': 'fixed',
      '2 装两个 App': 'fixed',
      '3 流程标签': 'fixed',
      '4 仓档案': 'fixed',
      '5 补齐 PR': 'red',
      '6 打开让 AI 接活': 'red',
    });
    expect(w.writes.sort()).toEqual(['fill-pr', 'install', 'label', 'label', 'profile', 'register']);
    expect(w.installs.get(11)?.has(REPO_ID)).toBe(true);
    expect(w.labelsBy.get(SLUG)).toEqual(expect.arrayContaining(LABELS));
    expect(w.row).toMatchObject({
      githubId: REPO_ID,
      autoDispatchSince: null,
      profile: { language: 'go', moduleRoots: ['cmd/*', 'internal/*'], testCommand: 'go test ./...' },
    });
    expect([...w.branchFiles.keys()].sort()).toEqual(Object.values(REQUIRED_FILES).sort());
    expect(w.issues).toEqual([]);

    // 第二遍（PR 还没合）：什么都不写，还是停在补齐 PR
    w.writes = [];
    const second = await projectAdd(ctxOf(w), SLUG);
    expect(second.code).toBe(1);
    expect(w.writes).toEqual([]);
    expect(second.results.find((x) => x.step === '5 补齐 PR')?.detail).toContain('补齐 PR #7 待合');

    // PR 合了：第三遍打开接活、开冒烟单
    w.mergeFillPr();
    const third = await projectAdd(ctxOf(w), SLUG);
    expect(third.code).toBe(0);
    expect(statuses(third)).toMatchObject({ '6 打开让 AI 接活': 'fixed', '7 冒烟单': 'fixed' });
    expect(w.writes).toEqual(['dispatch', 'issue']);
    expect(w.issues.map((i) => [i.title, i.labels])).toEqual([
      [SMOKE_TITLE, ['需求', '域:engine', '性质:process']],
    ]);

    // 第四遍：七步全是 ok，一次都不写
    w.writes = [];
    const fourth = await projectAdd(ctxOf(w), SLUG);
    expect(fourth.code).toBe(0);
    expect(new Set(fourth.results.map((x) => x.status))).toEqual(new Set(['ok']));
    expect(w.writes).toEqual([]);
  });

  it('档案里已经写了的项不覆盖，只补缺的', async () => {
    const w = new FakeWorld();
    w.row = { githubId: REPO_ID, profile: { testCommand: 'make test', weight: 3 }, autoDispatchSince: null };
    await projectAdd(ctxOf(w), SLUG);
    expect(w.row.profile).toMatchObject({ testCommand: 'make test', weight: 3, language: 'go' });
  });

  it('owner 下还没装过 App：停在这一步，提示这个账号或组织要先在网页装一次，不调装仓接口；接活不开', async () => {
    const w = new FakeWorld();
    const apps: AppInstallConfig = {
      apps: { agent: { ...APPS.apps.agent, installations: {} }, engine: APPS.apps.engine },
    };
    const ctx = ctxOf(w, apps);
    const r = await projectAdd(ctx, SLUG);
    const step = r.results.find((x) => x.step === '2 装两个 App');
    expect(step?.status).toBe('red');
    expect(step?.detail).toContain('这个账号或组织要先在网页装一次');
    expect(step?.detail).toContain('https://github.com/apps/fleet-dao-agent/installations/new');
    expect(w.writes).not.toContain('install');
    expect(w.writes).not.toContain('dispatch');
  });

  it('check 有一项不过（标签颜色被人改了）就不打开接活', async () => {
    const w = new FakeWorld();
    await projectAdd(ctxOf(w), SLUG);
    w.mergeFillPr();
    // add 会把标签修回去：直接测 check 判红，再让 add 在修不回去时不开接活
    w.labelsBy.set(SLUG, [{ name: '需求', color: '000000', description: '被人改了' }]);
    const check = await projectCheck(ctxOf(w), SLUG);
    expect(check.code).toBe(1);
    expect(check.results.find((x) => x.step === '3 流程标签')?.status).toBe('red');
    w.editLabel = async () => {
      throw new Error('没权限');
    };
    w.createLabel = async () => {
      throw new Error('没权限');
    };
    w.writes = [];
    const r = await projectAdd(ctxOf(w), SLUG);
    expect(r.code).toBe(1);
    expect(r.results.find((x) => x.step === '6 打开让 AI 接活')?.status).toBe('red');
    expect(w.writes).not.toContain('dispatch');
    expect(w.issues).toEqual([]);
  });

  it('法国读不成：check 退出码 2，不当成过了', async () => {
    const w = new FakeWorld();
    w.fleetApi = async () => ({ code: 255, stdout: '', stderr: 'ssh: connect timed out' });
    const r = await projectCheck(ctxOf(w), SLUG);
    expect(r.code).toBe(2);
    expect(r.results.find((x) => x.step === '1 登记仓')?.status).toBe('unchecked');
  });
});

describe('文件模板', () => {
  it('冒烟单正文四节齐，过得了开单检查', () => {
    const body = smokeIssueBody(SLUG);
    for (const s of ISSUE_SECTIONS) expect(body).toContain(`## ${s}`);
    expect(checkIssueBody(body)).toMatchObject({ ok: true });
  });

  it('单模板四节齐；两个工作流引用标准仓的可复用工作流，是合法的 YAML', () => {
    for (const s of ISSUE_SECTIONS) expect(issueTemplate()).toContain(`## ${s}`);
    const gate = parse(mergeGateCaller(STD)) as { jobs: { 'merge-gate': { uses: string; with: unknown } } };
    expect(gate.jobs['merge-gate']).toEqual({
      uses: `${STD}/.github/workflows/merge-gate.yml@main`,
      with: { 'standard-repo': STD },
    });
    const close = parse(closeOnMergeCaller(STD)) as { jobs: { close: { uses: string } } };
    expect(close.jobs.close.uses).toBe(`${STD}/.github/workflows/close-on-merge.yml@main`);
  });

  it('探测出的档案每一项都是 shared 认的键', async () => {
    const p = await detectProfile(new FakeWorld(), SLUG, 'main');
    expect(Object.keys(p).sort()).toEqual([...REPO_PROFILE_KEYS].sort());
  });
});

describe('可复用的合并闸和关单工作流', () => {
  const read = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url)), 'utf8');

  it.each(['merge-gate.yml', 'close-on-merge.yml'])(
    '%s 有 workflow_call，仓名取 github.repository，不写死哪个仓',
    (name) => {
      const text = read(name);
      const doc = parse(text) as { on: Record<string, unknown> };
      expect(Object.keys(doc.on)).toContain('workflow_call');
      expect(text).toContain('inputs.standard-repo || github.repository');
      expect(text).not.toMatch(/thoerwink8\/fleet-dao/);
    },
  );

  it('project 的代码里也不写死标准仓（从 gh 现读本仓）', () => {
    for (const f of ['project.ts', 'project-world.ts', 'bin/project.ts'])
      expect(readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8')).not.toMatch(
        /thoerwink8\/fleet-dao/,
      );
  });
});

describe('真口子（gh）', () => {
  it('装仓走单仓接口 PUT /user/installations/{id}/repositories/{repo}，没有请求体', async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    };
    await ghProjectWorld(gh, async () => ({ code: 0, stdout: '', stderr: '' })).addToInstallation(
      164544168,
      REPO_ID,
    );
    expect(calls).toEqual([
      ['api', '-X', 'PUT', `user/installations/164544168/repositories/${REPO_ID}`, '--silent'],
    ]);
    expect(calls.flat().some((a) => a === '-f' || a === '-F' || a === '--input' || a === '--field')).toBe(
      false,
    );
  });
});
