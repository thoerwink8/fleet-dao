import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GhApi } from '../src/gh-api.ts';
import type { Gh } from '../src/issue-new.ts';
import {
  FEEDBACK_MARKER,
  type FeedbackEvent,
  type FeedbackReview,
  feedbackBody,
  feedbackDigest,
  feedbackRecords,
  PREPARE_MARKER,
  prepareBody,
} from '../src/managed-feedback.ts';
import { readManagedFeedbackForGate, transactFeedback } from '../src/managed-feedback-github.ts';
import { managedCloseGate, managedWork, validateManagedDelivery } from '../src/managed-work.ts';
import { gateGitHub, gatePr } from '../src/merge-gate.ts';
import { type RunSpec, runDir, runFiles, writeJson } from '../src/work-run.ts';

const HEAD = 'a'.repeat(40),
  NEXT = 'b'.repeat(40);
const base: FeedbackEvent = {
  v: 1,
  action: 'return',
  repoId: 1,
  repo: 'owner/repo',
  issue: 12,
  pr: 34,
  run: 'run1',
  session: 'session1',
  requestId: 'request1',
  returnId: 'return1',
  generation: 1,
  head: HEAD,
  text: '必须修复真实数据',
  digest: feedbackDigest('必须修复真实数据'),
  dispatcherId: 2,
};
function review(e: FeedbackEvent, id = 1): FeedbackReview {
  return { id, user: { id: 3, type: 'Bot' }, state: 'COMMENTED', commit_id: e.head, body: feedbackBody(e) };
}
function fake() {
  const reviews: FeedbackReview[] = [],
    statuses: Record<string, unknown>[] = [],
    writes: string[] = [];
  const live = {
    number: 34,
    head: { sha: HEAD, ref: 'local/12-fix' },
    base: { repo: { id: 1 } },
    state: 'open',
    merged: false,
    body: '',
  };
  let dropReview = false,
    loseReceipt = false,
    badReviewPage = false;
  const api: GhApi = {
    async get(path) {
      if (path === '') return { id: 1, full_name: 'owner/repo', owner: { id: 2, type: 'User' } };
      if (path === '/pulls/34') return structuredClone(live);
      if (path.startsWith('/pulls/34/reviews?')) {
        if (badReviewPage) throw new Error('review网络断开');
        return structuredClone(reviews);
      }
      if (path.startsWith('/pulls/34/files?')) return [];
      if (path.startsWith('/commits/')) return structuredClone(statuses);
      throw new Error(`unexpected ${path}`);
    },
    async globalGet() {
      return { id: 3, type: 'Bot', login: 'github-actions[bot]' };
    },
    getOrNull: async () => {
      throw new Error('not used');
    },
    async post(path, value) {
      const body = value as Record<string, unknown>;
      writes.push(path);
      if (path.startsWith('/statuses/')) {
        statuses.unshift({ ...body, creator: { id: 3 } });
        return;
      }
      if (path === '/pulls/34/reviews') {
        if (body.event === 'REQUEST_CHANGES') throw new Error('422 owner不能正式CR');
        if (String(body.body).startsWith(FEEDBACK_MARKER)) {
          if (dropReview) throw new Error('review写入网络断开');
          expect(statuses[0]?.state).toBe('pending');
        }
        reviews.push({
          id: reviews.length + 1,
          user: { id: 3, type: 'Bot' },
          state: 'COMMENTED',
          commit_id: String(body.commit_id),
          body: String(body.body),
        });
        if (loseReceipt) throw new Error('201后丢响应');
        return;
      }
      throw new Error(`unexpected POST ${path}`);
    },
  };
  return {
    api,
    reviews,
    statuses,
    writes,
    live,
    setDrop: () => {
      dropReview = true;
    },
    restoreReview: () => {
      dropReview = false;
    },
    setLose: () => {
      loseReceipt = true;
    },
    setBroken: () => {
      badReviewPage = true;
    },
  };
}
const reduce = (events: FeedbackEvent[], head = HEAD) =>
  feedbackRecords(
    events.map((e, i) => review(e, i + 1)),
    { repoId: 1, repo: 'owner/repo', pr: 34 },
    3,
    2,
    head,
  );
