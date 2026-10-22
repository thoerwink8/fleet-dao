// PR 头的完整检出、第 2 轮增量 diff：用临时镜像，不碰本机的引擎镜像。
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { checkoutNotificationProblem } from '@fleet-dao/store';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type CheckoutBlockedAlert,
  type CheckoutReceipt,
  type CheckoutRecovered,
  CheckoutStageError,
  checkoutAlertKey,
  checkoutBlockedAlert,
  checkoutPrHead,
  type IncrementalDiffArgs,
  incrementalDiffAtHead,
  placeVerifyCheckout,
  VERIFY_CHECKOUT_FALLBACK,
} from '../src/cold-verify-run.ts';
import {
  type AttributionFixture,
  buildAttributionFixture,
  deleteFetchedMainline,
  FIXTURE_REPO,
  gitText,
  LAUNCHER_GO,
  LAUNCHER_YML,
  PACKAGE_JSON_PATH,
  setFetchedMainline,
  WORKFLOW_ID,
} from './attribution-fixture.ts';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  return result.stdout.trim();
}

describe('PR 头的完整检出和增量 diff', () => {
  let state = '';
  const prev = process.env.FLEET_GITHUB_STATE_DIR;

  afterEach(() => {
    if (prev === undefined) delete process.env.FLEET_GITHUB_STATE_DIR;
    else process.env.FLEET_GITHUB_STATE_DIR = prev;
    if (state !== '') rmSync(state, { recursive: true, force: true });
    state = '';
  });

  async function mirrorWith(
    files: { path: string; text: string }[],
  ): Promise<{ head: string; first: string }> {
    state = mkdtempSync(join(tmpdir(), 'fleet-verify-mirror-'));
    process.env.FLEET_GITHUB_STATE_DIR = state;
    const bare = join(state, 'mirrors', 'acme', 'demo.git');
    mkdirSync(join(state, 'mirrors', 'acme'), { recursive: true });
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare], { env: gitEnv });
    const work = join(state, 'work');
    await execFileAsync('git', ['init', '-b', 'main', work], { env: gitEnv });
    const commit = async (message: string) => {
      await git(work, ['add', '.']);
      await git(work, ['commit', '-m', message]);
      return git(work, ['rev-parse', 'HEAD']);
    };
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error('至少要一个文件');
    writeFileSync(join(work, firstFile.path), firstFile.text);
    const first = await commit('first');
    for (const file of files.slice(1)) writeFileSync(join(work, file.path), file.text);
    const head = files.length > 1 ? await commit('second') : first;
    await git(work, ['remote', 'add', 'origin', bare]);
    await git(work, ['push', 'origin', 'HEAD']);
    return { head, first };
  }

  it('检出里能读到 PR 头上的文件', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const dest = join(state, 'checkout with spaces');
    await checkoutPrHead(dest, head, 'task:acme/demo#12');
    expect(readFileSync(join(dest, 'hello.txt'), 'utf8')).toBe('hello\n');
  });

  it('相对且含空格的目标目录仍相对调用方 cwd，真实解包到该目录', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const tmpRoot = join(process.cwd(), '_tmp');
    mkdirSync(tmpRoot, { recursive: true });
    const local = mkdtempSync(join(tmpRoot, 'verify-relative-'));
    // 本次创建的私有目录在当前检出的 _tmp 下，清理只针对它。
    expect(relative(tmpRoot, local)).toMatch(/^verify-relative-[^/\\]+$/);
    const absolute = join(local, 'checkout with spaces');
    const target = relative(process.cwd(), absolute);
    expect(isAbsolute(target)).toBe(false);
    try {
      await checkoutPrHead(target, head, 'task:acme/demo#12');
      expect(readFileSync(join(absolute, 'hello.txt'), 'utf8')).toBe('hello\n');
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });

  it('增量 diff 只含上一轮头之后的改动', async () => {
    const { head, first } = await mirrorWith([
      { path: 'hello.txt', text: 'hello\n' },
      { path: 'hello.txt', text: 'hello\nworld\n' },
    ]);
    const diff = await incrementalDiffAtHead({
      workflowId: 'task:acme/demo#12',
      sinceSha: first,
      headSha: head,
    });
    expect(diff.changedFiles).toEqual(['hello.txt']);
    expect(diff.diffText).toContain('+world');
    expect(diff.diffText).not.toContain('diff --git a/hello.txt b/hello.txt\nnew file');
  });

  it('提交不在镜像里：仍报读不到增量 diff，不改口成归属失败', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    await expect(
      incrementalDiffAtHead({
        workflowId: 'task:acme/demo#12',
        sinceSha: 'd'.repeat(40),
        headSha: head,
      }),
    ).rejects.toThrow('读不到增量 diff');
  });

  it('给了可信主线的线性区间仍只含作者这次改动', async () => {
    const { head, first } = await mirrorWith([
      { path: 'hello.txt', text: 'hello\n' },
      { path: 'hello.txt', text: 'hello\nworld\n' },
    ]);
    const bare = join(state, 'mirrors', 'acme', 'demo.git');
    await git(bare, ['update-ref', 'refs/fleet/main', first]);
    const diff = await incrementalDiffAtHead({
      workflowId: 'task:acme/demo#12',
      sinceSha: first,
      headSha: head,
      repo: { owner: 'acme', name: 'demo' },
      prNumber: 42,
      issueNumber: 12,
      baseSha: first,
      mainlineSha: first,
    });
    expect(diff.changedFiles).toEqual(['hello.txt']);
    expect(diff.diffText).toContain('+world');
    expect(diff.diffText).toContain('# 本单返工');
    expect(diff.diffText).toContain('与用来拆归属的主线相同');
  });

  it('目录本来可写：直接检出，不修、不报警', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const dest = join(state, '_tmp', 'verify-ok');
    const repairs: string[] = [];
    const logs: string[] = [];
    const blocked: string[] = [];
    const placed = await placeVerifyCheckout({
      dir: dest,
      head,
      workflowId: 'task:acme/demo#12',
      repair: async (dir) => {
        repairs.push(dir);
      },
      log: (message) => {
        logs.push(message);
      },
      onBlocked: async (alert) => {
        blocked.push(alert.body);
      },
    });
    expect(placed).toBe('full');
    expect(readFileSync(join(dest, 'hello.txt'), 'utf8')).toBe('hello\n');
    expect(repairs).toEqual([]);
    expect(logs).not.toContain(VERIFY_CHECKOUT_FALLBACK);
    expect(blocked).toEqual([]);
  });

  it('模拟 _tmp 为 root:root 755：先 EACCES，修好后再放进 PR 头的完整检出，不走退路', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const dest = join(state, '_tmp', 'verify-e75af80b');
    let denied = true;
    const repairs: string[] = [];
    const logs: string[] = [];
    const blocked: string[] = [];
    const receipts: CheckoutReceipt[] = [];
    const placed = await placeVerifyCheckout({
      onCompleted: async (r) => {
        receipts.push(r);
      },
      dir: dest,
      head,
      workflowId: 'task:acme/demo#12',
      checkout: async (dir, headSha, workflowId) => {
        // 夹具：引擎用户在 root:root 755 的 _tmp 下 mkdir。第一次拒绝，repair 之后放行。
        if (denied) {
          denied = false;
          throw Object.assign(new Error(`EACCES: permission denied, mkdir '${dir}'`), { code: 'EACCES' });
        }
        await checkoutPrHead(dir, headSha, workflowId);
      },
      repair: async (dir) => {
        repairs.push(dir);
      },
      log: (message) => {
        logs.push(message);
      },
      onBlocked: async (alert) => {
        blocked.push(alert.body);
      },
    });
    expect(placed).toBe('full');
    expect(readFileSync(join(dest, 'hello.txt'), 'utf8')).toBe('hello\n');
    expect(repairs).toEqual([dest]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.head).toBe(head);
    expect(logs).not.toContain(VERIFY_CHECKOUT_FALLBACK);
    expect(blocked).toEqual([]);
  });

  /** 默认真检出；Windows 权限用例显式注入阶段错误。数 checkout / repair 次数并收下报警。 */
  async function placeReal(
    dest: string,
    head: string,
    workflowId: string | undefined,
    checkout = checkoutPrHead,
  ) {
    const calls: string[] = [];
    const repairs: string[] = [];
    const alerts: CheckoutBlockedAlert[] = [];
    const placed = await placeVerifyCheckout({
      dir: dest,
      head,
      workflowId,
      checkout: async (dir, headSha, flow) => {
        calls.push(dir);
        await checkout(dir, headSha, flow);
      },
      repair: async (dir) => {
        repairs.push(dir);
      },
      onBlocked: async (alert) => {
        alerts.push(alert);
      },
    });
    return { placed, calls, repairs, alerts };
  }

  it('镜像里没有目标 head（not a tree object）：归到 git archive 缺对象，写明 head 和镜像，建议 fetch，不修权限不重试', async () => {
    await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const missing = 'f'.repeat(40);
    const err = await checkoutPrHead(join(state, 'co-missing'), missing, 'task:acme/demo#12').catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutStageError);
    expect(err).toMatchObject({ stage: 'archive', missingObject: true });
    expect(err.message).toContain('not a tree object');

    const { placed, calls, repairs, alerts } = await placeReal(
      join(state, 'co-missing-2'),
      missing,
      'task:acme/demo#12',
    );
    expect(placed).toBe('blocked');
    expect(calls).toHaveLength(1);
    expect(repairs).toEqual([]);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(alert?.stage).toBe('archive');
    expect(alert?.dedupeKey).toBe(checkoutAlertKey('task:acme/demo#12', missing));
    expect(alert?.body).toContain(missing);
    expect(alert?.body).toContain(join(state, 'mirrors', 'acme', 'demo.git'));
    expect(alert?.body).toContain('not a tree object');
    expect(alert?.body).toContain('fetch');
    expect(alert?.body).not.toContain('mkdir');
  });

  it('没有镜像：归到找镜像那一步，不修', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const { placed, repairs, alerts } = await placeReal(join(state, 'co-nomirror'), head, 'task:acme/nope#3');
    expect(placed).toBe('blocked');
    expect(repairs).toEqual([]);
    expect(alerts[0]?.stage).toBe('mirror');
    expect(alerts[0]?.body).toContain('引擎镜像里没有这个仓');
    expect(alerts[0]?.body).toContain(join(state, 'mirrors', 'acme', 'nope.git'));
    expect(alerts[0]?.body).not.toContain('mkdir');
  });

  it.skipIf(process.getuid?.() === 0)(
    `解包失败（${process.platform === 'win32' ? 'Windows tar 权限失败夹具' : 'POSIX 真权限'}）：原错保留，不修不重试`,
    async () => {
      const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
      const dest = join(state, 'co-extract');
      mkdirSync(dest, { recursive: true });
      if (process.platform !== 'win32') chmodSync(dest, 0o555);
      try {
        // Windows chmod 没有 POSIX 目录写权限语义：明示注入阶段错；Linux 仍跑 chmod + 真 tar。
        const extract =
          process.platform === 'win32'
            ? async () => {
                // tar 的权限失败是非零退出 + stderr，不是 spawn 的 EACCES errno。
                throw new CheckoutStageError('extract', 'tar: hello.txt: Cannot open: Permission denied');
              }
            : checkoutPrHead;
        const { placed, calls, repairs, alerts } = await placeReal(dest, head, 'task:acme/demo#12', extract);
        expect(placed).toBe('blocked');
        expect(calls).toHaveLength(1);
        expect(repairs).toEqual([]);
        expect(alerts[0]?.stage).toBe('extract');
        expect(alerts[0]?.body).toContain('hello.txt');
        expect(alerts[0]?.body).not.toContain('mkdir');
      } finally {
        if (process.platform !== 'win32') chmodSync(dest, 0o755);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    `建目录 EACCES（${process.platform === 'win32' ? 'Windows 端口夹具' : 'POSIX 上一层 555 真权限'}）：走既有修复，建议 mkdir`,
    async () => {
      const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
      const parent = join(state, '_tmp');
      mkdirSync(parent, { recursive: true });
      if (process.platform !== 'win32') chmodSync(parent, 0o555);
      try {
        const { placed, calls, repairs, alerts } = await placeReal(
          join(parent, 'verify-x'),
          head,
          'task:acme/demo#12',
          process.platform === 'win32'
            ? async () => {
                throw new CheckoutStageError('mkdir', 'EACCES: permission denied, mkdir', { code: 'EACCES' });
              }
            : checkoutPrHead,
        );
        expect(placed).toBe('blocked');
        expect(repairs).toEqual([join(parent, 'verify-x')]);
        expect(calls).toHaveLength(2);
        expect(alerts[0]?.stage).toBe('mkdir');
        expect(alerts[0]?.body).toContain('EACCES');
        expect(alerts[0]?.body).toContain('引擎用户要能在这一层下面 mkdir');
      } finally {
        if (process.platform !== 'win32') chmodSync(parent, 0o755);
      }
    },
  );
  it('补齐远端精确头后真实检出；分支前进不替代待验内容', async () => {
    const { first } = await mirrorWith([{ path: 'hello.txt', text: 'first\n' }]);
    const work = join(state, 'work');
    writeFileSync(join(work, 'hello.txt'), 'expected\n');
    await git(work, ['commit', '-am', 'expected']);
    const expected = await git(work, ['rev-parse', 'HEAD']);
    const remote = join(state, 'remote.git');
    await git(state, ['init', '--bare', '-b', 'main', remote]);
    await git(work, ['push', remote, 'HEAD:refs/heads/topic']);
    writeFileSync(join(work, 'hello.txt'), 'advanced\n');
    await git(work, ['commit', '-am', 'advanced']);
    await git(work, ['push', remote, 'HEAD:refs/heads/topic']);
    const mirror = join(state, 'mirrors', 'acme', 'demo.git');
    expect(await git(mirror, ['rev-parse', 'main'])).toBe(first);
    const dest = join(state, 'expected-checkout');
    const recovered: CheckoutRecovered[] = [];
    const receipts: CheckoutReceipt[] = [];
    const got = await placeVerifyCheckout({
      onCompleted: async (r) => {
        receipts.push(r);
      },
      dir: dest,
      head: expected,
      workflowId: 'task:acme/demo#12',
      ensureHead: async () => {
        await git(mirror, ['fetch', remote, expected]);
      },
      onRecovered: async (r) => {
        recovered.push(r);
      },
    });
    expect(got).toBe('full');
    expect(readFileSync(join(dest, 'hello.txt'), 'utf8')).toBe('expected\n');
    expect(recovered[0]?.head).toBe(expected);
    expect(receipts[0]).toMatchObject({
      head: expected,
      dir: dest,
      type: 'full',
      workflowId: 'task:acme/demo#12',
    });
    await placeVerifyCheckout({
      dir: join(state, 'second-checkout'),
      head: expected,
      workflowId: 'task:acme/demo#12',
      onCompleted: async (r) => {
        receipts.push(r);
      },
    });
    expect(receipts).toHaveLength(2);
    expect(receipts[1]?.receiptId).not.toBe(receipts[0]?.receiptId);
    expect(receipts[0]?.completedAt.getTime()).toBeGreaterThanOrEqual(
      receipts[0]?.startedAt.getTime() ?? Infinity,
    );
  });

  it('获取精确头失败保持原头报警，不archive、不误撤；调用取消也不archive或撤报警', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    let checkouts = 0;
    let recoveries = 0;
    const alerts: CheckoutBlockedAlert[] = [];
    const base = {
      dir: join(state, 'blocked'),
      head,
      workflowId: 'task:acme/demo#12',
      checkout: async () => {
        checkouts++;
      },
      onRecovered: async () => {
        recoveries++;
      },
      onBlocked: async (a: CheckoutBlockedAlert) => {
        alerts.push(a);
      },
    };
    expect(
      await placeVerifyCheckout({
        ...base,
        ensureHead: async () => {
          throw new Error('exact fetch failed');
        },
      }),
    ).toBe('blocked');
    expect(alerts[0]?.stage).toBe('fetch');
    expect(alerts[0]?.body).toContain(head);
    expect(alerts[0]?.body).toContain('exact fetch failed');
    const abort = new AbortController();
    await expect(
      placeVerifyCheckout({
        ...base,
        signal: abort.signal,
        ensureHead: async () => {
          abort.abort(new Error('cancelled'));
        },
      }),
    ).rejects.toThrow('cancelled');
    expect(checkouts).toBe(0);
    expect(recoveries).toBe(0);
  });
});

