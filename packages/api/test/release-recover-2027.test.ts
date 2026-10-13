// 发版卡卡住、失败后的三个按钮（#2027，POST /france/release-recover）：重试、恢复引擎开关、撤掉暂停。
// 后端只核「现在能不能点」（进度记录、暂停标记、引擎总开关现算，不信页面）、记操作记录（谁、什么时候）、写请求文件；
// 接活的脚本那头在 deploy/test/release-request.test.mjs。
// 故意造出的失败（每条都核「没写请求文件、没记成功的操作记录」）：没有可点的（没卡住、卡在别的步、在走、没有暂停标记）、
// 上一份请求还没被接、接活单元没装、没接上、操作记录写不进、请求文件写不出、种类不对、没登录。
import { RELEASE_RECOVER_ACTION, ReleaseCardSchema, WEB_API_PREFIX } from '@fleet-dao/shared';
import type { MemoryData } from '@fleet-dao/store';
import { devFixtures } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 接活脚本是 .mjs（法国上 root 跑的），这里只拿它的 parseRequest 核「两头认同一个样子」
import { parseRequest } from '../../../deploy/france/release-request/lib.mjs';
import type { FranceReleasePort } from '../src/france-release.ts';
import type { ReleaseCardPort } from '../src/release-card.ts';
import { computeRecover } from '../src/release-card.ts';
import { type ReleaseRequestPort, recoverRequestText } from '../src/release-request.ts';
import { type Harness, harness, T0 } from './harness.ts';

const PATH = `${WEB_API_PREFIX}/france/release-recover`;
const CARD_PATH = `${WEB_API_PREFIX}/france/release-card`;
const SELF = {
  id: 'a0000000-0000-4000-8000-0000000000fd',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};
const HEAD = `2005b290${'a'.repeat(32)}`;
const LIVE = `6896b3cb${'b'.repeat(32)}`;
const AT = '2026-10-07T10:00:00.000Z';

function data(masterOn: boolean | null = null): Partial<MemoryData> {
  const d = devFixtures(T0);
  return {
    ...d,
    repos: [...(d.repos ?? []), SELF],
    ...(masterOn === null
      ? {}
      : {
          settings: [
            ...(d.settings ?? []),
            { key: 'engine.master', value: masterOn, version: 1, updatedAt: AT, updatedBy: 'u' },
          ],
        }),
  };
}

const card: ReleaseCardPort = {
  facts: {
    mainlineHead: async () => ({ sha: HEAD, title: '刷新耗时表 (#1230)', committedAt: AT }),
    commit: async (_r, sha) => ({ sha, title: '探针历史 (#1225)', committedAt: AT }),
    mainCi: async () => ({ state: 'green', detail: '' }),
    compare: async () => ({ status: 'ahead', aheadBy: 2, recent: [] }),
    lastMergedPull: async () => ({ number: 1230, title: 't', body: '', mergedAt: AT }),
    issueTitle: async (_r, n) => ({ number: n, title: '一张单' }),
  },
  deployed: () => ({ sha: LIVE }),
  deployedAt: async () => AT,
};

function request(over: Partial<ReleaseRequestPort> = {}): ReleaseRequestPort & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    receiverInstalled: async () => ({ ok: true }),
    pendingRequest: async () => false,
    readLast: async () => null,
    writeRequest: async (text) => {
      written.push(text);
    },
    ...over,
  };
}

/** 进度记录 + 暂停标记的替身。phase 是下标（3 等收尾、4 发版、7 恢复）。 */
function train(
  status: string | null,
  phase: number,
  opts: { marker?: boolean; beforeMaster?: boolean | null; why?: string } = {},
): FranceReleasePort {
  return {
    readStateFiles: async () => ({
      stateJson:
        status === null
          ? null
          : JSON.stringify({
              schema: 1,
              status,
              phase,
              why: opts.why ?? null,
              target: { kind: 'sha', value: HEAD },
              updatedAt: '2026-10-07T11:00:00.000Z',
              ...(opts.beforeMaster === undefined ? {} : { before: { master: opts.beforeMaster } }),
            }),
      marker: opts.marker ?? false,
    }),
  };
}