describe('本机退回：真实协议、GitHub回执和既有合并闸装配', () => {
  it('ack只确认收到；显式resolve在精确候选头才解除', () => {
    const ack = { ...base, action: 'ack' as const, requestId: 'ack1' };
    const resolve = {
      ...base,
      action: 'resolve' as const,
      requestId: 'resolve1',
      head: NEXT,
      text: '已独立验证',
    };
    expect(reduce([base, ack])[0]).toMatchObject({ ack: true, resolved: false });
    expect(reduce([base, ack, resolve], NEXT)[0]?.resolved).toBe(true);
    expect(reduce([base, ack, resolve], HEAD)[0]?.resolved).toBe(false);
    expect(() => reduce([base, resolve], NEXT)).toThrow('未确认');
  });
  it.each(['session', 'run', 'digest', 'generation'] as const)('旧%s不能消费或解决', (key) => {
    const ack = {
      ...base,
      action: 'ack' as const,
      requestId: 'ack1',
      [key]: key === 'generation' ? 2 : 'wrong',
    };
    expect(() => reduce([base, ack])).toThrow();
  });
  it('回执丢失按requestId找回；重试不重复发表且重新核真实阻合', async () => {
    const f = fake();
    f.setLose();
    expect(await transactFeedback(f.api, 34, base, 2)).toMatchObject({ state: 'registered', reviewId: 2 });
    f.statuses.unshift({ context: 'merge-gate', state: 'success', creator: { id: 3 } });
    expect(await transactFeedback(f.api, 34, base, 2)).toMatchObject({ state: 'registered', reviewId: 2 });
    expect(f.reviews.filter((r) => r.body.startsWith(FEEDBACK_MARKER))).toHaveLength(1);
    expect(f.statuses[0]?.state).toBe('pending');
    expect(f.writes[0]).toBe('/pulls/34/reviews');
    expect(f.reviews[0]?.body.startsWith(PREPARE_MARKER)).toBe(true);
  });
  it('同PR串行写者：旧writer已计算绿但延后写；退回随后拿锁且最终仍红', async () => {
    const f = fake();
    let tail = Promise.resolve();
    const serial = (fn: () => Promise<void>) => {
      const result = tail.then(fn);
      tail = result;
      return result;
    };
    const gh = gateGitHub(f.api);
    const deps = {
      gh,
      standardPaths: async () => [],
      readFeedback: (pr: number, head: string) => readManagedFeedbackForGate(f.api, pr, head),
    };
    let release: () => void = () => {};
    const paused = new Promise<void>((r) => {
      release = r;
    });
    const old = serial(async () => {
      const r = await gatePr(34, deps);
      expect(r.state).toBe('success');
      await paused;
      await gh.writeStatus(HEAD, { state: r.state, description: 'old' });
    });
    const returned = serial(async () => {
      await transactFeedback(f.api, 34, base, 2);
      const r = await gatePr(34, deps);
      await gh.writeStatus(HEAD, { state: r.state, description: 'return' });
    });
    release();
    await Promise.all([old, returned]);
    expect(f.statuses[0]?.state).toBe('failure');
    // 后续同头CI绿/重算仍不能解除；这次跑真实gatePr而非mock blocked。
    expect((await gatePr(34, deps)).state).toBe('failure');
    await transactFeedback(f.api, 34, { ...base, action: 'ack', requestId: 'ack1' }, 2);
    expect((await gatePr(34, deps)).state).toBe('failure');
    f.live.head.sha = NEXT;
    await transactFeedback(
      f.api,
      34,
      { ...base, action: 'resolve', requestId: 'resolve1', head: NEXT, text: '修复已核实' },
      2,
    );
    expect((await gatePr(34, deps)).state).toBe('success');
  });
  it('先合并明确late，不补造阻止成功', async () => {
    const f = fake();
    f.live.merged = true;
    expect(await transactFeedback(f.api, 34, base, 2)).toMatchObject({ state: 'late' });
    expect(f.writes).toEqual([]);
  });
  it('真实sender不符即拒绝，payload自报owner无效', async () => {
    const f = fake();
    await expect(transactFeedback(f.api, 34, base, 999)).rejects.toThrow('授权');
    expect(f.writes).toEqual([]);
  });
  it('分页读取失败不是空责任', async () => {
    const f = fake();
    f.setBroken();
    await expect(readManagedFeedbackForGate(f.api, 34, HEAD)).rejects.toThrow('网络');
  });
  it('普通local/org无Bot协议不读owner；陌生普通评论不创建责任', async () => {
    const f = fake();
    f.reviews.push({ ...review(base), user: { id: 999, type: 'User' } });
    const api = {
      ...f.api,
      get: async (path: string) => {
        if (path === '') throw new Error('org owner不适用');
        return f.api.get(path);
      },
    };
    expect(await readManagedFeedbackForGate(api, 34, HEAD)).toEqual({ records: [] });
  });
});

