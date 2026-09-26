// ciHistoryCheck：CI 上按提交扫一段历史（PR 的 base..head、分支上 main 还没有的部分）。scanHistory 本身（先加后删、
// 合并提交、二进制……）已经在 history.test.ts、prepush.test.ts 覆盖过，这里只测这个函数自己多出来的部分：
// base/head 自己解析（分支名、SHA 都行）、解析不出就是没扫成、不把像参数的版本号递给 git。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ciHistoryCheck } from '../src/ci-history.ts';
import type { GitSync } from '../src/prepush.ts';
import type { LoadedValues } from '../src/values.ts';
import { pseudoRandom } from './helpers.ts';

const LIST: LoadedValues = { ok: true, source: '测试名单', values: ['fake-org-778899'] };
const NO_LIST: LoadedValues = { ok: false, reason: '已知敏感值名单没读到（找过：/nope）', tried: ['/nope'] };
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', [...ID, '-c', 'core.autocrlf=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const gitSync: GitSync = (args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};
const commit = (files: Record<string, string | null>, message = 'x') => {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) rmSync(join(repo, name));
    else {
      mkdirSync(join(repo, name, '..'), { recursive: true });
      writeFileSync(join(repo, name), content);
    }
  }
  git('add', '-A', '-f');
  git('commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
};
const check = (base: string, head: string, values: LoadedValues = LIST) =>
  ciHistoryCheck({ git: gitSync, base, head, values });
const short = (oid: string) => oid.slice(0, 7);

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'fleet-hygiene-ci-history-'));
  git('init', '-q', '-b', 'main');
  commit({ 'README.md': 'hello\n' }, '起点');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('ciHistoryCheck', () => {
  it('干净：退出码 0，base/head 收分支名也行', () => {
    const head = commit({ 'docs/a.md': '没问题\n' });
    const result = check('HEAD~1', head);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain('有 1 个提交');
  });

  it('提交说明里有名单上的值：退出码 1，不打值', () => {
    const base = git('rev-parse', 'HEAD');
    const head = commit({ 'docs/b.md': '没问题\n' }, '改文档\n\n顺手切到 fake-org-778899');
    const result = check(base, head);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([`提交说明:3 名单里的敏感值（提交 ${short(head)}）`]),
    );
    expect(result.lines.join('\n')).not.toContain('fake-org-778899');
  });

  it('先加后删：最后的样子干净，中间那个提交照样拦（令牌、名单里的值都算），报出是哪个提交', () => {
    const base = git('rev-parse', 'HEAD');
    const token = ['ghp', pseudoRandom(36, 501)].join('_');
    const added = commit({
      'docs/c.md': `export GH_TOKEN=${token}\n`,
      'docs/c2.md': '用户 fake-org-778899\n',
    });
    const head = commit({ 'docs/c.md': null, 'docs/c2.md': null });
    expect(git('diff', '--stat', base, head)).toBe('');
    const result = check(base, head);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        `docs/c.md:1 令牌（提交 ${short(added)}）`,
        `docs/c2.md:1 名单里的敏感值（提交 ${short(added)}）`,
      ]),
    );
    expect(result.lines.join('\n')).not.toContain(token);
    expect(result.lines.join('\n')).not.toContain('fake-org-778899');
  });

  it('名单没读到：退出码 2（不靠名单的规则，比如令牌，照样查出来、照样列出来）', () => {
    const base = git('rev-parse', 'HEAD');
    const token = ['ghp', pseudoRandom(36, 502)].join('_');
    const head = commit({ 'docs/d.md': `export GH_TOKEN=${token}\n` });
    const result = check(base, head, NO_LIST);
    expect(result.code).toBe(2);
    expect(result.lines.at(-1)).toMatch(/^没扫全：/);
    expect(result.lines.join('\n')).toContain(`docs/d.md:1 令牌（提交 ${short(head)}）`);
    expect(result.lines.join('\n')).not.toContain(token);
  });

  it('base/head 解析不出（分支不存在、空字符串）：退出码 2，不当成没有提交', () => {
    const head = git('rev-parse', 'HEAD');
    expect(check('这个分支不存在-xyz', head).code).toBe(2);
    expect(check(head, '').code).toBe(2);
    expect(check('这个分支不存在-xyz', head).lines[0]).toContain('解析不出');
  });

  it('base/head 像参数（以 - 开头）：不当版本号递给 git（不然会被当成 git 的选项），直接判没扫成', () => {
    const head = git('rev-parse', 'HEAD');
    const calls: string[][] = [];
    const spy: GitSync = (args) => {
      calls.push(args);
      return gitSync(args);
    };
    const result = ciHistoryCheck({ git: spy, base: '--upload-pack=x', head, values: LIST });
    expect(result.code).toBe(2);
    // head 的解析照样走（合法版本号），但 base 那个像参数的字符串一次都没被递给 git。
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((a) => a.some((x) => x.includes('--upload-pack=x')))).toBe(false);
  });

  it('git 出错、输出认不出：退出码 2，不当成扫过没事', () => {
    const head = commit({ 'docs/e.md': '没问题\n' });
    const failing: GitSync = (args) =>
      args.includes('log') ? { code: 128, stdout: '', stderr: 'fatal: 故意出错' } : gitSync(args);
    const result = ciHistoryCheck({ git: failing, base: 'HEAD~1', head, values: LIST });
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain('没扫成');
  });

  it('base 就是 head：没有新提交，退出码 0', () => {
    const head = git('rev-parse', 'HEAD');
    const result = check(head, head);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain('有 0 个提交');
  });

  it('head 是 base 的祖先（分支还指着主线上的旧提交、没有新提交）：范围是空的，退出码 0，不判没扫成', () => {
    const head = git('rev-parse', 'HEAD');
    const base = commit({ 'docs/f.md': '主线往前走了\n' });
    const result = check(base, head);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain('有 0 个提交');
  });

  it('git log 什么都没吐、范围里其实有提交：退出码 2，不当成扫过没事', () => {
    const base = git('rev-parse', 'HEAD');
    const head = commit({ 'docs/g.md': '没问题\n' });
    const silent: GitSync = (args) =>
      args.includes('log') ? { code: 0, stdout: '', stderr: '' } : gitSync(args);
    const result = ciHistoryCheck({ git: silent, base, head, values: LIST });
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain(`${short(head)} 不在扫过的提交里`);
  });
});

