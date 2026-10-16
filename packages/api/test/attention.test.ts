// fleet-api attention --json（#2370）：现在要人看的事一份结论。该推的通知用 feishu-push.ts 的 feishuPushableSince 判，
// 推送不通、简报没到用 db 里的 feishuPushProblem、dailyBriefProblem；这里管命令这一层（真 Postgres：PGlite）。
import { notificationDeliveries, upsertAlert } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTENTION_USAGE,
  attentionJson,
  parseAttentionArgs,
  readHealthz,
  runAttention,
} from '../src/attention-cli.ts';
import { runCli } from '../src/cli.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const GREEN = async () => ({ code: 200, red: [] as string[] });
const add = (key: string, level: 'decision' | 'alert' | 'daily', title = key) =>
  upsertAlert(t.db, { dedupeKey: key, level, taskId: null, title, body: '', link: '/x' });

describe('fleet-api attention', () => {
  it('参数：只认 --json', () => {
    expect(() => parseAttentionArgs(['--json'])).not.toThrow();
    expect(() => parseAttentionArgs([])).toThrow(/--json/);
    expect(() => parseAttentionArgs(['--json', 'x'])).toThrow(ATTENTION_USAGE);
  });

  it('notes：只列开着且按白名单到点该推的（要你拍马上；挂起和发布落后满 120 分钟；其余不列）', async () => {
    await add('d1', 'decision', '要拍');
    await add('task:acme/fleet#1:park:1', 'alert', '挂起');
    await add('deploy-lag:fleet', 'alert', '落后');
    await add('task-stuck:1', 'alert', '单卡住');
    await add('watchdog:job:hourly', 'alert', '任务看门狗');
    await add('watchdog:red:x', 'alert', '红');
    await add('quota-read:grok', 'alert', '额度');
    await add('reconcile:quota:x', 'alert', '对账额度');
    await add('remind:d1', 'alert', '再提醒');
    await add('probe-iq:x', 'alert', '降智');
    await add('release:done:abc', 'daily', '发版成功');
    const now = new Date();
    const soon = await runAttention({ db: t.db, now: () => now, healthz: GREEN });
    expect(soon.notes.map((n) => n.key)).toEqual(['d1']);
    expect(soon.notes[0]).toMatchObject({ level: 'decision', title: '要拍', delivered: false });
    const later = await runAttention({
      db: t.db,
      now: () => new Date(now.getTime() + 121 * 60_000),
      healthz: GREEN,
    });
    expect(later.notes.map((n) => n.key)).toEqual(['d1', 'task:acme/fleet#1:park:1', 'deploy-lag:fleet']);
  });

  it('delivered：团队群那条送达记录有 delivered_at 才算送到；撤了的不再列', async () => {
    const { id } = await add('d1', 'decision');
    await add('d2', 'decision');
    await t.db.insert(notificationDeliveries).values({
      notificationId: id,
      channel: 'feishu',
      target: 'team',
      messageId: 'om_1',
      attempts: 1,
      lastAttemptAt: new Date(),
      deliveredAt: new Date(),
    });
    const r = await runAttention({ db: t.db, now: () => new Date(), healthz: GREEN });
    expect(r.notes.map((n) => [n.key, n.delivered])).toEqual([
      ['d1', true],
      ['d2', false],
    ]);
  });

  it('主线已恢复不列，哪怕之前真推出去过主线红；主线红开满 60 分钟才列', async () => {
    const now = new Date();
    const { id } = await add('feishu:main-red:1', 'daily', '主线红了');
    await add('feishu:main-recovered:1', 'daily', '主线恢复了');
    await t.db.insert(notificationDeliveries).values({
      notificationId: id,
      channel: 'feishu',
      target: 'team',
      messageId: 'om_red',
      attempts: 1,
      lastAttemptAt: now,
      deliveredAt: now,
    });
    const soon = await runAttention({ db: t.db, now: () => now, healthz: GREEN });
    expect(soon.notes).toEqual([]);
    const later = await runAttention({
      db: t.db,
      now: () => new Date(now.getTime() + 61 * 60_000),
      healthz: GREEN,
    });
    expect(later.notes.map((n) => n.key)).toEqual(['feishu:main-red:1']);
  });

  it('飞书推送不通、今天的简报没到：就是 db 里两个判法的结论，通着好着是 null', async () => {
    const day = new Date('2099-01-01T02:00:00Z'); // 北京 10:00，已过 09:00
    const r = await runAttention({ db: t.db, now: () => day, healthz: GREEN });
    expect(r.dailyBriefProblem).toContain('每日简报没跑');
    expect(r.feishuPushProblem).toBeNull();
    const early = await runAttention({
      db: t.db,
      now: () => new Date('2099-01-01T00:10:00Z'),
      healthz: GREEN,
    });
    expect(early.dailyBriefProblem).toBeNull();
  });

  it('【故意造出的失败】推送没配：feishuPushProblem 写没配', async () => {
    const { writeFeishuPushStatus } = await import('@fleet-dao/db');
    await writeFeishuPushStatus(t.db, { configured: false, why: '缺凭据', at: new Date() });
    const r = await runAttention({ db: t.db, now: () => new Date(), healthz: GREEN });
    expect(r.feishuPushProblem).toContain('飞书推送没配：缺凭据');
  });

  it('readHealthz：200 无红；503 列出 ok:false 的检查；连不上是 0', async () => {
    const reply = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    expect(
      await readHealthz('http://x/healthz', reply(200, { ok: true, checks: { database: { ok: true } } })),
    ).toEqual({
      code: 200,
      red: [],
    });
    expect(
      await readHealthz(
        'http://x/healthz',
        reply(503, {
          ok: false,
          checks: { database: { ok: false }, engine: { ok: true }, temporal: { ok: false } },
        }),
      ),
    ).toEqual({ code: 503, red: ['database', 'temporal'] });
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(await readHealthz('http://x/healthz', boom)).toEqual({ code: 0, red: [] });
  });

  it('attentionJson：打一行 JSON；没配 FLEET_COCKPIT_LISTEN 时 healthz 是 0（连不上），不是 200', async () => {
    const r = await attentionJson({ db: t.db, now: () => new Date(), env: {} });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.text);
    expect(j).toMatchObject({ ok: true, healthz: { code: 0, red: [] }, notes: [] });
  });

  it('【故意造出的失败】读库报错：ok:false、退出码 1，不拿空列表顶', async () => {
    const gone = await createTestDb();
    await gone.close();
    const r = await attentionJson({ db: gone.db, now: () => new Date(), env: {} });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, why: expect.stringMatching(/.+/) });
  });

  it('fleet-api attention 命令：参数不对退出码 2、没带库连接退出码 1，都打一行 JSON；--help 列用法', async () => {
    const out: string[] = [];
    const deps = {
      env: {},
      out: (s: string) => out.push(s),
      err: (s: string) => out.push(s),
      now: () => new Date(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: 只用到 env、out、err、now
    expect(await runCli(['attention'], deps as any)).toBe(2);
    expect(JSON.parse(out.at(-1) ?? '')).toMatchObject({ ok: false, reason: 'usage' });
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    expect(await runCli(['attention', '--json'], deps as any)).toBe(1);
    expect(JSON.parse(out.at(-1) ?? '')).toMatchObject({ ok: false, reason: 'error' });
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    expect(await runCli(['attention', '--help'], deps as any)).toBe(0);
    expect(out.at(-1)).toBe(ATTENTION_USAGE);
  });
});
