// POST /api/france/release 和发版卡里的「发布到法国」按钮状态（#1232）：后端只收提交号、核它等于此刻主线头、记操作记录、写请求文件，
// 自己不起任何带 root 的进程（法国上 root 的 path 单元接活，deploy/test/release-request.test.mjs 测那一头）。
// 故意造出的失败（每条都核「没写请求文件、没记成功的操作记录」）：提交号不是 40 位、不是此刻主线头、CI 红 / 在跑 / 读不到、
// 法国已经是最新、已有发版在走、上一份请求还没被接、接活单元没装、没接上、操作记录写不进、请求文件写不出、没登录、没带 CSRF。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReleaseFactsReader } from '@fleet-dao/github';
import { RELEASE_REQUEST_ACTION, ReleaseCardSchema, WEB_API_PREFIX } from '@fleet-dao/shared';
import type { MemoryData } from '@fleet-dao/store';
import { devFixtures } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 接活脚本是 .mjs（法国上 root 跑的），这里只拿它的 parseRequest 核「两头认同一个样子」
import { parseRequest } from '../../../deploy/france/release-request/lib.mjs';
import type { FranceReleasePort } from '../src/france-release.ts';
import type { ReleaseCardPort } from '../src/release-card.ts';
import {
  liveReleaseRequestPort,
  type ReleaseRequestPort,
  requestBy,
  requestText,
} from '../src/release-request.ts';
import { type Harness, harness, T0 } from './harness.ts';

const POST_PATH = `${WEB_API_PREFIX}/france/release`;
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

function withSelf(): Partial<MemoryData> {
  const data = devFixtures(T0);
  return { ...data, repos: [...(data.repos ?? []), SELF] };
}

function facts(over: Partial<ReleaseFactsReader> = {}): ReleaseFactsReader {
  return {
    mainlineHead: async () => ({ sha: HEAD, title: '刷新耗时表 (#1230)', committedAt: AT }),
    commit: async (_r, sha) => ({ sha, title: '探针历史 (#1225)', committedAt: AT }),
    mainCi: async () => ({ state: 'green', detail: '' }),
    compare: async () => ({
      status: 'ahead',
      aheadBy: 2,
      recent: [{ sha: 'c1', title: '刷新耗时表 (#1230)' }],
    }),
    lastMergedPull: async () => ({ number: 1230, title: 't', body: 'Closes #1192', mergedAt: AT }),
    issueTitle: async (_r, n) => ({ number: n, title: '一张单' }),
    ...over,
  };
}

function card(over: Partial<ReleaseFactsReader> = {}, deployed: string | null = LIVE): ReleaseCardPort {
  return { facts: facts(over), deployed: () => ({ sha: deployed }), deployedAt: async () => AT };
}

/** 请求端口的替身：记下写出去的请求文本；默认装好了、没有在等的请求、没有最近结果。 */
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

const idle: FranceReleasePort = {
  readStateFiles: async () => ({ stateJson: null, marker: false }),
  runPreflight: async () => {
    throw new Error('不该起预检');
  },
};
const trainState = (status: string, extra: Record<string, unknown> = {}): FranceReleasePort => ({
  ...idle,
  readStateFiles: async () => ({
    stateJson: JSON.stringify({
      schema: 1,
      phase: 4,
      status,
      target: { kind: 'sha', value: HEAD },
      updatedAt: '2026-10-07T11:00:00.000Z',
      ...extra,
    }),
    marker: false,
  }),
});

function setup(
  over: { card?: ReleaseCardPort; request?: ReleaseRequestPort; france?: FranceReleasePort | null } = {},
) {
  const req = (over.request as ReturnType<typeof request> | undefined) ?? request();
  const h = harness({
    data: withSelf(),
    releaseCard: over.card ?? card(),
    releaseRequest: req,
    ...(over.france === null ? {} : { franceRelease: over.france ?? idle }),
  });
  return { h, req };
}

async function post(h: Harness, body: unknown, opts: { csrf?: boolean; login?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.login !== false) {
    const { cookie, csrf } = await h.login();
    headers.cookie = cookie;
    if (opts.csrf !== false) headers['x-csrf-token'] = csrf;
  }
  const res = await h.cockpit.request(POST_PATH, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { error?: { code: string; message: string } } };
}

async function readCard(h: Harness) {
  const { cookie } = await h.login();
  const res = await h.cockpit.request(CARD_PATH, { headers: { cookie } });
  expect(res.status).toBe(200);
  return ReleaseCardSchema.parse(await res.json());
}

