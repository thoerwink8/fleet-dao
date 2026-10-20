import { describe, expect, it } from 'vitest';
import type { GhApi } from '../src/gh-api.ts';
import { gateGitHub, runMergeGate } from '../src/merge-gate.ts';

const HEAD = 'a'.repeat(40);
const RUN = 'https://github.com/o/r/actions/runs/1';
const BOT = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
const REPO = { id: 1, full_name: 'o/r', private: false };
const STATUS_URL = `https://api.github.com/repos/o/r/statuses/${HEAD}`;

function fixture() {
  const f = {
    statuses: [] as Record<string, unknown>[],
    posts: [] as Record<string, unknown>[],
    files: [] as Record<string, unknown>[],
    pr: {
      number: 80,
      head: { sha: HEAD, ref: 'feat/x', repo: REPO },
      base: { repo: REPO },
      state: 'open',
      body: '',
    },
    reads: [] as string[],
    beforeGet: (_path: string) => {},
    postError: '',
    feedback: { records: [] as { resolved: boolean; id?: string }[] },
  };
  const api: GhApi = {
    async get(path) {
      f.reads.push(path);
      f.beforeGet(path);
      if (/^\/pulls\/\d+\/files/.test(path)) return f.files;
      if (/^\/pulls\/\d+$/.test(path)) return { ...f.pr, number: Number(path.split('/').at(-1)) };
      if (path.includes('/statuses?')) {
        const page = Number(new URL(`https://x${path}`).searchParams.get('page'));
        return f.statuses.slice((page - 1) * 100, page * 100);
      }
      throw new Error(`Unexpected GET ${path}`);
    },
    async globalGet() {
      return BOT;
    },
    async getOrNull() {
      throw new Error('unused');
    },
    async post(_path, value) {
      if (f.postError) throw new Error(f.postError);
      const body = value as Record<string, unknown>;
      f.posts.push(body);
      f.statuses.unshift({ ...body, id: f.posts.length, creator: BOT, url: STATUS_URL });
    },
  };
  const gh = gateGitHub(api);
  const run = (targetUrl = RUN, number = 80) =>
    runMergeGate({
      targetPr: number,
      eventName: undefined,
      eventPath: undefined,
      gh,
      write: true,
      targetUrl,
      // 策略闭包和生产装配一样，经同一个 statuses 入口实际读取来源。
      readCiPolicy: async () => {
        await gh.statuses(HEAD);
        return 'force';
      },
      readFeedback: async () => f.feedback,
    });
  return Object.assign(f, { api, gh, run });
}

