// 仓是哪一种（agents/hooks/repo-kind.mjs，决定 0108）：本机 .git/config 说过的最先；fleet-dao、AGENTS.md 自用仓标记是自用仓；
// 再看远端，有一个不在创始人 GitHub 下就是对外仓，全在就是自用仓；没远端（不在 GitHub 上）照对外仓办，不问。
// pnpm repo:kind self|external 记进本机，有不在他 GitHub 下的远端却记成自用仓时提醒后果。真文件、真 git（临时目录里 init）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild, runChildOk } from './child.ts';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
type Git = (cwd: string, args: string[]) => Result;
interface Info {
  kind: 'self' | 'external';
  source: string;
  why: string;
  remotes: string[];
}
interface Lib {
  SELF_MARK: string;
  LEGACY_SELF_MARKS: string[];
  CONFIG_KEY: string;
  repoKind(root: string, deps?: { git?: Git }): 'self' | 'external';
  repoKindInfo(root: string, deps?: { git?: Git }): Info;
  githubOwnerOf(url: string): string | null;
  isFounderRemote(url: string, owners?: string[]): boolean;
  setRepoKind(
    root: string,
    kind: 'self' | 'external',
    git: Git,
  ): { ok: true; lines: string[] } | { ok: false; why: string };
}

const LIB = fileURLToPath(new URL('../hooks/repo-kind.mjs', import.meta.url));
const lib = (await import(pathToFileURL(LIB).href)) as Lib;
const { gitRunner } = (await import(
  pathToFileURL(fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url))).href
)) as { gitRunner(ms?: number): Git };
const git = gitRunner();

const MINE = 'git@github.com:thoerwink8/mine.git';
const COMPANY = 'git@gitlab.corp.example:group/app.git';

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
const kindOf = (root: string) => lib.repoKind(root, { git });

describe('看远端：有一个不在创始人 GitHub 下就是对外仓，全在就是自用仓', () => {
  it('远端全在他 GitHub 下：自用仓；不用标记', () => {
    expect(lib.repoKindInfo(gitRepo({}, { origin: MINE }), { git })).toMatchObject({
      kind: 'self',
      source: 'remote',
    });
  });

  it('公司 GitLab、内网地址、别人的 GitHub，哪怕另有一个他 GitHub 的远端：对外仓', () => {
    expect(kindOf(gitRepo({}, { origin: COMPANY, github: MINE }))).toBe('external');
    expect(kindOf(gitRepo({}, { origin: 'http://192.168.0.10:8848/biz/app.git' }))).toBe('external');
    expect(kindOf(gitRepo({}, { origin: 'git@github.com:someone/x.git' }))).toBe('external');
  });

  it('没有远端：判不出来，照对外仓办（source 是 no-remote）', () => {
    expect(lib.repoKindInfo(gitRepo({}, {}), { git })).toMatchObject({
      kind: 'external',
      source: 'no-remote',
    });
  });

  it('不是 git 仓、目录不在：照对外仓办', () => {
    expect(kindOf(dir())).toBe('external');
    expect(kindOf(join(dir(), '不存在'))).toBe('external');
  });
});

describe('例外：本机说过的最先，其次 fleet-dao 和自用仓标记', () => {
  it('本机 .git/config 记着 self / external：盖过远端；认不出的值不算', () => {
    const company = gitRepo({}, { origin: COMPANY });
    runChildOk('git', ['config', lib.CONFIG_KEY, 'self'], { cwd: company });
    expect(lib.repoKindInfo(company, { git })).toMatchObject({ kind: 'self', source: 'config' });
    const mine = gitRepo({}, { origin: MINE });
    runChildOk('git', ['config', lib.CONFIG_KEY, 'external'], { cwd: mine });
    expect(kindOf(mine)).toBe('external');
    const odd = gitRepo({}, { origin: MINE });
    runChildOk('git', ['config', lib.CONFIG_KEY, 'company'], { cwd: odd });
    expect(lib.repoKindInfo(odd, { git }).source).toBe('remote');
  });

  it('AGENTS.md 自用仓标记（新写法、旧的私人仓写法，两头空白也认）：没远端也是自用仓；写在句子里的不算', () => {
    expect(kindOf(gitRepo({ 'AGENTS.md': `# x\n\n  ${lib.SELF_MARK}  \n` }, {}))).toBe('self');
    for (const old of lib.LEGACY_SELF_MARKS)
      expect(kindOf(gitRepo({ 'AGENTS.md': `# x\n${old}\n` }, {}))).toBe('self');
    expect(kindOf(gitRepo({ 'AGENTS.md': `说明里提到 ${lib.SELF_MARK} 不算\n` }, {}))).toBe('external');
  });

  it('fleet-dao 认两份文件', () => {
    expect(
      kindOf(dir({ 'agents/shared-rules.md': 'x', 'packages/conventions/standard-paths.json': '{}' })),
    ).toBe('self');
  });
});

