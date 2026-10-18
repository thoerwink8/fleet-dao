// 仓是哪一种（agents/hooks/repo-kind.mjs，决定 0107）：自用仓靠仓根 AGENTS.md 一行标记（旧的私人仓写法照认），fleet-dao 认两份文件，
// 其余一律对外仓；没标记、远端又全在创始人 GitHub 下的仓开会话提醒一句，每仓每天一次。
// 真文件、真 git（临时目录里 init）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChildOk } from './child.ts';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
type Git = (cwd: string, args: string[]) => Result;
interface Lib {
  SELF_MARK: string;
  LEGACY_SELF_MARKS: string[];
  repoKind(root: string): 'self' | 'external';
  hasSelfMark(root: string): boolean;
  githubOwnerOf(url: string): string | null;
  allFounderRemotes(urls: string[], owners?: string[]): boolean;
  kindReminderLines(o: { cwd: string; git: Git; home: string; now?: number }): string[];
}

const lib = (await import(
  pathToFileURL(fileURLToPath(new URL('../hooks/repo-kind.mjs', import.meta.url))).href
)) as Lib;
const { gitRunner } = (await import(
  pathToFileURL(fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url))).href
)) as { gitRunner(ms?: number): Git };
const git = gitRunner();

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'repo-kind-'));
  made.push(d);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), text);
  }
  return d;
}
function gitRepo(files: Record<string, string>, remotes: Record<string, string>): string {
  const d = dir(files);
  runChildOk('git', ['init', '-q'], { cwd: d });
  for (const [name, url] of Object.entries(remotes))
    runChildOk('git', ['remote', 'add', name, url], { cwd: d });
  return d;
}

describe('repoKind：自用仓靠标记，其余都是对外仓', () => {
  it('新写法、旧的私人仓写法（两头有空白也认）都是自用仓', () => {
    expect(lib.repoKind(dir({ 'AGENTS.md': `# x\n\n  ${lib.SELF_MARK}  \n` }))).toBe('self');
    for (const old of lib.LEGACY_SELF_MARKS)
      expect(lib.repoKind(dir({ 'AGENTS.md': `# x\n${old}\n` }))).toBe('self');
  });

  it('fleet-dao 认两份文件，不靠标记', () => {
    expect(
      lib.repoKind(dir({ 'agents/shared-rules.md': 'x', 'packages/conventions/standard-paths.json': '{}' })),
    ).toBe('self');
    expect(lib.repoKind(dir({ 'agents/shared-rules.md': 'x' }))).toBe('external');
  });

  it('标记只写在一行里的说明中、没 AGENTS.md、空目录：对外仓（严的一边）', () => {
    expect(lib.repoKind(dir({ 'AGENTS.md': `说明里提到 ${lib.SELF_MARK} 不算\n` }))).toBe('external');
    expect(lib.repoKind(dir({ 'README.md': lib.SELF_MARK }))).toBe('external');
    expect(lib.repoKind(dir())).toBe('external');
    expect(lib.repoKind(join(dir(), '不存在'))).toBe('external');
  });
});

describe('远端是不是创始人自己的 GitHub', () => {
  it('认 scp 写法、https、ssh://、github 开头的 ssh 别名；GitLab、别的账号不算', () => {
    expect(lib.githubOwnerOf('git@github.com:thoerwink8/fleet-dao.git')).toBe('thoerwink8');
    expect(lib.githubOwnerOf('https://github.com/thoerwink8/x')).toBe('thoerwink8');
    expect(lib.githubOwnerOf('ssh://git@github.com/thoerwink8/x.git')).toBe('thoerwink8');
    expect(lib.githubOwnerOf('github-work:thoerwink8/x.git')).toBe('thoerwink8');
    expect(lib.githubOwnerOf('git@gitlab.example.com:group/x.git')).toBeNull();
    expect(lib.githubOwnerOf('/srv/git/x.git')).toBeNull();
  });

  it('要至少一个远端、而且全在他的账号下；有一个是公司 GitLab 或别人的就不算', () => {
    expect(lib.allFounderRemotes(['git@github.com:thoerwink8/a.git'])).toBe(true);
    expect(lib.allFounderRemotes(['https://github.com/THOERWINK8/a'])).toBe(true);
    expect(lib.allFounderRemotes([])).toBe(false);
    expect(
      lib.allFounderRemotes(['git@github.com:thoerwink8/a.git', 'git@gitlab.corp.example:g/a.git']),
    ).toBe(false);
    expect(lib.allFounderRemotes(['git@github.com:someone/a.git'])).toBe(false);
  });
});

