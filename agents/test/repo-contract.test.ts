// 仓合同（agents/repo-contract.json + agents/hooks/repo-contract.mjs，决定 0081）：查、补、豁免、命令行退出码、
// 开会话的提醒（每仓每天一次）、引导条目的〔范围：…〕（开会话的 checkDirectives、收尾的 Stop 钩子）。只提醒、不拦。
// 真文件（临时目录）、真 git（临时目录里 init）；读不了的那一路用注入的文件读取造。规矩本身钉在 rules/repo-entry.rules.test.ts。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild, runChildOk } from './child.ts';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: (Error & { code?: string }) | undefined;
}
type Git = (cwd: string, args: string[]) => Result;
interface Item {
  id: string;
  说明: string;
}
interface Checked {
  id: string;
  status: 'ok' | 'missing' | 'skipped' | 'unknown';
  why: string;
  reason?: string;
  note?: string;
}
interface Fs {
  read(path: string): string | null;
  write(path: string, text: string): void;
}
interface Plan {
  actions: { id: string; path: string; kind: string }[];
  blocked: { id: string; why: string }[];
}
interface Lib {
  contractPaths(home: string, hookDir?: string): string[];
  loadContract(paths: string[]): { ok: true; items: Item[]; path: string } | { ok: false; why: string };
  parseContract(text: string): { ok: true; items: Item[] } | { ok: false; why: string };
  checkRepo(root: string, items: Item[], fs?: Fs): Checked[];
  exitCodeOf(results: Checked[]): number;
  formatReport(root: string, results: Checked[]): string;
  planInit(root: string, items: Item[], fs?: Fs): Plan;
  applyInit(root: string, plan: Plan, fs?: Fs): void;
  contractLines(o: { cwd: string; git: Git; home: string; now: number; hookDir?: string }): string[];
  scopeProblem(text: string): null | 'none' | 'unpushed' | 'bad';
  stopScopeCheck(o: { cwd: string; git: Git; seenFile: string | null }): { systemMessage: string } | null;
  ORIGIN_MAIN_DIR: string;
  stampKeyOf(commonDir: string): string;
}
interface SessionLib {
  gitRunner(timeoutMs?: number): Git;
  checkDirectives(cwd: string, git: Git): string[];
}