describe('merge-gate publication idempotency', () => {
  it('freshly recomputes identical results without appending another status for a new run', async () => {
    const f = fixture();
    expect((await f.run()).code).toBe(0);
    const again = await f.run('https://github.com/o/r/actions/runs/2');
    expect(again.code).toBe(0);
    expect(again.lines.join('\n')).toContain('未追加状态');
    expect(f.posts).toHaveLength(1);
    expect(f.reads.filter((p) => p.includes('/files?'))).toHaveLength(2);
  });
  it('binds full reasons beyond the 140-character display prefix', async () => {
    const f = fixture();
    f.files = [{ filename: `agents/${'x'.repeat(180)}a.md`, status: 'modified' }];
    await f.run();
    f.files = [{ filename: `agents/${'x'.repeat(180)}b.md`, status: 'modified' }];
    await f.run();
    expect(f.posts).toHaveLength(2);
    expect(f.posts[0]?.description).toBe(f.posts[1]?.description);
    expect(f.posts[0]?.target_url).not.toBe(f.posts[1]?.target_url);
  });
  it('binds PR identity even when two PRs share the same commit', async () => {
    const f = fixture();
    await f.run();
    await f.run(RUN, 81);
    expect(f.posts).toHaveLength(2);
  });
  it.each([
    'https://outside.example/o/r/actions/runs/',
    'https://github.com/else/repo/actions/runs/',
    'https://outside.example/details/',
  ])('binds changing URLs outside this repository: %s', async (prefix) => {
    const f = fixture();
    await f.run(`${prefix}1`);
    await f.run(`${prefix}2`);
    expect(f.posts).toHaveLength(2);
  });
  it('does not claim legacy or managed pending statuses with no proof', async () => {
    for (const state of ['success', 'pending']) {
      const f = fixture();
      f.statuses.push({
        context: 'merge-gate',
        state,
        description: 'legacy',
        target_url: null,
        id: 9,
        url: STATUS_URL,
        creator: BOT,
      });
      expect((await f.run()).code).toBe(0);
      expect(f.posts).toHaveLength(1);
    }
  });
  it('refuses a foreign latest writer instead of claiming its success', async () => {
    const f = fixture();
    await f.run();
    const status = f.statuses[0];
    if (!status) throw new Error('missing initial status');
    status.creator = { ...BOT, id: 999 };
    expect((await f.run()).code).toBe(2);
    expect(f.posts).toHaveLength(1);
  });
  it('reads all pages and explicitly fails when a later page cannot be read', async () => {
    const f = fixture();
    f.statuses.push(...Array.from({ length: 100 }, (_, i) => ({ context: `other-${i}` })));
    await f.run();
    expect(f.reads.some((p) => p.endsWith('page=2'))).toBe(true);
    f.beforeGet = (path) => {
      if (path.endsWith('page=2')) throw new Error('page two failed');
    };
    expect((await f.run()).code).toBe(2);
    expect(f.posts).toHaveLength(1);
  });
  it('witnesses the trusted source behind a foreign first entry and rejects mid-read changes', async () => {
    const f = fixture();
    f.statuses.push(
      { context: 'fleet-ci-policy-source/pr/80', id: 9, creator: { id: 999 } },
      { context: 'fleet-ci-policy-source/pr/80', id: 10, creator: BOT },
    );
    let reads = 0;
    f.beforeGet = (path) => {
      const source = f.statuses[1];
      if (path.includes('/statuses?') && ++reads === 2 && source) source.id = 11;
    };
    const result = await f.run();
    expect(result.code).toBe(2);
    expect(result.lines.join('\n')).toContain('请重算');
    expect(f.posts.every((p) => p.state === 'failure')).toBe(true);
  });
  it('new source identity on a later calculation requires a fresh status', async () => {
    const f = fixture();
    const source = { context: 'fleet-ci-policy-source/pr/80', id: 10, creator: BOT };
    f.statuses.push(source);
    await f.run();
    source.id = 11;
    await f.run();
    expect(f.posts).toHaveLength(2);
  });
  it('replaces latest failure instead of finding an older matching success', async () => {
    const f = fixture();
    await f.run();
    f.statuses.unshift({ ...f.statuses[0], state: 'failure', id: 999 });
    await f.run();
    expect(f.posts).toHaveLength(2);
    expect(f.posts[1]?.state).toBe('success');
  });
  it('binds feedback identity beyond its resolved count', async () => {
    const f = fixture();
    f.pr.head.ref = 'local/80-fix';
    f.feedback.records = [{ resolved: true, id: 'first' }];
    await f.run();
    f.feedback.records = [{ resolved: true, id: 'second' }];
    await f.run();
    expect(f.posts).toHaveLength(2);
  });
  it('checks head after publication reads without publishing stale success', async () => {
    const f = fixture();
    let reads = 0;
    f.beforeGet = (path) => {
      if (path.includes('/statuses?') && ++reads === 3) f.pr.head.sha = 'b'.repeat(40);
    };
    expect((await f.run()).code).toBe(2);
    expect(f.posts.every((p) => p.state === 'failure')).toBe(true);
  });
  it('does not convert legacy first-write 422 into success', async () => {
    const f = fixture();
    f.statuses.push({
      context: 'merge-gate',
      state: 'success',
      id: 9,
      url: STATUS_URL,
      description: 'legacy',
      target_url: RUN,
      creator: BOT,
    });
    f.postError = 'GitHub 回了 422';
    const result = await f.run();
    expect(result.code).toBe(2);
    expect(result.lines.join('\n')).toContain('失败状态也没写上');
    expect(f.posts).toHaveLength(0);
  });
  it.each(['id', 'url'])('rejects an unknown or mismatched status %s', async (field) => {
    const f = fixture();
    await f.run();
    const status = f.statuses[0];
    if (!status) throw new Error('missing initial status');
    status[field] = field === 'id' ? null : `https://api.github.com/repos/else/repo/statuses/${HEAD}`;
    expect((await f.run()).code).toBe(2);
    expect(f.posts).toHaveLength(1);
  });
  it('deduplicates repeated fallback failures across run IDs while preserving exit 2', async () => {
    const f = fixture();
    const post = f.api.post;
    f.api.post = async (path, body) => {
      if ((body as { state: string }).state === 'success') throw new Error('HTTP 422');
      await post(path, body);
    };
    expect((await f.run()).code).toBe(2);
    expect((await f.run('https://github.com/o/r/actions/runs/2')).code).toBe(2);
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]?.state).toBe('failure');
  });
});