/**
 * 假报警库：照真端口的规矩——再报原地更新（已撤的重开，updatedAt 拨到这一刻），撤只撤 startedAt 之前报的那条。
 * 时钟是递增的整数，开跑、报警、撤卡谁先谁后看得清。
 */
function alertBook() {
  let tick = 0;
  const clock = () => new Date(++tick * 1000);
  const rows = new Map<string, { body: string; updatedAt: Date; resolved: boolean }>();
  const resolutions: string[] = [];
  return {
    clock,
    rows,
    resolutions,
    raise: async (alert: CheckoutBlockedAlert) => {
      rows.set(alert.dedupeKey, { body: alert.body, updatedAt: clock(), resolved: false });
    },
    recover: async (recovered: CheckoutRecovered) => {
      const row = rows.get(recovered.dedupeKey);
      if (row === undefined || row.resolved || row.updatedAt >= recovered.startedAt) return;
      row.resolved = true;
      resolutions.push(recovered.dedupeKey);
    },
  };
}

describe('检出恢复后按目标撤旧报警', () => {
  const dir = '/var/lib/fleet-work/_tmp/verify-3036';
  const A = 'task:acme/demo#12';
  const B = 'task:acme/demo#13';
  const head = 'a'.repeat(40);
  const notATree = () =>
    new CheckoutStageError('archive', `fatal: not a tree object: ${head}`, { missingObject: true });

  function place(
    book: ReturnType<typeof alertBook>,
    workflowId: string,
    checkout: () => Promise<void>,
    extra: { log?: (message: string) => void; onRecovered?: (r: CheckoutRecovered) => Promise<void> } = {},
  ) {
    return placeVerifyCheckout({
      dir,
      head,
      workflowId,
      checkout,
      now: book.clock,
      onBlocked: book.raise,
      onRecovered: extra.onRecovered ?? book.recover,
      ...(extra.log ? { log: extra.log } : {}),
    });
  }

  it('A 失败→B 成功：A 的报警留着', async () => {
    const book = alertBook();
    expect(await place(book, A, async () => Promise.reject(notATree()))).toBe('blocked');
    expect(await place(book, B, async () => undefined)).toBe('full');
    expect(book.rows.get(checkoutAlertKey(A, head))?.resolved).toBe(false);
    expect(book.resolutions).toEqual([]);
  });

  it('A 失败→A 成功撤 A；再成功一次幂等', async () => {
    const book = alertBook();
    await place(book, A, async () => Promise.reject(notATree()));
    expect(await place(book, A, async () => undefined)).toBe('full');
    expect(await place(book, A, async () => undefined)).toBe('full');
    expect(book.rows.get(checkoutAlertKey(A, head))?.resolved).toBe(true);
    expect(book.resolutions).toEqual([checkoutAlertKey(A, head)]);
  });

  it('并发：早开跑的成功回执晚到，不撤之后才报的新故障', async () => {
    const book = alertBook();
    let release: () => void = () => undefined;
    const slow = place(book, A, () => new Promise<void>((resolve) => (release = resolve)));
    expect(await place(book, A, async () => Promise.reject(notATree()))).toBe('blocked');
    release();
    expect(await slow).toBe('full');
    expect(book.rows.get(checkoutAlertKey(A, head))?.resolved).toBe(false);
    expect(book.resolutions).toEqual([]);
  });

  it('失败不撤卡：onRecovered 一次都不调', async () => {
    const book = alertBook();
    const recovered: CheckoutRecovered[] = [];
    await place(book, A, async () => Promise.reject(new Error('别的错')), {
      onRecovered: async (r) => {
        recovered.push(r);
      },
    });
    expect(recovered).toEqual([]);
  });

  it('撤卡端口失败：检出仍是 full，报警留着，记一句没撤成', async () => {
    const book = alertBook();
    const logs: string[] = [];
    await place(book, A, async () => Promise.reject(notATree()));
    const placed = await place(book, A, async () => undefined, {
      log: (message) => logs.push(message),
      onRecovered: async () => {
        throw new Error('库连不上');
      },
    });
    expect(placed).toBe('full');
    expect(book.rows.get(checkoutAlertKey(A, head))?.resolved).toBe(false);
    expect(logs).toContain('冷验收检出放进去了，但这个目标的旧检出报警没撤成（报警留着）');
  });

  it('EACCES 修好后真检出成功：撤这个目标的旧报警', async () => {
    const book = alertBook();
    await place(book, A, async () => Promise.reject(notATree()));
    let denied = true;
    const placed = await placeVerifyCheckout({
      dir,
      head,
      workflowId: A,
      checkout: async () => {
        if (denied) {
          denied = false;
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
      },
      repair: async () => undefined,
      now: book.clock,
      onBlocked: book.raise,
      onRecovered: book.recover,
    });
    expect(placed).toBe('full');
    expect(book.rows.get(checkoutAlertKey(A, head))?.resolved).toBe(true);
  });
});

describe('建不出检出目录时报警里有路径', () => {
  const dir = '/var/lib/fleet-work/_tmp/verify-e75af80b';

  it('修好了仍是 EACCES：走退路，报警正文含目录路径', async () => {
    const logs: string[] = [];
    const blocked: { body: string; dedupeKey: string }[] = [];
    const placed = await placeVerifyCheckout({
      dir,
      head: 'a'.repeat(40),
      workflowId: 'task:acme/demo#12',
      checkout: async (target) => {
        throw Object.assign(new Error(`EACCES: permission denied, mkdir '${target}'`), { code: 'EACCES' });
      },
      repair: async () => undefined,
      log: (message) => {
        logs.push(message);
      },
      onBlocked: async (alert) => {
        blocked.push({ body: alert.body, dedupeKey: alert.dedupeKey });
      },
    });
    expect(placed).toBe('blocked');
    expect(logs).toContain(VERIFY_CHECKOUT_FALLBACK);
    const error = Object.assign(new Error(`EACCES: permission denied, mkdir '${dir}'`), { code: 'EACCES' });
    expect(blocked).toEqual([
      {
        dedupeKey: checkoutAlertKey('task:acme/demo#12', 'a'.repeat(40)),
        body: checkoutBlockedAlert({ dir, head: 'a'.repeat(40), workflowId: 'task:acme/demo#12', error })
          .body,
      },
    ]);
    expect(blocked[0]?.body).toContain(dir);
    expect(blocked[0]?.body).toContain('引擎用户要能在这一层下面 mkdir');
  });

  it('没认出的错：归 unknown，原错原样，不修、不给目录建议', async () => {
    const repairs: string[] = [];
    const alerts: CheckoutBlockedAlert[] = [];
    const logs: Record<string, unknown>[] = [];
    const placed = await placeVerifyCheckout({
      dir,
      head: 'e'.repeat(40),
      workflowId: 'task:acme/demo#12',
      checkout: async () => {
        throw new Error('磁盘读到一半断了');
      },
      repair: async (target) => {
        repairs.push(target);
      },
      log: (_message, fields) => {
        if (fields) logs.push(fields);
      },
      onBlocked: async (alert) => {
        alerts.push(alert);
      },
    });
    expect(placed).toBe('blocked');
    expect(repairs).toEqual([]);
    expect(alerts[0]?.stage).toBe('unknown');
    expect(alerts[0]?.body).toContain('磁盘读到一半断了');
    expect(alerts[0]?.body).toContain('e'.repeat(40));
    expect(alerts[0]?.body).not.toContain('mkdir');
    expect(logs[0]).toMatchObject({ stage: 'unknown', error: '磁盘读到一半断了' });
  });

  it('修复本身失败：不第二次检出，报警正文仍含目录路径', async () => {
    const checkouts: string[] = [];
    const blocked: string[] = [];
    const placed = await placeVerifyCheckout({
      dir,
      head: 'b'.repeat(40),
      workflowId: undefined,
      checkout: async (target) => {
        checkouts.push(target);
        throw Object.assign(new Error(`EACCES: permission denied, mkdir '${target}'`), { code: 'EACCES' });
      },
      repair: async () => {
        throw new Error('ensure-tmp 没换成');
      },
      onBlocked: async (alert) => {
        blocked.push(alert.body);
      },
    });
    expect(placed).toBe('blocked');
    expect(checkouts).toEqual([dir]);
    expect(blocked[0]).toContain(dir);
    expect(blocked[0]).toContain('ensure-tmp 没换成');
    // 原错（EACCES）还在，不被修复那一下的错盖掉
    expect(blocked[0]).toContain('EACCES');
  });

  it('不是权限问题：不修，仍报警且正文含目录路径', async () => {
    const repairs: string[] = [];
    const blocked: string[] = [];
    const placed = await placeVerifyCheckout({
      dir,
      head: 'c'.repeat(40),
      workflowId: undefined,
      checkout: async () => {
        throw new Error('引擎镜像里没有这个仓，放不了 PR 头的完整检出');
      },
      repair: async (target) => {
        repairs.push(target);
      },
      onBlocked: async (alert) => {
        blocked.push(alert.body);
      },
    });
    expect(placed).toBe('blocked');
    expect(repairs).toEqual([]);
    expect(blocked[0]).toContain(dir);
  });

  it('报警写不进库：仍是退路，不把验收停掉', async () => {
    const logs: string[] = [];
    const placed = await placeVerifyCheckout({
      dir,
      head: 'd'.repeat(40),
      workflowId: undefined,
      checkout: async () => {
        throw new Error('放不进去');
      },
      log: (message) => {
        logs.push(message);
      },
      onBlocked: async () => {
        throw new Error('库连不上');
      },
    });
    expect(placed).toBe('blocked');
    expect(logs).toContain(VERIFY_CHECKOUT_FALLBACK);
    expect(logs).toContain('冷验收检出目录的报警没写进库');
  });
});

it('权限修复期间取消，不再开始第二次archive；起步已取消不调用ensureHead', async () => {
  const abort = new AbortController();
  let attempts = 0,
    ensured = 0,
    recovered = 0;
  const input = {
    dir: 'unused',
    head: 'a'.repeat(40),
    workflowId: 'task:acme/demo#12',
    signal: abort.signal,
    ensureHead: async () => {
      ensured++;
    },
    checkout: async () => {
      attempts++;
      throw new CheckoutStageError('mkdir', 'EACCES', { code: 'EACCES' });
    },
    repair: async () => {
      abort.abort(new Error('cancelled during repair'));
    },
    onRecovered: async () => {
      recovered++;
    },
  };
  await expect(placeVerifyCheckout(input)).rejects.toThrow('cancelled during repair');
  expect(attempts).toBe(1);
  expect(ensured).toBe(1);
  expect(recovered).toBe(0);
  await expect(placeVerifyCheckout(input)).rejects.toThrow('cancelled during repair');
  expect(attempts).toBe(1);
  expect(ensured).toBe(1);
});

describe('完整检出成功回执边界', () => {
  it('失败、修复后失败、最终取消都没有成功回执', async () => {
    const receipts: CheckoutReceipt[] = [];
    const base = {
      dir: 'unused',
      head: 'a'.repeat(40),
      workflowId: 'task:a/b#1',
      onCompleted: async (r: CheckoutReceipt) => {
        receipts.push(r);
      },
    };
    expect(
      await placeVerifyCheckout({
        ...base,
        checkout: async () => {
          throw new Error('archive failed');
        },
      }),
    ).toBe('blocked');
    expect(
      await placeVerifyCheckout({
        ...base,
        checkout: async () => {
          throw Object.assign(new Error('permission'), { code: 'EACCES' });
        },
        repair: async () => {},
      }),
    ).toBe('blocked');
    expect(
      await placeVerifyCheckout({
        ...base,
        ensureHead: async () => {
          throw new Error('missing exact object');
        },
        checkout: async () => {
          throw new Error('must not checkout');
        },
      }),
    ).toBe('blocked');
    expect(
      await placeVerifyCheckout({
        ...base,
        checkout: async () => {
          throw Object.assign(new Error('permission'), { code: 'EACCES' });
        },
        repair: async () => {
          throw new Error('repair failed');
        },
      }),
    ).toBe('blocked');
    const abort = new AbortController();
    await expect(
      placeVerifyCheckout({
        ...base,
        signal: abort.signal,
        checkout: async () => {
          abort.abort(new Error('cancel after archive'));
        },
      }),
    ).rejects.toThrow('cancel after archive');
    expect(receipts).toEqual([]);
  });
  it('回执写失败保留未知诊断，撤卡仍独立运行；撤卡失败不抹掉回执', async () => {
    const logs: string[] = [];
    let recovered = 0;
    const base = {
      dir: 'unused',
      head: 'a'.repeat(40),
      workflowId: 'task:a/b#1',
      checkout: async () => {},
      log: (s: string) => {
        logs.push(s);
      },
    };
    expect(
      await placeVerifyCheckout({
        ...base,
        onCompleted: async () => {
          throw new Error('db down');
        },
        onRecovered: async () => {
          recovered++;
        },
      }),
    ).toBe('full');
    expect(recovered).toBe(1);
    expect(logs.some((s) => s.includes('证据未知'))).toBe(true);
    const receipts: CheckoutReceipt[] = [];
    expect(
      await placeVerifyCheckout({
        ...base,
        onCompleted: async (r) => {
          receipts.push(r);
        },
        onRecovered: async () => {
          throw new Error('resolve failed');
        },
      }),
    ).toBe('full');
    expect(receipts).toHaveLength(1);
  });
});

describe('历史 checkout 归档认的报警格式和引擎写的一致（store 的 checkoutNotificationProblem 照抄引擎格式）', () => {
  const head = 'a'.repeat(40);
  const workflowId = 'task:acme/demo#12';
  const dir = '/var/lib/fleet-work/_tmp/verify-0f0e0d0c-0b0a-4908-8706-050403020100';
  const mirrorDir = '/var/lib/fleet-github/mirrors/acme/demo.git';
  const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const errors: [string, unknown, unknown?][] = [
    ['fetch', new CheckoutStageError('fetch', '取精确头失败')],
    ['head', new CheckoutStageError('head', 'PR 的头不是完整的提交号')],
    ['mirror 无路径', new CheckoutStageError('mirror', '对不上')],
    ['mirror 有路径', new CheckoutStageError('mirror', '没有这个仓', { mirrorDir })],
    ['mkdir 带错误码', new CheckoutStageError('mkdir', 'no space。磁盘满了', { code: 'ENOSPC' })],
    ['mkdir EACCES', new CheckoutStageError('mkdir', 'permission denied', { code: 'EACCES' })],
    ['EACCES 修复也没成', eacces, new Error('sudo 不让跑。')],
    ['archive', new CheckoutStageError('archive', 'fatal: corrupt', { mirrorDir })],
    [
      'archive 缺对象',
      new CheckoutStageError('archive', 'fatal: not a valid object name', { mirrorDir, missingObject: true }),
    ],
    ['archive 缺对象无镜像路径', new CheckoutStageError('archive', 'bad object', { missingObject: true })],
    ['extract', new CheckoutStageError('extract', 'tar: 写不进')],
    ['unknown', new Error('磁盘读到一半断了')],
  ];
  for (const [label, error, repairError] of errors) {
    it(`引擎写的「${label}」报警过得了历史归档的格式校验`, () => {
      const alert = checkoutBlockedAlert({
        dir,
        head,
        workflowId,
        error,
        ...(repairError === undefined ? {} : { repairError }),
      });
      expect(
        checkoutNotificationProblem({ title: alert.title, body: alert.body }, { workflowId, head }),
      ).toBeUndefined();
    });
  }

  it('相似但不是受管格式的标题/正文都拒', () => {
    const alert = checkoutBlockedAlert({
      dir,
      head,
      workflowId,
      error: new CheckoutStageError('archive', 'fatal: not a valid object name', {
        mirrorDir,
        missingObject: true,
      }),
    });
    const real = { title: alert.title, body: alert.body };
    const forged: { title: string; body: string }[] = [
      { ...real, title: `${alert.title}（补）` },
      { ...real, title: '冷验收放不进 PR 头的完整检出（随便写的一步）' },
      // 标题的步骤和正文的步骤对不上
      { ...real, title: '冷验收放不进 PR 头的完整检出（建检出目录）' },
      { ...real, body: `${alert.body}另附一句。` },
      { ...real, body: alert.body.replace('引擎不自动重试。', '') },
      { ...real, body: alert.body.replace(dir, '/tmp/verify-13') },
      { ...real, body: alert.body.replace(`取不出目标 head ${head}`, `取不出目标 head ${'c'.repeat(40)}`) },
      { ...real, body: alert.body.replace('（git archive 认不出这个对象）', '') },
      {
        ...real,
        body: `目标 ${workflowId} 的 head ${head}，目录 ${dir}。失败在「从镜像 git archive」这一步，原始错误：x。`,
      },
    ];
    for (const n of forged) expect(checkoutNotificationProblem(n, { workflowId, head })).toBeDefined();
    expect(checkoutNotificationProblem(real, { workflowId: 'task:acme/demo#13', head })).toBeDefined();
  });
});

function omitKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _dropped, ...rest } = value;
  return rest;
}

