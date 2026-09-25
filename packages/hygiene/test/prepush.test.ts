// pre-push 钩子的判定：拿真 git 在临时仓里造提交，喂钩子会收到的那几行，看拦不拦、退出码对不对。不出网。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_TREE, type GitSync, parsePushedRefs, prePushCheck } from '../src/prepush.ts';
import type { LoadedValues } from '../src/values.ts';
import { pseudoRandom } from './helpers.ts';

const LIST: LoadedValues = { ok: true, source: '测试名单', values: ['fake-org-778899'] };
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', [...ID, ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const gitSync: GitSync = (args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};
const commit = (files: Record<string, string>) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  git('add', '-A', '-f');
  git('commit', '-q', '-m', 'x');
  return git('rev-parse', 'HEAD');
};
const ZERO = '0'.repeat(40);
const refLine = (oid: string, remoteOid = ZERO) => `refs/heads/task ${oid} refs/heads/task ${remoteOid}\n`;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'fleet-hygiene-prepush-'));
  git('init', '-q', '-b', 'main');
  commit({ 'README.md': 'hello\n' });
  // 装作远端主线就在这里（钩子拿 refs/remotes/<远端>/main 当起点）。
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
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

  it('干净的新提交：退出码 0；只扫相对主线新增的东西', () => {
    const head = commit({ 'docs/ok.md': '没问题\n' });
    const result = prePushCheck({
      remote: 'origin',
      refs: parsePushedRefs(refLine(head)),
      git: gitSync,
      values: LIST,
    });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(
      /^推送前卫生检查：refs\/heads\/task（[0-9a-f]{7}\.\.[0-9a-f]{7}）新增 1 行，查出 0 条$/,
    );
  });

  it('新提交里有令牌、强行加进来的密钥文件、名单里的值：退出码 1，只报文件、行、规则名', () => {
    const token = ['ghp', pseudoRandom(36, 401)].join('_');
    const head = commit({
      'docs/deploy.md': `第一行\nexport GH_TOKEN=${token}\n`,
      '.secrets/vault.pass': 'x\n',
      'docs/who.md': '用户 fake-org-778899\n',
    });
    const result = prePushCheck({
      remote: 'origin',
      refs: parsePushedRefs(refLine(head)),
      git: gitSync,
      values: LIST,
    });
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        '.secrets/vault.pass 密钥文件',
        'docs/deploy.md:2 令牌',
        'docs/who.md:1 名单里的敏感值',
      ]),
    );
    expect(result.lines.join('\n')).not.toContain(token);
    expect(result.lines.join('\n')).not.toContain('fake-org-778899');
  });

  it('名单没读到：退出码 2，不推', () => {
    const head = git('rev-parse', 'HEAD');
    const result = prePushCheck({
      remote: 'origin',
      refs: parsePushedRefs(refLine(head)),
      git: gitSync,
      values: { ok: false, reason: '已知敏感值名单没读到', tried: [] },
    });
    expect(result.code).toBe(2);
    expect(result.lines.at(-1)).toMatch(/^没扫全：已知敏感值名单没读到/);
  });

  it('删远端分支（本地提交是全 0）不扫；远端没有主线时从空树扫起', () => {
    expect(
      prePushCheck({ remote: 'origin', refs: parsePushedRefs(refLine(ZERO)), git: gitSync, values: LIST }),
    ).toEqual({
      code: 0,
      lines: [],
    });
    const head = git('rev-parse', 'HEAD');
    const result = prePushCheck({
      remote: 'nowhere',
      refs: parsePushedRefs(refLine(head)),
      git: gitSync,
      values: LIST,
    });
    expect(result.lines[0]).toContain('（空树..');
    expect(result.code).toBe(1);
    expect(EMPTY_TREE).toBe(git('hash-object', '-t', 'tree', '--stdin'));
  });
});