describe('开会话的提醒（kindReminderLines）', () => {
  const NOW = Date.parse('2026-10-18T04:00:00Z');
  const DAY = 24 * 3_600_000;

  it('没标记、远端全在他 GitHub 下：提醒问他要不要加标记，同一天不再说，第二天再说', () => {
    const root = gitRepo({ 'AGENTS.md': '# x\n' }, { origin: 'git@github.com:thoerwink8/mine.git' });
    const home = dir();
    const first = lib.kindReminderLines({ cwd: root, git, home, now: NOW });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/像是自用仓/);
    expect(first[0]).toContain(lib.SELF_MARK);
    expect(first[0]).toMatch(/没说就照对外仓办/);
    expect(lib.kindReminderLines({ cwd: root, git, home, now: NOW + 3_600_000 })).toEqual([]);
    expect(lib.kindReminderLines({ cwd: root, git, home, now: NOW + DAY })).toHaveLength(1);
  });

  it('打了标记的、远端有公司 GitLab 的、没有远端的、不是 git 仓的：不出声', () => {
    const home = dir();
    const marked = gitRepo(
      { 'AGENTS.md': `${lib.SELF_MARK}\n` },
      { origin: 'git@github.com:thoerwink8/a.git' },
    );
    const company = gitRepo(
      {},
      { origin: 'git@gitlab.corp.example:g/a.git', github: 'git@github.com:thoerwink8/a.git' },
    );
    const bare = gitRepo({}, {});
    for (const cwd of [marked, company, bare, dir()])
      expect(lib.kindReminderLines({ cwd, git, home, now: NOW })).toEqual([]);
  });

  it('insteadOf 只改传输地址：原始 GitHub 身份仍首次提醒、同日节流、次日再提醒', () => {
    const url = 'https://github.com/thoerwink8/mine.git';
    const root = gitRepo({}, { origin: url });
    const home = dir();
    const rewritten: Git = (cwd, args) =>
      git(cwd, [
        '-c',
        'url.https://relay.fixture.invalid/.insteadOf=https://github.com/thoerwink8/',
        ...args,
      ]);
    expect(rewritten(root, ['remote', '-v']).stdout).toContain('https://relay.fixture.invalid/mine.git');
    const first = lib.kindReminderLines({ cwd: root, git: rewritten, home, now: NOW });
    expect(first).toHaveLength(1);
    expect(first[0]).toContain(url);
    expect(first[0]).not.toContain('relay.fixture.invalid');
    expect(lib.kindReminderLines({ cwd: root, git: rewritten, home, now: NOW + 3_600_000 })).toEqual([]);
    expect(lib.kindReminderLines({ cwd: root, git: rewritten, home, now: NOW + DAY })).toHaveLength(1);
  });

  it('陌生原始地址即使传输改成创始人 GitHub 也不提醒，显式非创始人 pushurl 也不漏', () => {
    const stranger = 'https://unknown.fixture.invalid/repo.git';
    const root = gitRepo({}, { origin: stranger });
    const home = dir();
    const rewritten: Git = (cwd, args) =>
      git(cwd, ['-c', `url.https://github.com/thoerwink8/mine.git.insteadOf=${stranger}`, ...args]);
    expect(rewritten(root, ['remote', '-v']).stdout).not.toContain(stranger);
    expect(lib.repoKind(root)).toBe('external');
    expect(lib.kindReminderLines({ cwd: root, git: rewritten, home, now: NOW })).toEqual([]);
    const mixed = gitRepo({}, { origin: 'git@github.com:thoerwink8/mine.git' });
    runChildOk('git', ['config', 'remote.origin.pushurl', 'git@github.com:someone/other.git'], {
      cwd: mixed,
    });
    expect(lib.kindReminderLines({ cwd: mixed, git, home, now: NOW })).toEqual([]);
  });

  it('读取远端配置失败明确说没查成，不当成没有远端', () => {
    const root = gitRepo({}, { origin: 'git@github.com:thoerwink8/mine.git' });
    const home = dir();
    for (const failed of [
      { status: 128, stdout: '', stderr: 'cannot read config' },
      { status: null, stdout: '', stderr: '', error: new Error('timed out') },
    ]) {
      const broken: Git = (cwd, args) => (args[0] === 'rev-parse' ? git(cwd, args) : failed);
      expect(lib.kindReminderLines({ cwd: root, git: broken, home, now: NOW }).join('')).toMatch(
        /仓类型没查成/,
      );
    }
  });

  it('【故意造出的失败】git 抛错：不抛，说一句没查成、照对外仓办', () => {
    const throwing: Git = () => {
      throw new Error('炸了');
    };
    const out = lib.kindReminderLines({ cwd: dir(), git: throwing, home: dir(), now: NOW });
    expect(out.join('')).toMatch(/仓类型没查成.*照对外仓办/);
  });
});