const LIB = fileURLToPath(new URL('../hooks/repo-contract.mjs', import.meta.url));
const lib = (await import(pathToFileURL(LIB).href)) as Lib;
const session = (await import(
  pathToFileURL(fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url))).href
)) as SessionLib;
const sync = (await import(
  pathToFileURL(fileURLToPath(new URL('../hooks/sync-source.mjs', import.meta.url))).href
)) as {
  syncDirIn(home: string): string;
};
const HOOK_DIR = fileURLToPath(new URL('../hooks/', import.meta.url));
const CONTRACT = lib.loadContract(lib.contractPaths('/no-such-home', HOOK_DIR));
if (!CONTRACT.ok) throw new Error(`合同读不出：${CONTRACT.why}`);
const ITEMS = CONTRACT.items;
const git = session.gitRunner();
const SLOW = { timeout: 0 };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `repo-contract-${name}-`));
  made.push(dir);
  return dir;
}
function put(root: string, files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const g = (cwd: string, ...a: string[]) => runChildOk('git', a, { cwd });
function gitRepo(files: Record<string, string> = {}, commit = true): string {
  const dir = temp('git');
  g(dir, 'init', '-q', '-b', 'main');
  put(dir, { 'README.md': '# 仓\n', ...files });
  if (commit) {
    g(dir, 'add', '-A');
    g(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  }
  return dir;
}

const PKG_OK = JSON.stringify({
  scripts: { dev: 'x dev', start: 'x start', stop: 'x stop', check: 'x check' },
});
const PROGRESS_OK =
  '# 进度\n\n## 创始人引导（待处理）\n\n## 生效中的临时调整\n\n| 内容 | 当时为什么 | 谁拍的 | 撤回条件 | 最迟复查日期 |\n|---|---|---|---|---|\n';
const GOOD: Record<string, string> = {
  'package.json': PKG_OK,
  'AGENTS.md': '# AGENTS.md\n',
  'docs/PROGRESS.md': PROGRESS_OK,
  '.gitignore': 'node_modules/\n_tmp/\n',
};
const byId = (rs: Checked[]) => Object.fromEntries(rs.map((r) => [r.id, r]));

describe('合同本身', () => {
  it('首批四项：entry、agents-md、progress、gitignore-tmp', () => {
    expect(ITEMS.map((i) => i.id)).toEqual(['entry', 'agents-md', 'progress', 'gitignore-tmp']);
  });

  it('装到机器上之后从同步专用检出读：路径和 sync-source.mjs 的 syncDirIn 是同一个', () => {
    const home = temp('home');
    expect(lib.contractPaths(home, join(home, '.fleet-dao', 'hooks'))).toContain(
      join(sync.syncDirIn(home), 'agents', 'repo-contract.json'),
    );
    expect(join(home, lib.ORIGIN_MAIN_DIR)).toBe(sync.syncDirIn(home));
  });

  it('【故意造出的失败】合同读不到、不是 JSON、检查类型认不出、缺 id：明确失败，不当成「没有要求」', () => {
    const r = lib.loadContract([join(temp('none'), 'repo-contract.json')]);
    expect(r.ok).toBe(false);
    expect(lib.parseContract('{不是 JSON').ok).toBe(false);
    const odd = lib.parseContract(
      JSON.stringify({
        items: [{ id: 'x', 说明: 'x', 检查: { type: '猜' }, 补法: { type: 'create', text: '' } }],
      }),
    );
    expect(odd.ok === false && odd.why).toMatch(/认不出/);
    expect(
      lib.parseContract(
        JSON.stringify({
          items: [{ 说明: 'x', 检查: { type: 'file', path: 'a' }, 补法: { type: 'create', text: '' } }],
        }),
      ).ok,
    ).toBe(false);
    expect(lib.parseContract(JSON.stringify({ items: [] })).ok).toBe(false);
  });
});

describe('repo:check 的判法', () => {
  it('四项都齐：全过，退出码 0', () => {
    const rs = lib.checkRepo(put(temp('good'), GOOD), ITEMS);
    expect(rs.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(lib.exitCodeOf(rs)).toBe(0);
  });

  it('空目录：四项都缺，退出码 1，每项说清缺什么', () => {
    const rs = byId(lib.checkRepo(temp('empty'), ITEMS));
    expect(Object.values(rs).map((r) => r.status)).toEqual(['missing', 'missing', 'missing', 'missing']);
    expect(rs.entry?.why).toMatch(/package\.json/);
    expect(rs['agents-md']?.why).toMatch(/AGENTS\.md/);
    expect(lib.exitCodeOf(Object.values(rs))).toBe(1);
  });

  it('entry：少一条、空字符串、repo:init 放的占位都算缺', () => {
    const placeholder = 'echo TODO (repo-contract:placeholder) && exit 1';
    const pkg = JSON.stringify({ scripts: { dev: 'x', start: '', check: placeholder } });
    const r = byId(lib.checkRepo(put(temp('entry'), { ...GOOD, 'package.json': pkg }), ITEMS)).entry;
    expect(r?.status).toBe('missing');
    expect(r?.why).toMatch(/start/);
    expect(r?.why).toMatch(/stop/);
    expect(r?.why).toMatch(/check.*占位|占位.*check/);
    expect(r?.why).not.toMatch(/dev/);
  });

  it('progress：两节缺一节就算缺，说出缺的是哪一节', () => {
    const r = byId(
      lib.checkRepo(
        put(temp('prog'), { ...GOOD, 'docs/PROGRESS.md': '# 进度\n\n## 创始人引导（待处理）\n' }),
        ITEMS,
      ),
    ).progress;
    expect(r?.status).toBe('missing');
    expect(r?.why).toContain('## 生效中的临时调整');
    expect(r?.why).not.toContain('创始人引导');
  });

  it('gitignore-tmp：/_tmp/ 也认；写在注释里、写成 _tmp_x 不认', () => {
    const ok = byId(lib.checkRepo(put(temp('gi'), { ...GOOD, '.gitignore': '/_tmp/\n' }), ITEMS))[
      'gitignore-tmp'
    ];
    expect(ok?.status).toBe('ok');
    const bad = byId(lib.checkRepo(put(temp('gi2'), { ...GOOD, '.gitignore': '# _tmp/\n_tmp_x\n' }), ITEMS))[
      'gitignore-tmp'
    ];
    expect(bad?.status).toBe('missing');
  });

  it('【故意造出的失败】package.json 不是 JSON：认不出（unknown），退出码 2，不当成缺也不当成过', () => {
    const rs = lib.checkRepo(put(temp('badjson'), { ...GOOD, 'package.json': '{坏的' }), ITEMS);
    expect(byId(rs).entry?.status).toBe('unknown');
    expect(byId(rs).entry?.why).toMatch(/JSON/);
    expect(lib.exitCodeOf(rs)).toBe(2);
  });

  it('【故意造出的失败】文件读不了（权限之类）：认不出，带上原因，退出码 2', () => {
    const fs: Fs = {
      read: () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
      write: () => {},
    };
    const rs = lib.checkRepo(temp('eacces'), ITEMS, fs);
    expect(rs.every((r) => r.status === 'unknown')).toBe(true);
    expect(rs[0]?.why).toContain('EACCES');
    expect(lib.exitCodeOf(rs)).toBe(2);
  });

  it('豁免：AGENTS.md 里写了理由的算豁免、输出里看得见理由；没写理由的不算数、照查、也说出来', () => {
    const agents =
      '# AGENTS.md\n<!-- repo-contract:skip entry 纯文档仓，没有能跑的东西 -->\n<!-- repo-contract:skip progress -->\n';
    const root = put(temp('skip'), { 'AGENTS.md': agents, '.gitignore': '_tmp/\n' });
    const rs = lib.checkRepo(root, ITEMS);
    const r = byId(rs);
    expect(r.entry?.status).toBe('skipped');
    expect(r.entry?.reason).toBe('纯文档仓，没有能跑的东西');
    expect(r.progress?.status).toBe('missing');
    expect(r.progress?.note).toMatch(/豁免没写理由/);
    const report = lib.formatReport(root, rs);
    expect(report).toContain('纯文档仓，没有能跑的东西');
    expect(report).toMatch(/豁免没写理由/);
    expect(lib.exitCodeOf(rs)).toBe(1);
  });
});

describe('repo:init：只补缺的，绝不覆盖', () => {
  it('空目录：补出四样骨架；入口是占位，所以 entry 仍算缺，其余三项过', () => {
    const root = temp('init');
    lib.applyInit(root, lib.planInit(root, ITEMS));
    const r = byId(lib.checkRepo(root, ITEMS));
    expect(r.entry?.status).toBe('missing');
    expect(r.entry?.why).toMatch(/占位/);
    expect(r['agents-md']?.status).toBe('ok');
    expect(r.progress?.status).toBe('ok');
    expect(r['gitignore-tmp']?.status).toBe('ok');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.scripts)).toEqual(['dev', 'start', 'stop', 'check']);
    expect(pkg.scripts.dev).toMatch(/exit 1/);
  });

  it('第二次跑：什么都不改', () => {
    const root = temp('twice');
    lib.applyInit(root, lib.planInit(root, ITEMS));
    expect(lib.planInit(root, ITEMS).actions).toEqual([]);
  });

  it('已有的内容一个字不动：已有的脚本、AGENTS.md、PROGRESS 正文、.gitignore 原样保留，只往后补', () => {
    const root = put(temp('keep'), {
      'package.json': JSON.stringify(
        { name: 'mine', scripts: { dev: 'vite', test: 'vitest' }, extra: [1, 2] },
        null,
        4,
      ),
      'AGENTS.md': '# 我自己的\n',
      'docs/PROGRESS.md': '# 进度\n\n原来的正文',
      '.gitignore': 'node_modules/',
    });
    lib.applyInit(root, lib.planInit(root, ITEMS));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('mine');
    expect(pkg.extra).toEqual([1, 2]);
    expect(pkg.scripts.dev).toBe('vite');
    expect(pkg.scripts.test).toBe('vitest');
    expect(pkg.scripts.start).toMatch(/repo-contract:placeholder/);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# 我自己的\n');
    const progress = readFileSync(join(root, 'docs/PROGRESS.md'), 'utf8');
    expect(progress.startsWith('# 进度\n\n原来的正文\n')).toBe(true);
    expect(progress).toContain('## 创始人引导（待处理）');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n_tmp/\n');
  });

  it('【故意造出的失败】package.json 坏了：不碰它（认不出不动），别的照补', () => {
    const root = put(temp('bad'), { 'package.json': '{坏的' });
    const plan = lib.planInit(root, ITEMS);
    expect(plan.blocked.map((b) => b.id)).toEqual(['entry']);
    lib.applyInit(root, plan);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{坏的');
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  });

  it('豁免了的项不补', () => {
    const root = put(temp('skipinit'), { 'AGENTS.md': '<!-- repo-contract:skip entry 纯文档仓 -->\n' });
    expect(lib.planInit(root, ITEMS).actions.map((a) => a.id)).not.toContain('entry');
  });
});

describe('命令行：node agents/hooks/repo-contract.mjs check|init', SLOW, () => {
  const cli = (args: string[], cwd?: string) =>
    runChild(process.execPath, [LIB, ...args], {
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, INIT_CWD: '' },
    });

  it('check：全过 0、缺 1、认不出 2，并说原因', () => {
    expect(cli(['check', put(temp('c0'), GOOD)]).status).toBe(0);
    const miss = cli(['check', temp('c1')]);
    expect(miss.status).toBe(1);
    expect(miss.stdout).toContain('entry');
    const bad = cli(['check', put(temp('c2'), { ...GOOD, 'package.json': '{坏' })]);
    expect(bad.status).toBe(2);
    expect(bad.stdout + bad.stderr).toMatch(/JSON/);
  });

  it('不给路径：查当前目录；pnpm 跑的时候认 INIT_CWD（pnpm 把工作目录换成了 fleet-dao）', () => {
    const good = put(temp('cwd'), GOOD);
    expect(cli(['check'], good).status).toBe(0);
    const viaPnpm = runChild(process.execPath, [LIB, 'check'], {
      cwd: temp('elsewhere'),
      env: { ...process.env, INIT_CWD: good },
    });
    expect(viaPnpm.status).toBe(0);
  });

  it('init --dry-run：打印要做什么，一个文件都不写', () => {
    const root = temp('dry');
    const r = cli(['init', root, '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('package.json');
    expect(r.stdout).toContain('AGENTS.md');
    expect(existsSync(join(root, 'package.json'))).toBe(false);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  });

  it('init：补完提示入口是占位，要填上真正的启动方式才算 entry 通过', () => {
    const root = temp('real');
    const r = cli(['init', root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/占位/);
    expect(existsSync(join(root, 'docs', 'PROGRESS.md'))).toBe(true);
  });

  it('【故意造出的失败】不认识的子命令、路径不存在：退出码 2', () => {
    expect(cli(['乱来']).status).toBe(2);
    expect(cli(['check', join(temp('gone'), 'nope')]).status).toBe(2);
  });
});

describe('开会话的提醒（contractLines）：每仓每天最多一次，全过不出声', SLOW, () => {
  const NOW = Date.parse('2026-10-12T04:00:00Z');
  const DAY = 24 * 3_600_000;

  it('有缺项：一段事实陈述（缺什么、怎么补、怎么豁免）；同一天第二次不说；第二天再说', () => {
    const root = gitRepo();
    const home = temp('home');
    const first = lib.contractLines({ cwd: root, git, home, now: NOW, hookDir: HOOK_DIR });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/仓合同/);
    expect(first[0]).toMatch(/entry（[^）]*package\.json/);
    expect(first[0]).toMatch(/repo-contract\.mjs" init "/);
    expect(first[0]).toContain('repo-contract:skip');
    expect(lib.contractLines({ cwd: root, git, home, now: NOW + 3_600_000, hookDir: HOOK_DIR })).toEqual([]);
    expect(lib.contractLines({ cwd: root, git, home, now: NOW + DAY, hookDir: HOOK_DIR })).toHaveLength(1);
  });

  it('一天一次的记号按 git 公共目录分仓，和 fresh-main.mjs 的 repoStampKey 同一种算法（同一棵仓的工作树共用一个）', async () => {
    const fresh = (await import(
      pathToFileURL(fileURLToPath(new URL('../hooks/fresh-main.mjs', import.meta.url))).href
    )) as { repoStampKey(cwd: string, git: Git, okOf: (r: Result) => boolean): string | null };
    const root = gitRepo();
    const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
    const want = fresh.repoStampKey(root, git, (r) => r.status === 0 && !r.error);
    expect(lib.stampKeyOf(common)).toBe(want);
    const home = temp('home');
    lib.contractLines({ cwd: root, git, home, now: NOW, hookDir: HOOK_DIR });
    expect(existsSync(join(home, '.fleet-dao', 'repo-contract', String(want)))).toBe(true);
  });

  it('全过：一个字不说', () => {
    const root = gitRepo(GOOD);
    expect(lib.contractLines({ cwd: root, git, home: temp('home'), now: NOW, hookDir: HOOK_DIR })).toEqual(
      [],
    );
  });

  it('不是 git 仓：不出声', () => {
    expect(
      lib.contractLines({ cwd: temp('plain'), git, home: temp('home'), now: NOW, hookDir: HOOK_DIR }),
    ).toEqual([]);
  });

  it('【故意造出的失败】合同读不到：说一句没查成，不当成全过', () => {
    const lines = lib.contractLines({
      cwd: gitRepo(),
      git,
      home: temp('home'),
      now: NOW,
      hookDir: temp('nohooks'),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/仓合同没查成/);
  });

  it('【故意造出的失败】git 跑不起来、git 抛错：不抛、不出声（git 坏了由别的段说）', () => {
    const dead: Git = () => ({ status: 3221225781, stdout: '', stderr: '' });
    expect(
      lib.contractLines({ cwd: temp('x'), git: dead, home: temp('home'), now: NOW, hookDir: HOOK_DIR }),
    ).toEqual([]);
    const throwing: Git = () => {
      throw new Error('炸了');
    };
    const out = lib.contractLines({
      cwd: temp('y'),
      git: throwing,
      home: temp('home'),
      now: NOW,
      hookDir: HOOK_DIR,
    });
    expect(out.join('')).toMatch(/仓合同没查成/);
  });
});

describe('引导条目的〔范围：…〕', () => {
  it('scopeProblem：没标、标了通用没上推、认不出；只此仓和已上推的不算问题', () => {
    expect(lib.scopeProblem('- 04:00「要 pnpm 命令」')).toBe('none');
    expect(lib.scopeProblem('- 04:00「要 pnpm 命令」〔范围：通用〕')).toBe('unpushed');
    expect(lib.scopeProblem('- 04:00「要 pnpm 命令」〔范围：通用→fleet-dao#1934〕')).toBeNull();
    expect(lib.scopeProblem('- 04:00「飞瓜别重登」〔范围：只此仓〕')).toBeNull();
    expect(lib.scopeProblem('- 04:00「x」〔范围：大概通用〕')).toBe('bad');
  });
});

describe('开会话的 checkDirectives：待处理的条目没标范围、标了通用没上推，各补一句', SLOW, () => {
  const head = '# 进度\n\n## 创始人引导（待处理）\n\n';
  const tail = '\n## 别的节\n';

  it('没标范围：同一行里补一句「没标范围」，原来的那几句照旧', () => {
    const [line] = session.checkDirectives(
      gitRepo({ 'docs/PROGRESS.md': `${head}- 04:00「要 pnpm 命令」\n${tail}` }),
      git,
    );
    expect(line).toContain('创始人引导还有 1 条没处理');
    expect(line).toMatch(/1 条没标范围/);
    expect(line).toContain('〔范围：通用〕');
  });

  it('标了通用、没有 →fleet-dao#号：补一句「还没上推」', () => {
    const [line] = session.checkDirectives(
      gitRepo({ 'docs/PROGRESS.md': `${head}- 04:00「要 pnpm 命令」〔范围：通用〕\n${tail}` }),
      git,
    );
    expect(line).toMatch(/1 条标了通用、还没上推/);
    expect(line).not.toMatch(/没标范围/);
  });

  it('只此仓、已上推的：不补', () => {
    const text = `${head}- 04:00「a」〔范围：只此仓〕\n- 04:01「b」〔范围：通用→fleet-dao#1934〕\n${tail}`;
    const [line] = session.checkDirectives(gitRepo({ 'docs/PROGRESS.md': text }), git);
    expect(line).toContain('创始人引导还有 2 条没处理');
    expect(line).not.toMatch(/没标范围|还没上推/);
  });

  it('已处理的老条目不追溯：没标范围也不出声', () => {
    const text = `${head}- 03:50「密钥要有历史」已处理\n${tail}`;
    expect(session.checkDirectives(gitRepo({ 'docs/PROGRESS.md': text }), git)).toEqual([]);
  });
});

describe('收尾的 Stop 钩子（stopScopeCheck）：比 HEAD 新记的引导没标范围，提醒一次', SLOW, () => {
  const head = '# 进度\n\n## 创始人引导（待处理）\n\n';
  const oldItem = '- 03:50「密钥要有历史」\n';

  it('新加了一条没标范围的：提醒它（不提早就在 HEAD 里的老条目）；同一会话第二次不再说', () => {
    const root = gitRepo({ 'docs/PROGRESS.md': `${head}${oldItem}` });
    writeFileSync(join(root, 'docs/PROGRESS.md'), `${head}${oldItem}- 04:00「要 pnpm 命令」\n`);
    const seen = join(temp('state'), 'seen.json');
    const out = lib.stopScopeCheck({ cwd: root, git, seenFile: seen });
    expect(out?.systemMessage).toContain('要 pnpm 命令');
    expect(out?.systemMessage).not.toContain('密钥');
    expect(out?.systemMessage).toContain('〔范围：通用〕');
    expect(Object.keys(out ?? {})).toEqual(['systemMessage']);
    expect(lib.stopScopeCheck({ cwd: root, git, seenFile: seen })).toBeNull();
  });

  it('新加的标了范围：不出声', () => {
    const root = gitRepo({ 'docs/PROGRESS.md': head });
    writeFileSync(join(root, 'docs/PROGRESS.md'), `${head}- 04:00「要 pnpm 命令」〔范围：通用〕\n`);
    expect(lib.stopScopeCheck({ cwd: root, git, seenFile: null })).toBeNull();
  });

  it('还没有提交过（HEAD 里没有这个文件）：现有的待处理条目都算新的', () => {
    const root = gitRepo({ 'docs/PROGRESS.md': `${head}${oldItem}` }, false);
    expect(lib.stopScopeCheck({ cwd: root, git, seenFile: null })?.systemMessage).toContain('密钥要有历史');
  });

  it('没有 docs/PROGRESS.md、不是 git 仓：不出声', () => {
    expect(lib.stopScopeCheck({ cwd: gitRepo(), git, seenFile: null })).toBeNull();
    expect(lib.stopScopeCheck({ cwd: temp('plain'), git, seenFile: null })).toBeNull();
  });

  it('【故意造出的失败】git 跑不起来：说没查成，不当成没有', () => {
    const root = put(temp('nogit'), { 'docs/PROGRESS.md': `${head}${oldItem}` });
    const dead: Git = (_cwd, args) =>
      args[0] === 'rev-parse'
        ? { status: 0, stdout: `${root}\n`, stderr: '' }
        : { status: 3221225781, stdout: '', stderr: '' };
    expect(lib.stopScopeCheck({ cwd: root, git: dead, seenFile: null })?.systemMessage).toMatch(/没查成/);
  });
});