function setup(
  over: { request?: ReleaseRequestPort; france?: FranceReleasePort; masterOn?: boolean | null } = {},
) {
  const req = (over.request as ReturnType<typeof request> | undefined) ?? request();
  const h = harness({
    data: data(over.masterOn ?? null),
    releaseCard: card,
    releaseRequest: req,
    ...(over.france ? { franceRelease: over.france } : {}),
  });
  return { h, req };
}

async function post(h: Harness, body: unknown, opts: { login?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.login !== false) {
    const { cookie, csrf } = await h.login();
    headers.cookie = cookie;
    headers['x-csrf-token'] = csrf;
  }
  const res = await h.cockpit.request(PATH, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { error?: { code: string; message: string } } };
}

async function readCard(h: Harness) {
  const { cookie } = await h.login();
  const res = await h.cockpit.request(CARD_PATH, { headers: { cookie } });
  expect(res.status).toBe(200);
  return ReleaseCardSchema.parse(await res.json());
}

const recoverAudits = async (h: Harness) =>
  (await h.store.listAudit({ limit: 50 })).items.filter((a) =>
    (Object.values(RELEASE_RECOVER_ACTION) as string[]).includes(a.action),
  );

const STUCK = () => train('blocked', 3, { marker: true, beforeMaster: true, why: '等了 30 分钟' });
const RESTORE_FAILED = () => train('failed', 7, { marker: false, beforeMaster: true, why: '恢复没成' });

describe('发版卡 action.recover：三个按钮各自什么时候给', () => {
  it('卡在第 3 步等收尾：给「重试」（带目标提交）和「撤掉暂停」（还没动手发版：开回暂停前）', async () => {
    const { h } = setup({ france: STUCK() });
    const { recover } = (await readCard(h)).action;
    expect(recover?.retry).toMatchObject({ sha: HEAD });
    expect(recover?.restore).toBeNull();
    expect(recover?.abort?.outcome).toBe('reopen');
    expect(recover?.abort?.text).toContain('引擎总开关会开回暂停前的样子');
  });

  it('没成在第 7 步恢复、发版前开着、总开关还关着：给「恢复引擎开关」；总开关已经开着就不给', async () => {
    const off = await readCard(setup({ france: RESTORE_FAILED(), masterOn: false }).h);
    expect(off.action.recover?.restore).toMatchObject({ target: `提交 ${HEAD.slice(0, 12)}` });
    expect(off.action.recover?.retry).toBeNull();
    expect(off.action.recover?.abort).toBeNull(); // 标记已经清了
    const on = await readCard(setup({ france: RESTORE_FAILED(), masterOn: true }).h);
    expect(on.action.recover?.restore).toBeNull();
  });

  it('暂停标记留着、进度记录不在（或做完了、撤销了）：只给「撤掉暂停」，写明只清标记、总开关不动', async () => {
    for (const status of [null, 'done', 'aborted']) {
      const { h } = setup({ france: train(status, 8, { marker: true }) });
      const { recover } = (await readCard(h)).action;
      expect(recover?.abort, String(status)).toMatchObject({ outcome: 'clear_marker' });
      expect(recover?.abort?.text).toContain('引擎总开关不动');
      expect(recover?.retry).toBeNull();
      expect(recover?.restore).toBeNull();
    }
  });

  it('已动手发过版（第 4 步起）停下又留着标记：「撤掉暂停」写明保持关（遵守「已动手发过版就保持关」）', async () => {
    const { h } = setup({ france: train('failed', 5, { marker: true, beforeMaster: true }) });
    const { recover } = (await readCard(h)).action;
    expect(recover?.abort).toMatchObject({ outcome: 'keep_off' });
    expect(recover?.abort?.text).toContain('保持关');
    expect(recover?.retry).toBeNull();
  });

  it('【故意造出的失败】在走、上一份请求还没被接、进度记录读不到：一个按钮都不给', async () => {
    const running = await readCard(
      setup({ france: train('running', 3, { marker: true, beforeMaster: true }) }).h,
    );
    expect(running.action.recover).toEqual({ retry: null, restore: null, abort: null });
    const pending = await readCard(
      setup({ france: STUCK(), request: request({ pendingRequest: async () => true }) }).h,
    );
    expect(pending.action.recover).toEqual({ retry: null, restore: null, abort: null });
    const down = await readCard(
      setup({
        france: {
          readStateFiles: async () => {
            throw new Error('EACCES');
          },
        },
      }).h,
    );
    expect(down.action.recover).toEqual({ retry: null, restore: null, abort: null });
  });

  it('computeRecover：卡在别的步（不是第 3 步）不给重试；发版前总开关是关着的不给恢复', () => {
    const ok = (over: Record<string, unknown>) =>
      ({
        ok: true,
        status: 'blocked',
        phase: '第 5 步「等部署」',
        phaseIndex: 5,
        beforeMaster: true,
        target: `提交 ${HEAD.slice(0, 12)}`,
        targetSha: HEAD,
        why: null,
        updatedAt: null,
        timeline: null,
        ...over,
      }) as never;
    expect(computeRecover({ train: ok({}), marker: false, pending: false }, null).retry).toBeNull();
    expect(
      computeRecover(
        {
          train: ok({ status: 'failed', phaseIndex: 7, beforeMaster: false }),
          marker: false,
          pending: false,
        },
        false,
      ).restore,
    ).toBeNull();
    expect(
      computeRecover({ train: ok({ status: 'failed', phaseIndex: 7 }), marker: false, pending: false }, null)
        .restore,
    ).not.toBeNull();
  });
});