// 真跑一遍命令行入口（不止测判定函数）：参数怎么解析、名单从哪读、退出码怎么落到进程上，和 ci-plan.test.ts 的
// 「入口」一节同一个套路。名单指到临时文件，不读这台机器上真的名单（不然结果随机器而变，必过检查必须确定）。
describe('入口（bin/ci-history.ts）', () => {
  const bin = fileURLToPath(new URL('../src/bin/ci-history.ts', import.meta.url));
  let scratch: string;
  const run = (args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, FLEET_SENSITIVE_VALUES_FILE: join(scratch, 'list.txt') },
    });

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'fleet-hygiene-ci-history-bin-'));
    writeFileSync(join(scratch, 'list.txt'), 'fake-org-778899\n');
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('缺 --base 或 --head：退出码 2', () => {
    expect(run(['--base', 'HEAD']).status).toBe(2);
    expect(run([]).status).toBe(2);
  });

  it('参数不对（没这个选项）：退出码 2', () => {
    expect(run(['--nope', 'x']).status).toBe(2);
  });

  it('真跑：干净的范围退出码 0', () => {
    const head = git('rev-parse', 'HEAD');
    const r = run(['--base', head, '--head', head]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('有 0 个提交');
  });

  it('真跑：范围里有名单上的值，退出码 1，标准错误里报出来但不打值', () => {
    const base = git('rev-parse', 'HEAD');
    const head = commit({ 'docs/bin.md': '用户 fake-org-778899\n' });
    const r = run(['--base', base, '--head', head]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('名单里的敏感值');
    expect(r.stderr).not.toContain('fake-org-778899');
  });
});