const audits = async (h: Harness) =>
  (await h.store.listAudit({ limit: 50 })).items.filter((a) => a.action === RELEASE_REQUEST_ACTION);

describe('POST /france/release：点「确认发布」', () => {
  it('提交号等于此刻主线头、CI 绿、装了、没有发版在走：写一份请求文件、记一条操作记录（谁、哪个提交、原话），回 requested', async () => {
    const { h, req } = setup();
    const r = await post(h, { sha: HEAD });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ requested: true, sha: HEAD, at: T0.toISOString() });
    expect(req.written).toHaveLength(1);
    // 请求文件的样子固定，接活脚本认得
    const parsed = parseRequest(req.written[0]);
    expect(parsed).toMatchObject({ ok: true, sha: HEAD, at: T0.toISOString() });
    const [a] = await audits(h);
    expect(a).toMatchObject({
      action: 'release.request',
      target: `commit:${HEAD.slice(0, 12)}`,
      ok: true,
      reason: '驾驶舱点击发布（创始人）',
    });
    expect(a?.after).toMatchObject({ sha: HEAD, title: '刷新耗时表 (#1230)' });
  });

  it('【故意造出的失败】提交号不是完整 40 位：400，没写、没记', async () => {
    for (const sha of ['abc123', HEAD.slice(0, 39), HEAD.toUpperCase(), `${HEAD}a`, '']) {
      const { h, req } = setup();
      const r = await post(h, { sha });
      expect(r.status, sha).toBe(400);
      expect(req.written).toEqual([]);
      expect(await audits(h)).toEqual([]);
    }
    const { h, req } = setup();
    expect((await post(h, {})).status).toBe(400);
    expect(req.written).toEqual([]);
  });

  it('【故意造出的失败】不是此刻主线头（页面上看到的头在点之前换了）：409 not_head，不替人改发新的', async () => {
    const { h, req } = setup();
    const r = await post(h, { sha: 'c'.repeat(40) });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('not_head');
    expect(r.body.error?.message).toContain(HEAD.slice(0, 12));
    expect(req.written).toEqual([]);
    expect(await audits(h)).toEqual([]);
  });

  it('【故意造出的失败】读不到主线头：409，不当成对得上', async () => {
    const { h, req } = setup({
      card: card({
        mainlineHead: async () => {
          throw new Error('GitHub 502');
        },
      }),
    });
    const r = await post(h, { sha: HEAD });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('head_unreadable');
    expect(req.written).toEqual([]);
  });

  for (const [name, mainCi, needle] of [
    ['红', async () => ({ state: 'red' as const, detail: 'failure：单测红' }), '主线 CI 不是绿的（红）'],
    [
      '还在跑',
      async () => ({ state: 'pending' as const, detail: '汇总检查还在跑' }),
      '主线 CI 不是绿的（还在跑）',
    ],
    [
      '读不到',
      async (): Promise<never> => {
        throw new Error('403');
      },
      '主线 CI 没读到',
    ],
  ] as const) {
    it(`【故意造出的失败】主线 CI ${name}：409，原因写明，没写、没记`, async () => {
      const { h, req } = setup({ card: card({ mainCi }) });
      const r = await post(h, { sha: HEAD });
      expect(r.status).toBe(409);
      expect(r.body.error?.message).toContain(needle);
      expect(req.written).toEqual([]);
      expect(await audits(h)).toEqual([]);
    });
  }

  it('【故意造出的失败】法国已经是最新（在用的就是主线头）：409，不发', async () => {
    const { h, req } = setup({ card: card({}, HEAD) });
    const r = await post(h, { sha: HEAD });
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toContain('已经是最新');
    expect(req.written).toEqual([]);
  });

  it('【故意造出的失败】已有发版在走（进度记录说在走）：409；上一份请求还没被接：409', async () => {
    const a = setup({ france: trainState('running') });
    const ra = await post(a.h, { sha: HEAD });
    expect(ra.status).toBe(409);
    expect(ra.body.error?.message).toContain('已有发版在走');
    expect(a.req.written).toEqual([]);
    const b = setup({ request: request({ pendingRequest: async () => true }) });
    const rb = await post(b.h, { sha: HEAD });
    expect(rb.status).toBe(409);
    expect(rb.body.error?.message).toContain('还没被法国接走');
    expect((b.req as ReturnType<typeof request>).written).toEqual([]);
  });

  it('上一趟卡住、没成、做完了：不算在走，可以再发', async () => {
    for (const status of ['blocked', 'failed', 'done', 'aborted']) {
      const { h, req } = setup({ france: trainState(status) });
      expect((await post(h, { sha: HEAD })).status, status).toBe(200);
      expect(req.written).toHaveLength(1);
    }
  });

  it('【故意造出的失败】进度记录读不到 / 认不出：不当成没发版在走，409', async () => {
    const down: FranceReleasePort = {
      ...idle,
      readStateFiles: async () => {
        throw new Error('EACCES');
      },
    };
    const a = setup({ france: down });
    const ra = await post(a.h, { sha: HEAD });
    expect(ra.status).toBe(409);
    expect(ra.body.error?.message).toContain('EACCES');
    const b = setup({ france: null });
    expect((await post(b.h, { sha: HEAD })).status).toBe(409);
    expect(b.req.written).toEqual([]);
  });

  it('【故意造出的失败】法国还没装接活单元：409 receiver_missing，写明「法国还没装发版接活单元」', async () => {
    const { h, req } = setup({
      request: request({
        receiverInstalled: async () => ({
          ok: false,
          why: '法国还没装发版接活单元（缺 /etc/systemd/system/fleet-release-request.path）',
        }),
      }),
    });
    const r = await post(h, { sha: HEAD });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('receiver_missing');
    expect(r.body.error?.message).toContain('法国还没装发版接活单元');
    expect((req as ReturnType<typeof request>).written).toEqual([]);
  });

  it('【故意造出的失败】这台后端没接上发布请求（开发、内存版）：503', async () => {
    const h = harness({ data: withSelf(), releaseCard: card() });
    const r = await post(h, { sha: HEAD });
    expect(r.status).toBe(503);
    expect(r.body.error?.code).toBe('release_not_wired');
  });

  it('【故意造出的失败】操作记录写不进：先记后做，请求文件不写', async () => {
    const { h, req } = setup();
    const { cookie, csrf } = await h.login(); // 登录自己也记操作记录：先登录，再让记录写不进
    h.store.appendAudit = async () => {
      throw new Error('库连不上');
    };
    const res = await h.cockpit.request(POST_PATH, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ sha: HEAD }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(req.written).toEqual([]);
  });

  it('【故意造出的失败】请求文件写不出：502，补一条 ok=false 的操作记录；已经有一份（EEXIST）：409', async () => {
    const a = setup({
      request: request({
        writeRequest: async () => {
          throw new Error('EROFS: read-only file system');
        },
      }),
    });
    const ra = await post(a.h, { sha: HEAD });
    expect(ra.status).toBe(502);
    expect(ra.body.error?.code).toBe('request_not_written');
    expect((await audits(a.h)).map((x) => x.ok)).toEqual([false, true]);
    expect((await audits(a.h))[0]?.error).toContain('EROFS');
    const b = setup({
      request: request({
        writeRequest: async () => {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        },
      }),
    });
    const rb = await post(b.h, { sha: HEAD });
    expect(rb.status).toBe(409);
    expect(rb.body.error?.code).toBe('request_pending');
    expect((await audits(b.h)).map((x) => x.ok)).toEqual([false, true]);
  });

  it('【故意造出的失败】没登录：401；没带 CSRF：403；都没写', async () => {
    const { h, req } = setup();
    expect((await post(h, { sha: HEAD }, { login: false })).status).toBe(401);
    expect((await post(h, { sha: HEAD }, { csrf: false })).status).toBe(403);
    expect(req.written).toEqual([]);
    expect(await audits(h)).toEqual([]);
  });
});