describe('读原始远端配置：insteadOf 只改传输地址，pushurl 也算，读失败不当成没有远端', () => {
  it('原始地址在他 GitHub、传输被改写成中转：照原始地址判自用仓', () => {
    const url = 'https://github.com/thoerwink8/mine.git';
    const root = gitRepo({}, { origin: url });
    const rewritten: Git = (cwd, args) =>
      git(cwd, [
        '-c',
        'url.https://relay.fixture.invalid/.insteadOf=https://github.com/thoerwink8/',
        ...args,
      ]);
    expect(rewritten(root, ['remote', '-v']).stdout).toContain('https://relay.fixture.invalid/mine.git');
    expect(lib.repoKindInfo(root, { git: rewritten })).toMatchObject({ kind: 'self', remotes: [url] });
  });

  it('陌生原始地址被改写成他 GitHub：照原始地址判对外仓；显式非他的 pushurl：对外仓', () => {
    const stranger = 'https://unknown.fixture.invalid/repo.git';
    const root = gitRepo({}, { origin: stranger });
    const rewritten: Git = (cwd, args) =>
      git(cwd, ['-c', `url.https://github.com/thoerwink8/mine.git.insteadOf=${stranger}`, ...args]);
    expect(lib.repoKind(root, { git: rewritten })).toBe('external');
    const mixed = gitRepo({}, { origin: MINE });
    runChildOk('git', ['config', 'remote.origin.pushurl', 'git@github.com:someone/other.git'], {
      cwd: mixed,
    });
    expect(kindOf(mixed)).toBe('external');
  });

  it('【故意造出的失败】读远端配置失败、超时：source 是 unchecked，照对外仓办，不当成没有远端', () => {
    const root = gitRepo({}, { origin: MINE });
    for (const failed of [
      { status: 128, stdout: '', stderr: 'cannot read config' },
      { status: null, stdout: '', stderr: '', error: new Error('timed out') },
      { status: 0, stdout: 'garbage', stderr: '' },
    ]) {
      const broken: Git = (cwd, args) => (args.includes('--get-regexp') ? failed : git(cwd, args));
      expect(lib.repoKindInfo(root, { git: broken })).toMatchObject({
        kind: 'external',
        source: 'unchecked',
      });
    }
  });
});

describe('远端地址认法', () => {
  it('认 scp 写法、https、ssh://、github 开头的 ssh 别名；GitLab、本地路径不算 GitHub', () => {
    expect(lib.githubOwnerOf('git@github.com:thoerwink8/fleet-dao.git')).toBe('thoerwink8');
    expect(lib.githubOwnerOf('https://github.com/thoerwink8/x')).toBe('thoerwink8');
    expect(lib.githubOwnerOf('ssh://git@github.com/thoerwink8/x.git')).toBe('thoerwink8');
    expect(lib.githubOwnerOf('github-work:thoerwink8/x.git')).toBe('thoerwink8');
    expect(lib.githubOwnerOf(COMPANY)).toBeNull();
    expect(lib.githubOwnerOf('/srv/git/x.git')).toBeNull();
    expect(lib.isFounderRemote('https://github.com/THOERWINK8/a')).toBe(true);
    expect(lib.isFounderRemote('git@github.com:someone/a.git')).toBe(false);
  });
});

describe('一句话改类型：repo:kind self|external', () => {
  it('记进本机 .git/config，不碰仓里的文件；有公司远端却记成自用仓：照记，提醒后果', () => {
    const root = gitRepo({ 'AGENTS.md': '# 公司仓\n' }, { origin: COMPANY });
    const r = lib.setRepoKind(root, 'self', git);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.join('\n')).toMatch(/记下了.*自用仓/);
    expect(r.lines.join('\n')).toMatch(/能拉代码的人都看得到/);
    expect(kindOf(root)).toBe('self');
    expect(runChildOk('git', ['status', '--porcelain', '--', 'AGENTS.md'], { cwd: root })).toBe(
      '?? AGENTS.md',
    );
    const back = lib.setRepoKind(root, 'external', git);
    expect(back.ok && back.lines).toHaveLength(1);
    expect(kindOf(root)).toBe('external');
  });

  it('命令行：show 说是哪种和凭什么；self 记下；不是 git 仓退出 2', () => {
    const cli = (args: string[]) =>
      runChild(process.execPath, [LIB, ...args], { env: { ...process.env, INIT_CWD: '' } });
    const root = gitRepo({}, {});
    expect(cli(['show', root]).stdout).toMatch(/对外仓（没有远端/);
    expect(cli(['self', root]).status).toBe(0);
    expect(cli(['show', root]).stdout).toMatch(/自用仓（本机 \.git\/config/);
    expect(cli(['show', dir()]).status).toBe(2);
  });
});
