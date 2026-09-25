// pre-push 钩子的判定：拿真 git 在临时仓里造提交，喂钩子会收到的那几行，看拦不拦、退出码对不对。不出网。
// 每个用例从「远端主线」上另起一段（分离头），互不串：钩子只扫远端还没有的提交。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GitSync, type PrePushInput, parsePushedRefs, prePushCheck } from '../src/prepush.ts';
import type { LoadedValues } from '../src/values.ts';
import { pseudoRandom } from './helpers.ts';

const LIST: LoadedValues = { ok: true, source: '测试名单', values: ['fake-org-778899'] };
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
let repo: string;
let base: string;
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
/** 写文件（null = 删掉）、提交，返回新提交号。 */
const commit = (files: Record<string, string | null>, message = 'x', ident: string[] = []) => {
  for (const [name, text] of Object.entries(files)) {
    if (text === null) rmSync(join(repo, name));
    else {
      mkdirSync(join(repo, name, '..'), { recursive: true });
      writeFileSync(join(repo, name), text);
    }
  }
  git('add', '-A', '-f');
  git(...ident, 'commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
};
/** 从远端主线另起一段。 */
const fresh = () => git('checkout', '-q', '--detach', base);
const ZERO = '0'.repeat(40);
const refLine = (oid: string, remoteOid = ZERO) => `refs/heads/task ${oid} refs/heads/task ${remoteOid}\n`;
const check = (head: string, over: Partial<PrePushInput> = {}) =>
  prePushCheck({
    remote: 'origin',
    refs: parsePushedRefs(refLine(head)),
    git: gitSync,
    values: LIST,
    ...over,
  });
const short = (oid: string) => oid.slice(0, 7);

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'fleet-hygiene-prepush-'));
  git('init', '-q', '-b', 'main');
  base = commit({ 'README.md': 'hello\n' });
  // 装作远端主线就在这里：钩子只扫 refs/remotes/<远端>/* 上没有的提交。
  git('update-ref', 'refs/remotes/origin/main', base);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('prePushCheck', { timeout: 30_000 }, () => {
  it('解析钩子的标准输入：四段一行', () => {
    expect(parsePushedRefs(`${refLine('a'.repeat(40))}\n`)).toEqual([
      {
        localRef: 'refs/heads/task',
        localOid: 'a'.repeat(40),
        remoteRef: 'refs/heads/task',
        remoteOid: ZERO,
      },
    ]);
  });

  it('干净的新提交：退出码 0；只扫远端还没有的提交', () => {
    fresh();
    const head = commit({ 'docs/ok.md': '没问题\n' });
    const result = check(head);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      '推送前卫生检查：refs/heads/task 有 1 个提交远端还没有，逐个看了新增的 1 行、文件名、提交说明和作者，查出 0 条',
    ]);
  });

  it('新提交里有令牌、强行加进来的密钥文件、名单里的值：退出码 1，只报文件、行、规则名和提交号', () => {
    fresh();
    const token = ['ghp', pseudoRandom(36, 401)].join('_');
    const head = commit({
      'docs/deploy.md': `第一行\nexport GH_TOKEN=${token}\n`,
      '.secrets/vault.pass': 'x\n',
      'docs/who.md': '用户 fake-org-778899\n',
    });
    const result = check(head);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        `.secrets/vault.pass 密钥文件（提交 ${short(head)}）`,
        `docs/deploy.md:2 令牌（提交 ${short(head)}）`,
        `docs/who.md:1 名单里的敏感值（提交 ${short(head)}）`,
      ]),
    );
    expect(result.lines.join('\n')).not.toContain(token);
    expect(result.lines.join('\n')).not.toContain('fake-org-778899');
  });

  it('先加后删：最后的样子干净，中间那个提交照样会推上去，照样拦，报出是哪个提交', () => {
    fresh();
    const token = ['ghp', pseudoRandom(36, 402)].join('_');
    const added = commit({
      'docs/deploy.md': `export GH_TOKEN=${token}\n`,
      '.secrets/vault.pass': 'x\n',
      'docs/who.md': '用户 fake-org-778899\n',
    });
    const head = commit({ 'docs/deploy.md': null, '.secrets/vault.pass': null, 'docs/who.md': null });
    // 总差异里什么都没有：只看总差异的闸会放过去。
    expect(git('diff', '--stat', base, head)).toBe('');
    const result = check(head);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain('有 2 个提交远端还没有');
    // 全出在加进来的那个提交上；删掉它们的提交本身不算问题。
    const findings = result.lines.filter((l) => l.includes('（提交 '));
    expect(findings.length).toBeGreaterThanOrEqual(3);
    expect(findings.filter((l) => !l.endsWith(`（提交 ${short(added)}）`))).toEqual([]);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        `.secrets/vault.pass 密钥文件（提交 ${short(added)}）`,
        `docs/deploy.md:1 令牌（提交 ${short(added)}）`,
        `docs/who.md:1 名单里的敏感值（提交 ${short(added)}）`,
      ]),
    );
    expect(result.lines.join('\n')).toContain('只在后面补一个删掉它的提交不算');
    expect(result.lines.join('\n')).not.toContain(token);
  });

  it('提交说明、作者邮箱也会推上去：名单里的值、令牌、真邮箱都拦', () => {
    fresh();
    const token = ['ghp', pseudoRandom(36, 403)].join('_');
    const email = [pseudoRandom(8, 404, 'abcdefghijklmnopqrstuvwxyz'), 'mail.co'].join('@');
    const head = commit({ 'docs/ok.md': '没问题\n' }, `改文档\n\n顺手切到 fake-org-778899\n令牌 ${token}`, [
      '-c',
      `user.email=${email}`,
    ]);
    const result = check(head);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        `提交说明:3 名单里的敏感值（提交 ${short(head)}）`,
        `提交说明:4 令牌（提交 ${short(head)}）`,
        `提交作者 邮箱（提交 ${short(head)}）`,
        `提交者 邮箱（提交 ${short(head)}）`,
      ]),
    );
    expect(result.lines.join('\n')).not.toContain(email);
    expect(result.lines.join('\n')).not.toContain(token);
  });

  it('合并提交只看它自己改的：解冲突时新写进去的要拦；合进来的、远端早就有的旧东西不重复报', () => {
    // 远端另一条分支上早有一处（已经公开了，这次推不推都在那儿）。
    fresh();
    const old = commit({ 'docs/old.md': '用户 fake-org-778899\n' });
    git('update-ref', 'refs/remotes/origin/legacy', old);
    fresh();
    const side = commit({ 'docs/a.md': 'side\n' });
    fresh();
    commit({ 'docs/a.md': 'mine\n' });
    spawnSync('git', [...ID, 'merge', '-q', '--no-edit', side], { cwd: repo });
    writeFileSync(join(repo, 'docs/a.md'), 'mine\n用户 fake-org-778899\n');
    const merged = commit({}, '合并 side');
    git(...['merge', '-q', '--no-edit', old]);
    const head = git('rev-parse', 'HEAD');
    const result = check(head);
    expect(result.code).toBe(1);
    expect(result.lines.filter((l) => l.includes('名单里的敏感值'))).toEqual([
      `docs/a.md:2 名单里的敏感值（提交 ${short(merged)}）`,
    ]);
  });

  it('远端分支现在的头本地有：它和它之前的提交远端都有了，不再扫', () => {
    fresh();
    const pushedBefore = commit({ 'docs/who.md': '用户 fake-org-778899\n' });
    const head = commit({ 'docs/ok.md': '没问题\n' });
    const result = check(head, { refs: parsePushedRefs(refLine(head, pushedBefore)) });
    expect(result).toMatchObject({ code: 0 });
    expect(result.lines[0]).toContain('有 1 个提交远端还没有');
    // 远端的头本地没有（没 fetch 过）：排除不了，照样扫，不因为它不在就出错。
    const unknown = check(head, { refs: parsePushedRefs(refLine(head, 'f'.repeat(40))) });
    expect(unknown.code).toBe(1);
  });

  it('名单没读到：退出码 2，不推', () => {
    fresh();
    const result = check(commit({ 'docs/ok.md': '没问题\n' }), {
      values: { ok: false, reason: '已知敏感值名单没读到', tried: [] },
    });
    expect(result.code).toBe(2);
    expect(result.lines.at(-1)).toMatch(/^没扫全：已知敏感值名单没读到/);
  });

  it('git 出错、输出认不出：退出码 2，不当成扫过没事', () => {
    fresh();
    const head = commit({ 'docs/ok.md': '没问题\n' });
    const failing: GitSync = (args) =>
      args.includes('log') ? { code: 128, stdout: '', stderr: 'fatal: 故意出错' } : gitSync(args);
    const broken = check(head, { git: failing });
    expect(broken.code).toBe(2);
    expect(broken.lines[0]).toContain('没扫成');
    const garbage: GitSync = (args) =>
      args.includes('-p')
        ? { code: 0, stdout: 'diff --git a/x b/x\n+++ b/x\n@@ -0,0 +1 @@\n+x\n', stderr: '' }
        : gitSync(args);
    const unparsed = check(head, { git: garbage });
    expect(unparsed.code).toBe(2);
    expect(unparsed.lines[0]).toContain('认不出');
    // git log 什么都没吐：要推的头不在扫过的提交里、远端又没有它，也是没扫成。
    const silent: GitSync = (args) =>
      args.includes('log') ? { code: 0, stdout: '', stderr: '' } : gitSync(args);
    const unscanned = check(head, { git: silent });
    expect(unscanned.code).toBe(2);
    expect(unscanned.lines[0]).toContain('不在扫过的提交里');
  });

  it('要推的提交远端早就有了（换个分支名再推一次）：没有新提交，照样放行', () => {
    const result = check(base);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain('有 0 个提交远端还没有');
  });

  it('删远端分支（本地提交是全 0）不扫；本地没记着这个远端的任何分支时，整段历史都扫', () => {
    expect(check(ZERO)).toEqual({ code: 0, lines: [] });
    fresh();
    const head = commit({ 'docs/ok.md': '没问题\n' });
    const result = check(head, { remote: 'nowhere' });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(
      /有 2 个提交远端还没有.*（本地没记着 nowhere 的任何分支，整段历史都扫了）$/,
    );
  });
});