describe('发版卡里的 action（按钮状态）', () => {
  it('全齐：ready，没有原因，installed', async () => {
    const { h } = setup();
    const c = await readCard(h);
    expect(c.action).toMatchObject({ state: 'ready', reasons: [], installed: true });
    expect(c.action.last.state).toBe('none');
  });

  it('没装接活单元：blocked、installed=false、原因写「法国还没装发版接活单元」', async () => {
    const { h } = setup({
      request: request({
        receiverInstalled: async () => ({ ok: false, why: '法国还没装发版接活单元（缺 x）' }),
      }),
    });
    const c = await readCard(h);
    expect(c.action.state).toBe('blocked');
    expect(c.action.installed).toBe(false);
    expect(c.action.reasons.join()).toContain('法国还没装发版接活单元');
  });

  it('没接上发布请求（开发、内存版）：blocked 并写没接上', async () => {
    const h = harness({ data: withSelf(), releaseCard: card() });
    const c = await readCard(h);
    expect(c.action).toMatchObject({ state: 'blocked', installed: false });
    expect(c.action.reasons[0]).toContain('没接上');
  });

  it('CI 红、已有发版在走、已是最新：各自写原因，可以同时有几条', async () => {
    const { h } = setup({
      card: card({ mainCi: async () => ({ state: 'red', detail: 'failure' }) }, HEAD),
      france: trainState('running'),
    });
    const c = await readCard(h);
    expect(c.action.state).toBe('blocked');
    const text = c.action.reasons.join('；');
    expect(text).toContain('主线 CI 不是绿的（红）');
    expect(text).toContain('已有发版在走');
    expect(text).toContain('已经是最新');
    expect(c.action.last).toMatchObject({ state: 'running', phase: expect.stringContaining('发版') });
  });

  it('读不到的一律按不能点：法国在用的提交读不到、读上一份请求失败', async () => {
    const a = setup({ card: { ...card(), deployed: () => ({ error: 'EACCES' }) } });
    const ca = await readCard(a.h);
    expect(ca.action.state).toBe('blocked');
    expect(ca.action.reasons.join()).toContain('法国在用的提交没读到');
    const b = setup({
      request: request({
        pendingRequest: async () => {
          throw new Error('EIO');
        },
      }),
    });
    const cb = await readCard(b.h);
    expect(cb.action.state).toBe('blocked');
    expect(cb.action.last).toMatchObject({ state: 'unreadable' });
    expect(cb.action.last.why).toContain('EIO');
  });

  it('最近一次的结果：请求等着 pending；root 拒了 refused（比进度记录新才算）；否则看进度记录；做完了 done', async () => {
    const pending = await readCard(setup({ request: request({ pendingRequest: async () => true }) }).h);
    expect(pending.action.last.state).toBe('pending');

    const refusedText = JSON.stringify({
      v: 1,
      outcome: 'refused',
      at: '2026-10-07T11:30:00.000Z',
      sha: HEAD,
      why: '这个提交的 CI 不是绿的（red）',
    });
    const refusedNewer = await readCard(
      setup({ request: request({ readLast: async () => refusedText }), france: trainState('done') }).h,
    );
    expect(refusedNewer.action.last).toMatchObject({
      state: 'refused',
      why: '这个提交的 CI 不是绿的（red）',
    });

    const refusedOlder = await readCard(
      setup({
        request: request({
          readLast: async () => refusedText.replace('2026-10-07T11:30', '2026-10-07T10:30'),
        }),
        france: trainState('done'),
      }).h,
    );
    expect(refusedOlder.action.last.state).toBe('done');
  });

  it('做完了：最近一次写 done，按钮仍受「已是最新」之类原因管，引擎总开关由页面提示创始人去开', async () => {
    const c = await readCard(setup({ france: trainState('done') }).h);
    expect(c.action.last).toMatchObject({ state: 'done', target: expect.stringContaining('提交') });
  });
});