function clientWorld() {
  const f = fake();
  const root = mkdtempSync(join(tmpdir(), 'feedback-client-'));
  const dir = runDir(root, base.repo, base.issue);
  mkdirSync(dir, { recursive: true });
  const spec = { repo: base.repo, issue: base.issue, branch: 'local/12-fix', createdAt: base.run } as RunSpec;
  writeJson(runFiles(dir).spec, spec);
  writeJson(runFiles(dir).state, { sessionId: base.session });
  const body = join(root, 'opinion.md');
  writeFileSync(body, base.text);
  const env = { FLEET_WORK_RUNS_DIR: root };
  const output: string[] = [];
  let queued: FeedbackEvent | null = null;
  let hidden = false,
    cancelled = false;
  const merges: string[][] = [];
  const gh: Gh = async (args) => {
    if (args[0] === 'pr' && args[1] === 'list')
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify([
          {
            number: 34,
            headRefOid: f.live.head.sha,
            state: f.live.merged ? 'MERGED' : 'OPEN',
            mergedAt: f.live.merged ? '2026-10-19T00:00:00Z' : null,
            isDraft: false,
          },
        ]),
      };
    if (args[0] === 'pr' && args[1] === 'merge') {
      merges.push(args);
      return { code: 0, stdout: 'armed', stderr: '' };
    }
    if (args[0] === 'issue') return { code: 0, stdout: JSON.stringify({ state: 'CLOSED' }), stderr: '' };
    if (args[0] === 'run' && args[1] === 'list')
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify(
          hidden ? [] : [{ databaseId: 56, displayTitle: `managed-feedback ${queued?.requestId}` }],
        ),
      };
    if (args[0] === 'run' && args[1] === 'watch') {
      if (cancelled) return { code: 1, stdout: 'cancelled', stderr: '' };
      if (!queued) throw new Error('no queued request');
      await transactFeedback(f.api, 34, queued, 2);
      const result = await gatePr(34, {
        gh: gateGitHub(f.api),
        standardPaths: async () => [],
        readFeedback: (pr, head) => readManagedFeedbackForGate(f.api, pr, head),
      });
      await gateGitHub(f.api).writeStatus(f.live.head.sha, { state: result.state, description: 'test gate' });
      return { code: 0, stdout: 'completed', stderr: '' };
    }
    if (args[0] === 'api') {
      if (args[1] === '/user')
        return { code: 0, stdout: JSON.stringify({ id: 2, type: 'User' }), stderr: '' };
      const method = args[args.indexOf('--method') + 1];
      const raw = args[args.indexOf('--method') + 2];
      const path = raw?.replace('/repos/owner/repo', '') ?? '';
      if (method === 'POST') {
        const payload = JSON.parse(readFileSync(args[args.indexOf('--input') + 1] ?? '', 'utf8'));
        if (path.includes('/dispatches')) queued = JSON.parse(payload.inputs.feedback);
        else await f.api.post(path, payload);
        return { code: 0, stdout: '', stderr: '' };
      }
      const value = raw?.startsWith('/users/') ? await f.api.globalGet?.(raw) : await f.api.get(path);
      return { code: 0, stdout: JSON.stringify(value), stderr: '' };
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return {
    ...f,
    root,
    dir,
    spec,
    body,
    env,
    gh,
    output,
    merges,
    hide: () => {
      hidden = true;
    },
    cancel: () => {
      cancelled = true;
    },
    recover: () => {
      cancelled = false;
    },
    o: { gh, repo: base.repo, env, out: (s: string) => output.push(s) },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
describe('work真实客户端交付与未知回执持久化', () => {
  it('正常return→工人精确消费→审查方resolve→受管squash→真实合并才结束', async () => {
    const f = clientWorld();
    try {
      expect(await managedWork('return', ['12', '--body-file', f.body], f.o)).toBe(0);
      expect(f.output.join('\n')).toContain('registered/blocked');
      const event = JSON.parse(
        f.reviews
          .find((r) => r.body.startsWith(FEEDBACK_MARKER))
          ?.body.slice('<!-- fleet-managed-feedback:v1 -->'.length) ?? '',
      ) as FeedbackEvent;
      await expect(managedWork('deliver', ['12'], f.o)).rejects.toThrow('未解决');
      expect(f.merges).toHaveLength(0);
      await expect(managedWork('ack', ['12', '--return', event.returnId], f.o)).rejects.toThrow(
        'run/session',
      );
      const consumer = {
        ...f.o,
        env: { ...f.env, FLEET_WORKER: '1', FLEET_WORK_RUN: base.run, FLEET_WORK_SESSION: base.session },
      };
      expect(await managedWork('ack', ['12', '--return', event.returnId], consumer)).toBe(0);
      await expect(managedWork('deliver', ['12'], f.o)).rejects.toThrow('未解决');
      await expect(
        managedWork('resolve', ['12', '--return', event.returnId, '--body-file', f.body], consumer),
      ).rejects.toThrow('审查方');
      expect(
        await managedWork('resolve', ['12', '--return', event.returnId, '--body-file', f.body], f.o),
      ).toBe(0);
      expect(await managedWork('deliver', ['12'], f.o)).toBe(0);
      expect(f.merges[0]).toContain('--squash');
      expect(f.merges[0]).toContain(HEAD);
      await expect(validateManagedDelivery(f.gh, f.spec, true, f.root)).rejects.toMatchObject({
        kind: 'review',
        message: expect.stringContaining('尚未真实合并'),
      });
      f.live.merged = true;
      await expect(validateManagedDelivery(f.gh, f.spec, true, f.root)).resolves.toBeUndefined();
    } finally {
      f.close();
    }
  });
  it('排队未有Actions回执不叫blocked；恢复/again/done不能清意图', async () => {
    const f = clientWorld();
    try {
      f.hide();
      expect(await managedWork('return', ['12', '--body-file', f.body], f.o)).toBe(2);
      expect(f.output.join('\n')).not.toContain('registered/blocked');
      await expect(managedWork('deliver', ['12'], f.o)).rejects.toThrow('事务仍未确认');
      await expect(validateManagedDelivery(f.gh, f.spec, false, f.root)).rejects.toThrow('回执未核实');
      await expect(managedWork('return', ['12', '--body-file', f.body], f.o)).rejects.toThrow('旧事务');
      expect(readFileSync(join(f.dir, 'feedback-intent.json'), 'utf8')).toContain('requestId');
    } finally {
      f.close();
    }
  });
  it('取消不丢持久意图；同一requestId可重试找回', async () => {
    const f = clientWorld();
    try {
      f.cancel();
      await expect(managedWork('return', ['12', '--body-file', f.body], f.o)).rejects.toThrow('取消');
      expect(f.reviews).toHaveLength(0);
      expect(readFileSync(join(f.dir, 'feedback-intent.json'), 'utf8')).toContain('requestId');
    } finally {
      f.close();
    }
  });
});

it('prepare已写但review未登记：普通重算保留未知责任，不能清绿', async () => {
  const f = fake();
  f.setDrop();
  await expect(transactFeedback(f.api, 34, base, 2)).rejects.toThrow('回执未核实');
  const gh = gateGitHub(f.api);
  const deps = {
    gh,
    standardPaths: async () => [],
    readFeedback: (pr: number, head: string) => readManagedFeedbackForGate(f.api, pr, head),
  };
  const first = await gatePr(34, deps);
  expect(first.state).toBe('failure');
  expect(first.notChecked).toBe(true);
  await gh.writeStatus(HEAD, { state: first.state, description: '其他失败摘要' });
  expect((await gatePr(34, deps)).state).toBe('failure');
  expect(f.reviews.filter((r) => r.body.startsWith(FEEDBACK_MARKER))).toHaveLength(0);
});
it('owner正式CR不支持，显式COMMENTED仍能登记', async () => {
  const f = fake();
  await expect(f.api.post('/pulls/34/reviews', { event: 'REQUEST_CHANGES' })).rejects.toThrow('422');
  expect((await transactFeedback(f.api, 34, base, 2)).state).toBe('registered');
});

it('旧head消费和错仓/错PR协议不能落入有效责任', () => {
  expect(() => reduce([base, { ...base, action: 'ack', requestId: 'ack-stale', head: NEXT }])).toThrow(
    '审查头',
  );
  expect(() => reduce([{ ...base, repoId: 999 }])).toThrow('身份不匹配');
  expect(() => reduce([{ ...base, pr: 999 }])).toThrow('身份不匹配');
});
it('最新状态被别的writer抢写为绿，历史pending不能充当阻合回执', async () => {
  const f = fake();
  const api = {
    ...f.api,
    get: async (path: string) => {
      if (path.startsWith('/commits/'))
        return [{ context: 'merge-gate', state: 'success', creator: { id: 3 } }, ...f.statuses];
      return f.api.get(path);
    },
  };
  await expect(transactFeedback(api, 34, base, 2)).rejects.toThrow('最新阻合状态');
  expect(f.reviews.filter((r) => r.body.startsWith(FEEDBACK_MARKER))).toHaveLength(0);
});
it('取消后按同requestId重试可恢复，不新造第二代意见', async () => {
  const f = clientWorld();
  try {
    f.cancel();
    await expect(managedWork('return', ['12', '--body-file', f.body], f.o)).rejects.toThrow('取消');
    const old = JSON.parse(readFileSync(join(f.dir, 'feedback-intent.json'), 'utf8'));
    f.recover();
    expect(await managedWork('feedback', ['12', '--retry'], f.o)).toBe(0);
    expect(f.reviews.filter((r) => r.body.startsWith(FEEDBACK_MARKER))).toHaveLength(1);
    const saved = JSON.parse(
      f.reviews
        .find((r) => r.body.startsWith(FEEDBACK_MARKER))
        ?.body.slice('<!-- fleet-managed-feedback:v1 -->'.length) ?? '',
    );
    expect(saved.requestId).toBe(old.requestId);
    expect(saved.generation).toBe(1);
  } finally {
    f.close();
  }
});
it('没有退回时正常受管交付不多派会话，仍精确head squash', async () => {
  const f = clientWorld();
  try {
    expect(await managedWork('deliver', ['12'], f.o)).toBe(0);
    expect(f.merges).toHaveLength(1);
    expect(f.reviews).toHaveLength(0);
  } finally {
    f.close();
  }
});

it('标准关单入口也保留本机未解决退回', async () => {
  const f = clientWorld();
  vi.stubEnv('FLEET_WORK_RUNS_DIR', f.root);
  try {
    await managedWork('return', ['12', '--body-file', f.body], f.o);
    await expect(managedCloseGate(f.gh, 'https://api.github.com/repos/owner/repo', 12)).rejects.toThrow(
      '未解决',
    );
  } finally {
    vi.unstubAllEnvs();
    f.close();
  }
});

it.each([NEXT, 'c'.repeat(40)])('A orphan换头/forcepush到%s仍阻合，同请求能恢复正式回执', async (head) => {
  const f = fake();
  f.setDrop();
  await expect(transactFeedback(f.api, 34, base, 2)).rejects.toThrow('回执未核实');
  expect(f.reviews.filter((r) => r.body.startsWith(PREPARE_MARKER))).toHaveLength(1);
  f.live.head.sha = head;
  f.statuses.splice(0);
  const gh = gateGitHub(f.api);
  const deps = {
    gh,
    standardPaths: async () => [],
    readFeedback: (pr: number, sha: string) => readManagedFeedbackForGate(f.api, pr, sha),
  };
  expect((await gatePr(34, deps)).state).toBe('failure');
  f.restoreReview();
  expect((await transactFeedback(f.api, 34, base, 2)).state).toBe('registered');
  expect(f.reviews.filter((r) => r.body.startsWith(PREPARE_MARKER))).toHaveLength(1);
  expect(f.reviews.filter((r) => r.body.startsWith(FEEDBACK_MARKER))).toHaveLength(1);
  expect((await gatePr(34, deps)).state).toBe('failure');
});
it('可信prepare坏摘要或伪报仓身份failclosed；陌生Bot prepare不增加普通本机门槛', async () => {
  const f = fake();
  f.reviews.push({ ...review(base), body: prepareBody({ ...base, digest: '0'.repeat(64) }, HEAD) });
  await expect(readManagedFeedbackForGate(f.api, 34, HEAD)).rejects.toThrow('摘要');
  f.reviews.splice(0);
  f.reviews.push({ ...review(base), body: prepareBody({ ...base, repoId: 99 }, HEAD) });
  await expect(readManagedFeedbackForGate(f.api, 34, HEAD)).rejects.toThrow('不匹配');
  f.reviews[0] = { ...review(base), user: { id: 999, type: 'Bot' }, body: prepareBody(base, HEAD) };
  expect(await readManagedFeedbackForGate(f.api, 34, HEAD)).toEqual({ records: [] });
});

const MERGE = 'd'.repeat(40);
const OTHER_HEAD = 'e'.repeat(40);

function externalSpec(): RunSpec {
  return {
    v: 1,
    repo: 'acme/app',
    issue: 42,
    title: 'captcha',
    repoRoot: '/repo',
    worktree: '/wt',
    branch: 'local/42-work',
    dispatcher: 'sess',
    reclaude: 'reclaude',
    env: {},
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

function mergedBody(n: number, body: string, patch: Record<string, unknown> = {}) {
  return {
    number: n,
    state: 'closed',
    merged: true,
    merged_at: '2026-10-19T01:36:55Z',
    merge_commit_sha: MERGE,
    body,
    head: { ref: `fleet/${n}-other`, sha: OTHER_HEAD },
    base: { repo: { full_name: 'acme/app' } },
    ...patch,
  };
}

function ghScript(script: {
  head?: { code: number; stdout: string; stderr: string };
  search?: { code: number; stdout: string; stderr: string };
  pulls?: Record<number, { code: number; stdout: string; stderr: string }>;
}): { gh: Gh; calls: string[][] } {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push([...args]);
    if (args.includes('create') || (args[0] === 'pr' && args[1] === 'merge')) {
      return { code: 0, stdout: 'forged', stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'list' && args.includes('--head')) {
      return script.head ?? { code: 0, stdout: '[]', stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      return script.search ?? { code: 0, stdout: '[]', stderr: '' };
    }
    if (args[0] === 'api') {
      const matched = /pulls\/(\d+)$/.exec(args[1] ?? '');
      const n = Number(matched?.[1]);
      return script.pulls?.[n] ?? { code: 1, stdout: '', stderr: `missing pull ${args[1] ?? ''}` };
    }
    if (args[0] === 'issue') return { code: 0, stdout: JSON.stringify({ state: 'CLOSED' }), stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { gh, calls };
}

const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const settled = async () => 'settled' as const;
const noAcceptance = async () => {
  throw new Error('没有核到外部事实，不该读验收责任');
};

describe('他分支交付必须核同仓真实PR，不能靠关单或伪造', () => {
  it('issue已关闭、同仓也没有关联的已合并PR：blocked，不记完成', async () => {
    const spec = externalSpec();
    const { gh, calls } = ghScript({ search: ok([]) });
    await expect(validateManagedDelivery(gh, spec, true, '/unused', noAcceptance)).rejects.toMatchObject({
      kind: 'blocked',
      message: expect.stringContaining('issue是否关闭不能当作交付'),
    });
    expect(calls.some((c) => c[0] === 'issue')).toBe(false);
    expect(calls.some((c) => c.includes('create') || c.includes('merge'))).toBe(false);
  });

  it('别的仓、缺mergeCommit、标题或分片Refs、分支对不上：都不当已交付', async () => {
    const spec = externalSpec();
    const cases: Record<string, unknown>[] = [
      mergedBody(3194, '**需求**：Closes #42\n', { base: { repo: { full_name: 'other/repo' } } }),
      mergedBody(3194, '**需求**：Closes #42\n', { merge_commit_sha: null }),
      mergedBody(3194, '标题里提到 #42，没有关单词'),
      mergedBody(3194, '**需求**：Refs #42 分片、关不了它\n', {
        head: { ref: 'fleet/42-slice', sha: OTHER_HEAD },
      }),
      mergedBody(3194, '```\nCloses #42\n```\n'),
      mergedBody(3194, 'Closes other/repo#42'),
    ];
    for (const body of cases) {
      const { gh, calls } = ghScript({
        search: ok([{ number: 3194 }]),
        pulls: { 3194: ok(body) },
      });
      await expect(validateManagedDelivery(gh, spec, true, '/unused', noAcceptance)).rejects.toMatchObject({
        kind: 'blocked',
      });
      expect(calls.some((c) => c.includes('create') || c.includes('merge'))).toBe(false);
    }
  });

  it('同分支名即使写了关单词也不当成外部交付，避免伪造本分支PR', async () => {
    const spec = externalSpec();
    const { gh } = ghScript({
      search: ok([{ number: 9 }]),
      pulls: {
        9: ok(
          mergedBody(9, '**需求**：Closes #42\n', {
            head: { ref: spec.branch, sha: OTHER_HEAD },
          }),
        ),
      },
    });
    await expect(validateManagedDelivery(gh, spec, true, '/unused', noAcceptance)).rejects.toMatchObject({
      kind: 'blocked',
      message: expect.stringContaining('不记完成'),
    });
  });

  it('两条都核上：不猜哪条交付', async () => {
    const spec = externalSpec();
    const { gh } = ghScript({
      search: ok([{ number: 3194 }, { number: 3195 }]),
      pulls: {
        3194: ok(mergedBody(3194, '**需求**：Closes #42\n')),
        3195: ok(mergedBody(3195, 'Fixes #42')),
      },
    });
    await expect(validateManagedDelivery(gh, spec, true, '/unused', settled)).rejects.toMatchObject({
      kind: 'blocked',
      message: expect.stringContaining('#3194、#3195'),
    });
  });

  it('同仓关单、head、mergeCommit都核上才报外部交付；验收未结不能当完成', async () => {
    const spec = externalSpec();
    const { gh, calls } = ghScript({
      search: ok([{ number: 3194 }]),
      pulls: { 3194: ok(mergedBody(3194, '**需求**：Closes #42\n')) },
    });
    await expect(
      validateManagedDelivery(gh, spec, true, '/unused', async () => 'open'),
    ).rejects.toMatchObject({
      kind: 'external',
      acceptance: 'open',
      external: { repo: 'acme/app', pr: 3194, head: OTHER_HEAD, mergeCommit: MERGE },
    });
    expect(calls.some((c) => c.includes('create') || c.includes('merge'))).toBe(false);
  });

  it('本机退回意图还在：外部事实齐了也带保留，不能终结', async () => {
    const spec = externalSpec();
    const root = mkdtempSync(join(tmpdir(), 'external-intent-'));
    try {
      const dir = runDir(root, spec.repo, spec.issue);
      mkdirSync(dir, { recursive: true });
      writeJson(join(dir, 'feedback-intent.json'), { requestId: 'keep' });
      const { gh } = ghScript({
        search: ok([{ number: 3194 }]),
        pulls: { 3194: ok(mergedBody(3194, 'Closes #42')) },
      });
      await expect(validateManagedDelivery(gh, spec, true, root, settled)).rejects.toMatchObject({
        kind: 'external',
        retain: true,
        acceptance: 'settled',
        message: expect.stringContaining('不能终结'),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('搜索被截断、列表认不出、404跳过后没有第二条：都不记完成', async () => {
    const spec = externalSpec();
    const truncated = ghScript({ search: ok(Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }))) });
    await expect(
      validateManagedDelivery(truncated.gh, spec, true, '/unused', noAcceptance),
    ).rejects.toMatchObject({
      kind: 'blocked',
      message: expect.stringContaining('截断'),
    });
    const odd = ghScript({ head: ok({ state: 'CLOSED' }) });
    await expect(validateManagedDelivery(odd.gh, spec, true, '/unused', noAcceptance)).rejects.toMatchObject({
      kind: 'blocked',
      message: expect.stringContaining('认不出'),
    });
    const missing = ghScript({
      search: ok([{ number: 3194, title: 'not a field we trust' }]),
      pulls: { 3194: { code: 1, stdout: '', stderr: 'HTTP 404: Not Found' } },
    });
    await expect(
      validateManagedDelivery(missing.gh, spec, true, '/unused', noAcceptance),
    ).rejects.toMatchObject({
      kind: 'blocked',
    });
  });

  it('本分支列表、搜索或外部PR读失败是可重试，不是已交付', async () => {
    const spec = externalSpec();
    const headDown = ghScript({ head: { code: 1, stdout: '', stderr: 'socket hang up' } });
    await expect(
      validateManagedDelivery(headDown.gh, spec, true, '/unused', noAcceptance),
    ).rejects.toMatchObject({
      kind: 'retry',
      message: expect.stringContaining('受管PR读取失败'),
    });
    const searchDown = ghScript({ search: { code: 1, stdout: '', stderr: 'timed out' } });
    await expect(
      validateManagedDelivery(searchDown.gh, spec, true, '/unused', noAcceptance),
    ).rejects.toMatchObject({
      kind: 'retry',
      message: expect.stringContaining('他分支交付没读成'),
    });
    const apiDown = ghScript({
      search: ok([{ number: 3194 }]),
      pulls: { 3194: { code: 1, stdout: '', stderr: 'HTTP 502' } },
    });
    await expect(
      validateManagedDelivery(apiDown.gh, spec, true, '/unused', noAcceptance),
    ).rejects.toMatchObject({
      kind: 'retry',
      message: expect.stringContaining('外部PR #3194'),
    });
    const badJson = ghScript({ head: { code: 0, stdout: 'not-json', stderr: '' } });
    await expect(
      validateManagedDelivery(badJson.gh, spec, true, '/unused', noAcceptance),
    ).rejects.toMatchObject({
      kind: 'retry',
      message: expect.stringContaining('响应不是JSON'),
    });
  });

  it('重派前本分支没有PR且没有退回意图：不因外部交付挡住关单', async () => {
    const spec = externalSpec();
    const { gh, calls } = ghScript({
      search: ok([{ number: 3194 }]),
      pulls: { 3194: ok(mergedBody(3194, 'Closes #42')) },
    });
    await expect(validateManagedDelivery(gh, spec, false, '/unused', settled)).resolves.toBeUndefined();
    expect(calls.some((c) => c.includes('--search'))).toBe(false);
  });
});
