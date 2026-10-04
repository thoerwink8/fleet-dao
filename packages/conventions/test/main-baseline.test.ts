// 主线「上一次真绿的头」（src/main-baseline.ts）和它的入口（bin/main-base.ts）。
// 查不到、查不成都得退到全跑，绝不拿空当「上次绿就是这次」。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GhApi } from '../src/gh-api.ts';
import { GREEN_LOOKBACK, lastGreenMainSha } from '../src/main-baseline.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

type Run = { head_sha?: unknown; head_branch?: unknown; event?: unknown; conclusion?: unknown };
const run = (over: Run = {}): Run => ({
  head_sha: SHA_A,
  head_branch: 'main',
  event: 'push',
  conclusion: 'success',
  ...over,
});
const api = (body: unknown, seen: string[] = []): GhApi => ({
  get: async (p) => {
    seen.push(p);
    return body;
  },
  getOrNull: async () => null,
  post: async () => {},
});

describe('lastGreenMainSha', () => {
  it('取最近一次绿的（接口按新到旧给），请求只要 push、成功、本分支', async () => {
    const seen: string[] = [];
    const sha = await lastGreenMainSha(
      api({ workflow_runs: [run({ head_sha: SHA_B }), run()] }, seen),
      'ci.yml',
      'main',
    );
    expect(sha).toBe(SHA_B);
    expect(seen[0]).toBe(
      `/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=${GREEN_LOOKBACK}`,
    );
  });

  it('接口不管过滤说什么，自己再核一遍：被取消的、PR 的、别的分支的、提交号不像 40 位十六进制的都不算', async () => {
    const sha = await lastGreenMainSha(
      api({
        workflow_runs: [
          run({ conclusion: 'cancelled', head_sha: SHA_B }),
          run({ event: 'pull_request', head_sha: SHA_B }),
          run({ head_branch: 'feature', head_sha: SHA_B }),
          run({ head_sha: 'HEAD' }),
          run({ head_sha: 123 }),
          run({ head_sha: SHA_A }),
        ],
      }),
      'ci.yml',
      'main',
    );
    expect(sha).toBe(SHA_A);
  });

  it('【故意造出的失败】一次绿的都没有（空、缺字段）：回 null，让调用方全跑，不是空串也不是 HEAD', async () => {
    expect(await lastGreenMainSha(api({ workflow_runs: [] }), 'ci.yml', 'main')).toBeNull();
    expect(await lastGreenMainSha(api({}), 'ci.yml', 'main')).toBeNull();
    expect(
      await lastGreenMainSha(api({ workflow_runs: [run({ conclusion: 'failure' })] }), 'ci.yml', 'main'),
    ).toBeNull();
  });

  it('【故意造出的失败】接口读不成：抛出去，不吞成 null', async () => {
    const broken: GhApi = {
      get: async () => {
        throw new Error('GitHub 回了 500（GET /actions/workflows/ci.yml/runs）');
      },
      getOrNull: async () => null,
      post: async () => {},
    };
    await expect(lastGreenMainSha(broken, 'ci.yml', 'main')).rejects.toThrow('500');
  });
});

describe('入口 main-base.ts', () => {
  const bin = fileURLToPath(new URL('../src/bin/main-base.ts', import.meta.url));
  const go = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: '', GITHUB_REPOSITORY: '', ...env },
    });

  it('【故意造出的失败】没令牌：标准输出是空（调用方据此全跑），错误里有 ::warning::，退出 0', () => {
    const r = go(['ci.yml', 'main']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toContain('::warning::');
    expect(r.stderr).toContain('退回全跑');
  });

  it('参数不对（缺分支、像命令行参数）：退出 2', () => {
    expect(go(['ci.yml']).status).toBe(2);
    expect(go(['ci.yml', '--output=x']).status).toBe(2);
  });
});