describe('小零件', () => {
  it('requestText 写出的和接活脚本认的是同一个样子；谁点的只留合规的字', () => {
    const text = requestText(HEAD, AT, requestBy('创始人 <b>"x"</b>'));
    expect(parseRequest(text)).toMatchObject({ ok: true, sha: HEAD, by: '创始人 bxb' });
    expect(requestBy('!!!')).toBe('founder');
    expect(requestBy('x'.repeat(100))).toHaveLength(64);
    expect(requestText(HEAD, AT, 'a').startsWith('{"v":1,"sha":')).toBe(true);
  });

  it('真 port：装没装看单元文件、脚本副本、请求目录三样；写请求文件已有一份就 EEXIST，不盖掉；last 没有回 null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-port-'));
    try {
      const dir = join(root, 'req');
      const train = join(root, 'train');
      const unit = join(root, 'unit.path');
      const script = join(root, 'script.mjs');
      const port = liveReleaseRequestPort(dir, train, { unit, script });
      const none = await port.receiverInstalled();
      expect(none.ok).toBe(false);
      if (!none.ok) expect(none.why).toContain('法国还没装发版接活单元');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(dir);
      mkdirSync(train);
      writeFileSync(unit, '');
      expect((await port.receiverInstalled()).ok).toBe(false); // 还缺脚本副本
      writeFileSync(script, '');
      expect((await port.receiverInstalled()).ok).toBe(true);
      expect(await port.pendingRequest()).toBe(false);
      expect(await port.readLast()).toBeNull();
      await port.writeRequest('一份\n');
      expect(readFileSync(join(dir, 'request.json'), 'utf8')).toBe('一份\n');
      expect(await port.pendingRequest()).toBe(true);
      await expect(port.writeRequest('第二份\n')).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readFileSync(join(dir, 'request.json'), 'utf8')).toBe('一份\n');
      writeFileSync(join(train, 'last-request.json'), '{"x":1}');
      expect(await port.readLast()).toBe('{"x":1}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