describe('POST /france/release-recover：点三个按钮', () => {
  it('重试：写 kind retry 带卡住那一趟的目标，记一条 release.retry（谁、什么时候、原话），接活脚本认得', async () => {
    const { h, req } = setup({ france: STUCK() });
    const r = await post(h, { kind: 'retry' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ requested: true, kind: 'retry', at: T0.toISOString() });
    expect(req.written).toHaveLength(1);
    expect(parseRequest(req.written[0])).toMatchObject({
      ok: true,
      kind: 'retry',
      sha: HEAD,
      at: T0.toISOString(),
    });
    const [a] = await recoverAudits(h);
    expect(a).toMatchObject({
      action: 'release.retry',
      target: `commit:${HEAD.slice(0, 12)}`,
      ok: true,
      reason: '驾驶舱点击重试（创始人）',
    });
    expect(a?.actor).toBeDefined();
    expect(a?.after).toMatchObject({ kind: 'retry', sha: HEAD });
    expect(a?.at).toBeTruthy();
  });

  it('恢复引擎开关：写 kind restore（不带提交号），记一条 release.restore', async () => {
    const { h, req } = setup({ france: RESTORE_FAILED(), masterOn: false });
    const r = await post(h, { kind: 'restore' });
    expect(r.status).toBe(200);
    expect(parseRequest(req.written[0])).toMatchObject({ ok: true, kind: 'restore', sha: null });
    expect(JSON.parse(req.written[0] ?? '')).not.toHaveProperty('sha');
    const [a] = await recoverAudits(h);
    expect(a).toMatchObject({
      action: 'release.restore',
      ok: true,
      reason: '驾驶舱点击恢复引擎开关（创始人）',
    });
  });

  it('撤掉暂停：写 kind abort，记一条 release.abort', async () => {
    const { h, req } = setup({ france: train(null, 0, { marker: true }) });
    const r = await post(h, { kind: 'abort' });
    expect(r.status).toBe(200);
    expect(parseRequest(req.written[0])).toMatchObject({ ok: true, kind: 'abort' });
    const [a] = await recoverAudits(h);
    expect(a).toMatchObject({ action: 'release.abort', ok: true, reason: '驾驶舱点击撤掉暂停（创始人）' });
  });

  for (const [kind, france, masterOn] of [
    ['retry', train('done', 8, { marker: false }), null],
    ['retry', train('blocked', 5, { marker: true, beforeMaster: true }), null],
    ['restore', train('failed', 7, { beforeMaster: true }), true],
    ['restore', train('failed', 5, { beforeMaster: true }), false],
    ['abort', train(null, 0, { marker: false }), null],
    ['abort', train('running', 3, { marker: true, beforeMaster: true }), null],
  ] as const) {
    it(`【故意造出的失败】现在没有可点的「${kind}」：409 recover_unavailable，没写、没记`, async () => {
      const { h, req } = setup({ france, masterOn });
      const r = await post(h, { kind });
      expect(r.status).toBe(409);
      expect(r.body.error?.code).toBe('recover_unavailable');
      expect(req.written).toEqual([]);
      expect(await recoverAudits(h)).toEqual([]);
    });
  }

  it('【故意造出的失败】种类不对、没带种类、没登录：400 / 401，没写、没记', async () => {
    for (const body of [{ kind: 'purge' }, {}, { kind: 'release' }]) {
      const { h, req } = setup({ france: STUCK() });
      expect((await post(h, body)).status).toBe(400);
      expect(req.written).toEqual([]);
    }
    const { h, req } = setup({ france: STUCK() });
    expect((await post(h, { kind: 'retry' }, { login: false })).status).toBe(401);
    expect(req.written).toEqual([]);
    expect(await recoverAudits(h)).toEqual([]);
  });

  it('【故意造出的失败】上一份请求还没被接走：409（读按钮时就不给）；接活单元没装：409 receiver_missing', async () => {
    const a = setup({ france: STUCK(), request: request({ pendingRequest: async () => true }) });
    expect((await post(a.h, { kind: 'retry' })).status).toBe(409);
    expect((a.req as ReturnType<typeof request>).written).toEqual([]);
    const b = setup({
      france: STUCK(),
      request: request({ receiverInstalled: async () => ({ ok: false, why: '法国还没装发版接活单元' }) }),
    });
    const rb = await post(b.h, { kind: 'retry' });
    expect(rb.status).toBe(409);
    expect(rb.body.error?.code).toBe('receiver_missing');
    expect((b.req as ReturnType<typeof request>).written).toEqual([]);
  });

  it('【故意造出的失败】这台后端没接上发布请求（开发、内存版）：503，不当成成功', async () => {
    const h = harness({ data: data(), releaseCard: card, franceRelease: STUCK() });
    expect((await post(h, { kind: 'retry' })).status).toBe(503);
  });

  it('【故意造出的失败】请求文件写不出：502，补一条 ok=false 的记录；EEXIST（刚被别人写了一份）：409', async () => {
    const a = setup({
      france: STUCK(),
      request: request({
        writeRequest: async () => {
          throw new Error('disk full');
        },
      }),
    });
    const ra = await post(a.h, { kind: 'retry' });
    expect(ra.status).toBe(502);
    const audits = await recoverAudits(a.h);
    expect(audits.map((x) => x.ok)).toEqual([false, true]);
    expect(audits[0]?.error).toContain('disk full');

    const b = setup({
      france: STUCK(),
      request: request({
        writeRequest: async () => {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        },
      }),
    });
    const rb = await post(b.h, { kind: 'retry' });
    expect(rb.status).toBe(409);
    expect(rb.body.error?.code).toBe('request_pending');
  });

  it('请求文本：重试带提交号、恢复和撤掉不带；老样子的发布请求（不带 kind）接活脚本照样当发布', () => {
    expect(recoverRequestText('retry', HEAD, AT, '创始人')).toBe(
      `{"v":1,"kind":"retry","sha":"${HEAD}","at":"${AT}","by":"创始人"}\n`,
    );
    expect(recoverRequestText('restore', null, AT, '创始人')).toBe(
      `{"v":1,"kind":"restore","at":"${AT}","by":"创始人"}\n`,
    );
    expect(parseRequest(`{"v":1,"sha":"${HEAD}","at":"${AT}","by":"创始人"}`)).toMatchObject({
      ok: true,
      kind: 'release',
    });
  });
});
