// PR 头的完整检出、第 2 轮增量 diff：用临时镜像，不碰本机的引擎镜像。
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CheckoutBlockedAlert,
  type CheckoutRecovered,
  CheckoutStageError,
  checkoutAlertKey,
  checkoutBlockedAlert,
  checkoutPrHead,
  incrementalDiffAtHead,
  placeVerifyCheckout,
  VERIFY_CHECKOUT_FALLBACK,
} from '../src/cold-verify-run.ts';

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
    const dest = join(state, 'checkout');
    await checkoutPrHead(dest, head, 'task:acme/demo#12');
    expect(readFileSync(join(dest, 'hello.txt'), 'utf8')).toBe('hello\n');
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
    const placed = await placeVerifyCheckout({
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
    expect(logs).not.toContain(VERIFY_CHECKOUT_FALLBACK);
    expect(blocked).toEqual([]);
  });

  /** 真检出一遍，数 checkout 调了几次、repair 调了几次，收下报警。 */
  async function placeReal(dest: string, head: string, workflowId: string | undefined) {
    const calls: string[] = [];
    const repairs: string[] = [];
    const alerts: CheckoutBlockedAlert[] = [];
    const placed = await placeVerifyCheckout({
      dir: dest,
      head,
      workflowId,
      checkout: async (dir, headSha, flow) => {
        calls.push(dir);
        await checkoutPrHead(dir, headSha, flow);
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

  it.skipIf(process.getuid?.() === 0)('解包失败：归到解包那一步，原错保留，不修不重试', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const dest = join(state, 'co-extract');
    mkdirSync(dest, { recursive: true });
    chmodSync(dest, 0o555);
    try {
      const { placed, calls, repairs, alerts } = await placeReal(dest, head, 'task:acme/demo#12');
      expect(placed).toBe('blocked');
      expect(calls).toHaveLength(1);
      expect(repairs).toEqual([]);
      expect(alerts[0]?.stage).toBe('extract');
      expect(alerts[0]?.body).toContain('hello.txt');
      expect(alerts[0]?.body).not.toContain('mkdir');
    } finally {
      chmodSync(dest, 0o755);
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    '真 EACCES（上一层 555）：归到建目录，走既有修复，建议 mkdir',
    async () => {
      const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
      const parent = join(state, '_tmp');
      mkdirSync(parent, { recursive: true });
      chmodSync(parent, 0o555);
      try {
        const { placed, calls, repairs, alerts } = await placeReal(
          join(parent, 'verify-x'),
          head,
          'task:acme/demo#12',
        );
        expect(placed).toBe('blocked');
        expect(repairs).toEqual([join(parent, 'verify-x')]);
        expect(calls).toHaveLength(2);
        expect(alerts[0]?.stage).toBe('mkdir');
        expect(alerts[0]?.body).toContain('EACCES');
        expect(alerts[0]?.body).toContain('引擎用户要能在这一层下面 mkdir');
      } finally {
        chmodSync(parent, 0o755);
      }
    },
  );
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
