// 下发副本漂移提醒（agents/downstream-copies.json + agents/hooks/downstream-copies.mjs，#3665）：
// 一致不提醒、不一致提醒、没有副本不提醒、读不到本机装的上游报没查成；开会话钩子接上之后照样出这一行。
// 真文件（临时目录）、真 git（临时目录里 init）；家目录是临时目录，本机装的上游按 ~/.claude/skills、~/.agents/skills 造。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChildOk } from './child.ts';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: (Error & { code?: string }) | undefined;
}
type Git = (cwd: string, args: string[]) => Result;
interface Item {
  id: string;
  技能: string;
  技能里的路径: string;
  文件名: string;
  开头: string;
}
interface Lib {
  listPaths(home: string, hookDir?: string): string[];
  loadList(paths: string[]): { ok: true; items: Item[]; path: string } | { ok: false; why: string };
  parseList(text: string): { ok: true; items: Item[] } | { ok: false; why: string };
  installedPaths(home: string, item: Item): string[];
  copyLines(o: { cwd: string; git: Git; home: string; hookDir?: string }): string[];
  ORIGIN_MAIN_DIR: string;
}
interface SessionLib {
  gitRunner(timeoutMs?: number): Git;
  fastSessionStart(o: Record<string, unknown>): string[];
}