function between(text: string, start: string, end?: string): string {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(from + start.length);
  if (end === undefined) return rest;
  const to = rest.indexOf(end);
  expect(to, end).toBeGreaterThanOrEqual(0);
  return rest.slice(0, to);
}

const AUTHOR_FILES = ['occupancy.txt', 'regression.txt', 'shared.txt'];

describe('第 2 轮增量把主线同步和本单返工拆开', () => {
  let fx: AttributionFixture;
  let stateDir = '';
  const prev = process.env.FLEET_GITHUB_STATE_DIR;

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'fleet-attr-'));
    process.env.FLEET_GITHUB_STATE_DIR = stateDir;
    fx = await buildAttributionFixture(stateDir);
  });

  afterEach(async () => {
    if (fx !== undefined) await setFetchedMainline(fx.bare, fx.m1);
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.FLEET_GITHUB_STATE_DIR;
    else process.env.FLEET_GITHUB_STATE_DIR = prev;
    if (stateDir !== '') rmSync(stateDir, { recursive: true, force: true });
  });

  const bound = (over: Partial<IncrementalDiffArgs> = {}): IncrementalDiffArgs => ({
    workflowId: WORKFLOW_ID,
    sinceSha: fx.v1,
    headSha: fx.merged,
    repo: FIXTURE_REPO,
    prNumber: 42,
    issueNumber: 12,
    baseSha: fx.m0,
    mainlineSha: fx.m1,
    ...over,
  });

  it('修前两头 diff 把主线删除算进本单；修后只留下返工，主线同步和完整范围仍在正文里', async () => {
    const naive = (await gitText(fx.bare, ['diff', '--name-only', '--no-ext-diff', `${fx.v1}..${fx.merged}`]))
      .split('\n')
      .filter((line) => line !== '');
    const mainlineTouched = (await gitText(fx.bare, ['diff', '--name-only', fx.m0, fx.m1]))
      .split('\n')
      .filter((line) => line !== '');
    // 修前 incrementalDiffAtHead 就是这两条参数。主线独立删掉的模块会进 changedFiles。
    expect(naive).toEqual(
      expect.arrayContaining([LAUNCHER_GO, LAUNCHER_YML, PACKAGE_JSON_PATH, 'shared.txt']),
    );
    expect(mainlineTouched).toEqual(expect.arrayContaining(['shared.txt', LAUNCHER_GO]));

    const diff = await incrementalDiffAtHead(bound());
    expect(diff.changedFiles).toEqual(AUTHOR_FILES);
    expect(diff.changedFiles).not.toContain(LAUNCHER_GO);
    expect(diff.changedFiles).not.toContain('verified.txt');
    expect(diff.diffText).toContain(`# 仓 acme/demo  PR #42  单 #12`);
    expect(diff.diffText).toContain(`# 旧验收头 ${fx.v1}`);
    expect(diff.diffText).toContain(`# 当前头 ${fx.merged}`);
    expect(diff.diffText).toContain(`# 可信主线 ${fx.m1}（refs/fleet/main）`);
    expect(diff.diffText).toContain(`# 记录的基线 ${fx.m0}（是旧基线，不用它拆归属）`);
    expect(diff.diffText).toContain('当前头含有这条主线尖');
    expect(diff.diffText).toContain('不要要求本单恢复主线已删除的模块');

    const author = between(diff.diffText, '# 本单返工', '# 主线同步');
    expect(author).toContain('occupancy.txt');
    expect(author).toContain('regression.txt');
    expect(author).toContain('new-bug');
    expect(author).toContain('+author-line-rewritten');
    expect(author).toContain('主线也改过、作者仍有分歧：shared.txt');
    expect(author).not.toContain('+mainline-line-moved');
    expect(author).not.toContain(LAUNCHER_GO);

    const context = between(diff.diffText, '# 主线同步', '# 当前 PR 相对当前头含有的主线的完整范围');
    expect(context).toContain(LAUNCHER_GO);
    expect(context).toContain(LAUNCHER_YML);
    expect(context).toContain(PACKAGE_JSON_PATH);
    expect(context).toContain('+mainline-line-moved');

    const guard = between(diff.diffText, '# 当前 PR 相对当前头含有的主线的完整范围');
    expect(guard).toContain('occupancy.txt');
    expect(guard).toContain('regression.txt');
    expect(guard).toContain('shared.txt');
    expect(guard).toContain('verified.txt');
    expect(guard).not.toContain('mirasim-launcher');

    const dest = join(fx.stateDir, 'head-checkout');
    await checkoutPrHead(dest, fx.merged, WORKFLOW_ID);
    expect(readFileSync(join(dest, 'occupancy.txt'), 'utf8')).toContain('round2');
    expect(readFileSync(join(dest, 'keep.txt'), 'utf8')).toBe('stable\n');
    expect(existsSync(join(dest, LAUNCHER_GO))).toBe(false);
  });

  it('变基到新主线后旧验收头不再是祖先：有可信主线仍只算本单返工，没有就失败', async () => {
    expect(await gitText(fx.bare, ['rev-parse', `${fx.rebased}^{tree}`])).toBe(
      await gitText(fx.bare, ['rev-parse', `${fx.merged}^{tree}`]),
    );
    await expect(
      incrementalDiffAtHead({ workflowId: WORKFLOW_ID, sinceSha: fx.v1, headSha: fx.rebased }),
    ).rejects.toThrow('没有可信主线就不能拆归属');
    const diff = await incrementalDiffAtHead(bound({ headSha: fx.rebased }));
    expect(diff.changedFiles).toEqual(AUTHOR_FILES);
    expect(diff.diffText).toContain('# 主线同步');
    expect(between(diff.diffText, '# 主线同步', '# 当前 PR')).toContain(LAUNCHER_GO);
    expect(diff.changedFiles).not.toContain(LAUNCHER_GO);
  });

  it('只同步主线、作者没有新返工：增量文件为空，正文仍留下主线同步和整张 PR 的范围', async () => {
    const diff = await incrementalDiffAtHead(bound({ headSha: fx.syncOnly }));
    expect(diff.changedFiles).toEqual([]);
    expect(diff.diffText.trim()).not.toBe('');
    expect(diff.diffText).toContain('没有还能证明是本单新增');
    expect(between(diff.diffText, '# 主线同步', '# 当前 PR')).toContain(LAUNCHER_GO);
    const guard = between(diff.diffText, '# 当前 PR 相对当前头含有的主线的完整范围');
    expect(guard).toContain('occupancy.txt');
    expect(guard).toContain('verified.txt');
    expect(guard).not.toContain('mirasim-launcher');
  });

  it('作者把主线已删文件按原字节加回，或改掉另一个已删文件：都不能按文件名放过', async () => {
    const naive = (await gitText(fx.bare, ['diff', '--name-only', '--no-ext-diff', `${fx.v1}..${fx.tamper}`]))
      .split('\n')
      .filter((line) => line !== '');
    expect(naive).not.toContain(LAUNCHER_GO);
    expect(naive).toEqual(expect.arrayContaining([LAUNCHER_YML, PACKAGE_JSON_PATH]));
    const diff = await incrementalDiffAtHead(bound({ headSha: fx.tamper }));
    expect(diff.changedFiles).toEqual([
      LAUNCHER_GO,
      'occupancy.txt',
      PACKAGE_JSON_PATH,
      'regression.txt',
      'shared.txt',
    ]);
    expect(diff.changedFiles).not.toContain(LAUNCHER_YML);
    const author = between(diff.diffText, '# 本单返工', '# 主线同步');
    expect(author).toContain(LAUNCHER_GO);
    expect(author).toContain(PACKAGE_JSON_PATH);
    expect(author).not.toContain(LAUNCHER_YML);
    const guard = between(diff.diffText, '# 当前 PR 相对当前头含有的主线的完整范围');
    expect(guard).toContain(LAUNCHER_GO);
    expect(guard).toContain(PACKAGE_JSON_PATH);
    expect(guard).not.toContain(LAUNCHER_YML);
  });

  it('当前头还没含主线尖：按头里真正有的那截拆，不把尖上的新文件算进本单', async () => {
    await setFetchedMainline(fx.bare, fx.m2);
    const diff = await incrementalDiffAtHead(bound({ mainlineSha: fx.m2 }));
    expect(diff.diffText).toContain(`# 可信主线 ${fx.m2}（refs/fleet/main）`);
    expect(diff.diffText).toContain(`# 当前头含有的主线 ${fx.m1}（当前头还没含主线尖，按两边的分叉点拆）`);
    expect(diff.changedFiles).toEqual(AUTHOR_FILES);
    expect(diff.diffText).not.toContain('later.txt');
    expect(diff.changedFiles).not.toContain(LAUNCHER_GO);
  });

  it('作者和主线把同一文件写成相同最终内容：仍算本单返工，补丁里有作者自己的字', async () => {
    const headBlob = await gitText(fx.bare, ['rev-parse', `${fx.coincided}:keep.txt`]);
    const mainBlob = await gitText(fx.bare, ['rev-parse', `${fx.mCoincide}:keep.txt`]);
    expect(headBlob).toBe(mainBlob);
    const newBlob = await gitText(fx.bare, ['rev-parse', `${fx.coincided}:coincide.txt`]);
    expect(newBlob).toBe(await gitText(fx.bare, ['rev-parse', `${fx.mCoincide}:coincide.txt`]));
    await setFetchedMainline(fx.bare, fx.mCoincide);
    const diff = await incrementalDiffAtHead(bound({ headSha: fx.coincided, mainlineSha: fx.mCoincide }));
    expect(diff.changedFiles).toEqual(['coincide.txt', 'keep.txt']);
    expect(diff.changedFiles).not.toContain(LAUNCHER_GO);
    expect(diff.changedFiles).not.toContain(LAUNCHER_YML);
    expect(diff.changedFiles).not.toContain('mainline-only.txt');
    expect(diff.changedFiles).not.toContain('shared.txt');
    const author = between(diff.diffText, '# 本单返工', '# 主线同步');
    expect(author).toContain('最终内容和主线一致，作者提交仍改过：coincide.txt、keep.txt');
    expect(author).toContain('author-only-line');
    expect(author).toContain('author-wrote-coincide');
    expect(author).not.toContain(LAUNCHER_GO);
    expect(author).not.toContain('only-mainline');
    const context = between(diff.diffText, '# 主线同步', '# 当前 PR 相对当前头含有的主线的完整范围');
    expect(context).toContain(LAUNCHER_GO);
    expect(context).toContain('mainline-only.txt');
    expect(context).toContain('only-mainline');
    expect(context).toContain('最终内容已和主线一致的路径上，主线自己的改动');
    expect(context).toContain('same-final');
    expect(context).not.toContain('author-only-line');
    expect(context).not.toContain('author-wrote-coincide');
    const guard = between(diff.diffText, '# 当前 PR 相对当前头含有的主线的完整范围');
    expect(guard).toContain('occupancy.txt');
    expect(guard).toContain('verified.txt');
    expect(guard).not.toContain('keep.txt');
    expect(guard).not.toContain('coincide.txt');
    const dest = join(fx.stateDir, 'coincide-checkout');
    await checkoutPrHead(dest, fx.coincided, WORKFLOW_ID);
    expect(readFileSync(join(dest, 'keep.txt'), 'utf8')).toBe('same-final\n');
    expect(readFileSync(join(dest, 'coincide.txt'), 'utf8')).toBe('same-final\n');
    expect(existsSync(join(dest, LAUNCHER_GO))).toBe(false);
  });

  it('只有主线把文件改成新内容、作者没动：最终 blob 相同仍只算主线同步', async () => {
    await setFetchedMainline(fx.bare, fx.mCoincide);
    const diff = await incrementalDiffAtHead(bound({ headSha: fx.coincideSync, mainlineSha: fx.mCoincide }));
    expect(diff.changedFiles).toEqual([]);
    expect(diff.diffText).toContain('没有还能证明是本单新增');
    const author = between(diff.diffText, '# 本单返工', '# 主线同步');
    expect(author).not.toContain('author-only-line');
    expect(author).not.toContain('keep.txt');
    const context = between(diff.diffText, '# 主线同步', '# 当前 PR 相对当前头含有的主线的完整范围');
    expect(context).toContain('keep.txt');
    expect(context).toContain('coincide.txt');
    expect(context).toContain('mainline-only.txt');
    expect(context).toContain(LAUNCHER_GO);
    expect(context).not.toContain('author-only-line');
  });

  it('合并或变基却没给可信主线：失败，不退回把主线删除算进本单的两头 diff', async () => {
    await expect(
      incrementalDiffAtHead({ workflowId: WORKFLOW_ID, sinceSha: fx.v1, headSha: fx.merged }),
    ).rejects.toThrow('没有可信主线就不能拆归属');
    await expect(
      incrementalDiffAtHead({ workflowId: WORKFLOW_ID, sinceSha: fx.v1, headSha: fx.rebased }),
    ).rejects.toThrow('没有可信主线就不能拆归属');
  });

  it('身份、对象、引用或历史对不上就抛，不回空 diff', async () => {
    const base = bound();
    const cases: { name: string; args: IncrementalDiffArgs; message: string; ref?: string | null }[] = [
      { name: '没绑 PR', args: omitKey(base, 'prNumber'), message: '增量归属没绑 PR' },
      { name: 'PR 号不是正整数', args: { ...base, prNumber: 0 }, message: '增量归属没绑 PR' },
      { name: '没绑单号', args: omitKey(base, 'issueNumber'), message: '增量归属没绑单号' },
      { name: '没绑仓', args: omitKey(base, 'repo'), message: '增量归属没绑仓' },
      {
        name: '仓对不上',
        args: { ...base, repo: { owner: 'other', name: 'demo' } },
        message: '增量归属的仓对不上',
      },
      { name: '单号对不上', args: { ...base, issueNumber: 99 }, message: '增量归属的单号对不上' },
      {
        name: '主线不是完整提交号',
        args: { ...base, mainlineSha: 'abc' },
        message: '可信主线要是完整提交号',
      },
      { name: '基线不是完整提交号', args: { ...base, baseSha: 'abc' }, message: '记录的基线要是完整提交号' },
      {
        name: '主线和引用不一致',
        args: { ...base, mainlineSha: fx.m0 },
        message: '给出的可信主线和镜像里的 refs/fleet/main 不一致',
      },
      {
        name: '引用不在',
        args: base,
        ref: null,
        message: '镜像里没有可信主线 refs/fleet/main',
      },
      {
        name: '没有旧验收头',
        args: { ...base, sinceSha: 'd'.repeat(40) },
        message: '镜像里没有旧验收头',
      },
      {
        name: '没有当前头',
        args: { ...base, headSha: 'e'.repeat(40) },
        message: '镜像里没有当前头',
      },
      {
        name: '没有记录的基线',
        args: { ...base, baseSha: 'f'.repeat(40) },
        message: '镜像里没有记录的基线',
      },
      {
        name: '基线不在主线上',
        args: { ...base, baseSha: fx.v1 },
        message: '记录的基线不在可信主线的历史上',
      },
      {
        name: '基线不在当前头上',
        args: { ...base, baseSha: fx.m2, mainlineSha: fx.m2 },
        ref: fx.m2,
        message: '记录的基线不在当前头的历史上',
      },
      {
        name: '历史被回退',
        args: { ...base, sinceSha: fx.merged, headSha: fx.v1 },
        message: '当前头是旧验收头的祖先，历史被回退改写了',
      },
      {
        name: '没有共同历史',
        args: { ...base, mainlineSha: fx.orphan },
        ref: fx.orphan,
        message: '当前头和可信主线没有共同历史',
      },
      {
        name: '合并的另一侧不是主线',
        args: { ...base, headSha: fx.bad },
        message: '的另一侧不在可信主线上，归属证明不了',
      },
    ];
    const failures: string[] = [];
    for (const item of cases) {
      if (item.ref === null) await deleteFetchedMainline(fx.bare);
      else if (item.ref !== undefined) await setFetchedMainline(fx.bare, item.ref);
      else await setFetchedMainline(fx.bare, fx.m1);
      try {
        const got = await incrementalDiffAtHead(item.args);
        failures.push(`${item.name}: 回了 diff（${got.changedFiles.join(',')}）`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(item.message)) failures.push(`${item.name}: ${message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