const lib = (await import(
  pathToFileURL(fileURLToPath(new URL('../hooks/downstream-copies.mjs', import.meta.url))).href
)) as Lib;
const session = (await import(
  pathToFileURL(fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url))).href
)) as SessionLib;
const sync = (await import(
  pathToFileURL(fileURLToPath(new URL('../hooks/sync-source.mjs', import.meta.url))).href
)) as { syncDirIn(home: string): string };
const HOOK_DIR = fileURLToPath(new URL('../hooks/', import.meta.url));
const AGENTS = fileURLToPath(new URL('../', import.meta.url));
const LIST = lib.loadList(lib.listPaths('/no-such-home', HOOK_DIR));
if (!LIST.ok) throw new Error(`下发清单读不出：${LIST.why}`);
const DRAFT = LIST.items.find((i) => i.id === 'discussion-draft');
if (!DRAFT) throw new Error('下发清单里没有 discussion-draft');
const UPSTREAM = readFileSync(join(AGENTS, 'skills', DRAFT.技能, ...DRAFT.技能里的路径.split('/')), 'utf8');
const git = session.gitRunner();
const SLOW = { timeout: 0 };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `downstream-${name}-`));
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
function gitRepo(files: Record<string, string>): string {
  const dir = temp('repo');
  g(dir, 'init', '-q', '-b', 'main');
  put(dir, { 'README.md': '# 仓\n', ...files });
  g(dir, 'add', '-A');
  g(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}
/** 家目录：本机装的技能在 ~/.claude/skills（under 给 .agents 就装到 ~/.agents/skills） */
function homeWith(text: string | null, under = '.claude'): string {
  const home = temp('home');
  if (text !== null) put(home, { [join(under, 'skills', 'discussion-draft', 'scripts', 'draft.mjs')]: text });
  return home;
}
const lines = (cwd: string, home: string) => lib.copyLines({ cwd, git, home, hookDir: HOOK_DIR });

describe('下发清单本身', () => {
  it('第一项是讨论稿的 draft.mjs：上游真在、上游第一行认得出副本', () => {
    expect(LIST.items[0]?.id).toBe('discussion-draft');
    expect(UPSTREAM.split('\n', 1)[0]?.startsWith(DRAFT.开头)).toBe(true);
  });

  it('装到机器上之后从同步专用检出读；本机装的上游先找 ~/.claude/skills，再找 ~/.agents/skills', () => {
    const home = temp('home');
    expect(lib.listPaths(home, join(home, '.fleet-dao', 'hooks'))).toContain(
      join(sync.syncDirIn(home), 'agents', 'downstream-copies.json'),
    );
    expect(lib.installedPaths(home, DRAFT)).toEqual([
      join(home, '.claude', 'skills', 'discussion-draft', 'scripts', 'draft.mjs'),
      join(home, '.agents', 'skills', 'discussion-draft', 'scripts', 'draft.mjs'),
    ]);
  });

  it('认不出的项明确失败，不跳过', () => {
    expect(lib.parseList('{').ok).toBe(false);
    const bad = lib.parseList(JSON.stringify({ items: [{ ...DRAFT, 文件名: '*.mjs' }] }));
    expect(bad).toMatchObject({ ok: false });
    expect(lib.parseList(JSON.stringify({ items: [{ ...DRAFT, 开头: '' }] }))).toMatchObject({ ok: false });
  });
});

describe('开会话的提醒（copyLines）', SLOW, () => {
  it('副本和本机装的上游一致：不出声（换行符不同也算一致）', () => {
    const root = gitRepo({ 'tools/draft.mjs': UPSTREAM.replace(/\n/g, '\r\n') });
    expect(lines(root, homeWith(UPSTREAM))).toEqual([]);
  });

  it('副本和上游不一样：一行，指向哪个技能、从哪拷', () => {
    const root = gitRepo({ 'tools/draft.mjs': `${UPSTREAM}// 本仓改过一行\n` });
    const home = homeWith(UPSTREAM);
    const out = lines(root, home);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('tools/draft.mjs');
    expect(out[0]).toContain('discussion-draft 技能');
    expect(out[0]).toContain(join(home, '.claude', 'skills', 'discussion-draft', 'scripts', 'draft.mjs'));
  });

  it('只装在 ~/.agents/skills 也比得了', () => {
    const root = gitRepo({ 'draft.mjs': `${UPSTREAM}x\n` });
    const out = lines(root, homeWith(UPSTREAM, '.agents'));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('原样再拷一次');
  });

  it('没有副本不出声：没有同名文件、同名但开头不是上游那行的、没跟踪的都不算', () => {
    const home = homeWith(UPSTREAM);
    expect(lines(gitRepo({ 'src/a.mjs': 'x\n' }), home)).toEqual([]);
    const root = gitRepo({ 'scripts/draft.mjs': '// 本仓自己的 draft，和讨论稿无关\n' });
    put(root, { 'untracked/draft.mjs': `${UPSTREAM}x\n` });
    expect(lines(root, home)).toEqual([]);
  });

  it('没有副本时读不到上游也不出声（用不到上游）', () => {
    expect(lines(gitRepo({ 'src/a.mjs': 'x\n' }), homeWith(null))).toEqual([]);
  });

  it('有副本、读不到本机装的上游：照实说没查成，不当成一致', () => {
    const root = gitRepo({ 'tools/draft.mjs': UPSTREAM });
    const out = lines(root, homeWith(null));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^下发副本没查成/);
    expect(out[0]).toContain('tools/draft.mjs');
    expect(out[0]).toContain('读不到');
  });

  it('fleet-dao 里上游本身那份不算副本', () => {
    const root = gitRepo({ 'agents/skills/discussion-draft/scripts/draft.mjs': `${UPSTREAM}x\n` });
    expect(lines(root, homeWith(UPSTREAM))).toEqual([]);
  });

  it('不是 git 仓不出声；读不到下发清单说没查成', () => {
    const home = homeWith(UPSTREAM);
    expect(lines(temp('plain'), home)).toEqual([]);
    const root = gitRepo({ 'src/a.mjs': 'x\n' });
    const out = lib.copyLines({ cwd: root, git, home, hookDir: join(temp('nohooks'), 'hooks') });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^下发副本没查成：读不到下发清单/);
  });

  it('只读：查完仓里的文件一个没变', () => {
    const root = gitRepo({ 'tools/draft.mjs': `${UPSTREAM}x\n` });
    lines(root, homeWith(UPSTREAM));
    expect(g(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });
});

describe('开会话钩子接上（fastSessionStart 的 downstreamCopies）', SLOW, () => {
  it('漂了的那一行进开场', () => {
    const root = gitRepo({ 'tools/draft.mjs': `${UPSTREAM}x\n` });
    const home = homeWith(UPSTREAM);
    const out = session.fastSessionStart({
      cwd: root,
      home,
      git,
      env: {},
      progress: () => ({ status: 0, stdout: '', stderr: '' }),
      spawnBackground: () => ({ ok: true }),
      downstreamCopies: (dir: string) => lib.copyLines({ cwd: dir, git, home, hookDir: HOOK_DIR }),
    });
    expect(out.some((l) => l.startsWith('下发副本和上游不一样') && l.includes('tools/draft.mjs'))).toBe(true);
  });
});
