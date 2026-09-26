// 引擎问 Jev 的端口（real/jev-port.ts）：引擎的两道题换成 packages/jev 题库里那道去问、判断记进库、答案换回引擎认的回答。
// 没接、起不来、没判出来（连不上、把握低、答了题面外的、模型不对、到了上限）一律交回「没判出来」，引擎照规则走；每条故意造一次。
// 后端是假的（不出网）；库是内存里的真迁移。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevAnswers, jevQuestions, loadCatalog, parseCatalog, seed, settings } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { BackendRequest, BackendResult, JevBackend, JevSetup } from '@fleet-dao/jev';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyFailure } from '../../src/failure/classify.ts';
import type { JevQuestion } from '../../src/failure/jev.ts';
import { judgeStall, type StallChoice } from '../../src/failure/stall.ts';
import type { TriageChoice } from '../../src/failure/types.ts';
import {
  createEngineJevPort,
  ENGINE_JEV_QUESTIONS,
  engineJevFromEnv,
  registerEngineJevQuestions,
} from '../../src/real/jev-port.ts';

const MODEL = 'jev-1.13.0';
const ROUTE = 'jev:jev-1.13:api-shell';
const repoFile = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const EXAMPLE = 'deploy/examples/catalog.example.json';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 假后端：按 reply 回，记下每次请求。 */
function backend(reply: (req: BackendRequest) => BackendResult, model = MODEL) {
  const calls: BackendRequest[] = [];
  const b: JevBackend = {
    kind: 'fake',
    model,
    async ask(req) {
      calls.push(req);
      return reply(req);
    },
  };
  return Object.assign(b, { calls });
}

const answered = (id: string, option: string, confidence: number, model = MODEL): BackendResult => ({
  ok: true,
  answers: { [id]: { option, confidence } },
  model,
  latencyMs: 12,
  inputTokens: 300,
  tokensEstimated: false,
});

const ready =
  (b: JevBackend): (() => Promise<JevSetup>) =>
  async () => ({
    state: 'ready',
    backend: b,
    routeId: ROUTE,
  });

/** 规则认不出的一次会话失败出的那道题（引擎自己的题）。 */
const FAILURE_Q = classifyFailure({
  source: 'session:execute',
  stage: 'execute',
  routeId: 'solo',
  code: 'agent_error',
  message: '上游回了一句谁也没见过的话 zq-17',
}).jevQuestion as JevQuestion<TriageChoice>;

/** 有动静、半天没推进、看不出在重复：拿不准，出一道停滞预判题。 */
const STALL_Q = judgeStall({
  now: '2026-09-25T00:25:00.000Z',
  startedAt: '2026-09-25T00:00:00.000Z',
  lastEventAt: '2026-09-25T00:24:54.000Z',
  lastStepAt: '2026-09-25T00:05:00.000Z',
  recentTools: [{ name: 'Bash', summary: 'pnpm test', action: 'run', ok: false }],
  transcriptTail: ['我再试一个办法……'],
}).jevQuestion as JevQuestion<StallChoice>;

const CTX = { subject: 'run:r1', about: '任务 t1 的 execute 阶段（会话失败）' };

describe('问', () => {
  it('题目都造出来了（不然下面等于没测）', () => {
    expect(FAILURE_Q?.questionId).toBe('failure-triage');
    expect(STALL_Q?.questionId).toBe('stall-predict');
  });

  it('错误分流：换成题库的 error-next 去问（喂上是哪一步、原文全文），判断记进库（只记不拦、带路由），答案换回引擎的选项', async () => {
    const b = backend(() => answered('error-next', 'swap_route', 0.9));
    const port = createEngineJevPort({ db: t.db, resolve: ready(b) });
    expect(await port.ask(FAILURE_Q, CTX)).toEqual({
      asked: true,
      ok: true,
      choice: 'swapRoute',
      confidence: 0.9,
      shadow: true,
      modelVersion: MODEL,
    });
    const req = b.calls[0];
    expect(req?.questions.map((q) => q.id)).toEqual(['error-next']);
    expect(req?.evidence).toEqual([
      { label: '出错的步骤', text: CTX.about },
      { label: '报错原文', text: FAILURE_Q.sample },
    ]);
    expect(FAILURE_Q.sample).toContain('zq-17');
    const [row] = await t.db.select().from(jevAnswers);
    expect(row).toMatchObject({
      questionId: 'error-next',
      subject: 'run:r1',
      shadow: true,
      ok: true,
      answer: 'swap_route',
    });
    expect((row?.sample as { route?: string } | undefined)?.route).toBe(ROUTE);
    const [q] = await t.db.select().from(jevQuestions);
    expect(q).toMatchObject({ id: 'error-next', mode: 'shadow', model: MODEL });
  });

  it('停滞预判：换成 stall-state 去问，「在绕圈」换回 looping', async () => {
    const b = backend(() => answered('stall-state', 'looping', 0.8));
    const port = createEngineJevPort({ db: t.db, resolve: ready(b) });
    const reply = await port.ask(STALL_Q, {
      subject: 'run:r2',
      about: '任务 t1 的 execute 阶段（会话没推进）',
    });
    expect(reply).toMatchObject({ asked: true, ok: true, choice: 'looping', shadow: true });
    expect(b.calls[0]?.evidence.map((e) => e.label)).toEqual([
      '会话在做什么',
      '最近的过程记录（按时间顺序）',
    ]);
    expect(b.calls[0]?.evidence[1]?.text).toContain('我再试一个办法……');
  });

  it('没说问的是谁：记成 engine:<题号>，照样问', async () => {
    const b = backend(() => answered('error-next', 'retry', 0.9));
    await createEngineJevPort({ db: t.db, resolve: ready(b) }).ask(FAILURE_Q);
    const [row] = await t.db.select().from(jevAnswers);
    expect(row?.subject).toBe('engine:failure-triage');
  });

  it('答挂起：引擎不让 Jev 选挂起，当没判出来（判断记录里照记它答的 park）', async () => {
    const b = backend(() => answered('error-next', 'park', 0.95));
    const reply = await createEngineJevPort({ db: t.db, resolve: ready(b) }).ask(FAILURE_Q, CTX);
    expect(reply).toMatchObject({ asked: true, ok: false });
    expect(reply.asked && !reply.ok && reply.reason).toContain('挂起');
    const [row] = await t.db.select().from(jevAnswers);
    expect(row?.answer).toBe('park');
  });

  it('没判出来的都交回「问了没判出来」，原因写明：把握低、答了题面外的、连不上、模型不对', async () => {
    const cases: [BackendResult, string][] = [
      [answered('error-next', 'retry', 0.4), '把握度低于把握线'],
      [answered('error-next', 'reboot', 0.9), '答了题面以外的选项'],
      [{ ok: false, reason: 'network', detail: 'ECONNRESET', latencyMs: 3 }, '连不上'],
      [answered('error-next', 'retry', 0.9, 'jev-1.14.0'), '回话的模型不是钉死的那个'],
    ];
    for (const [result, why] of cases) {
      const reply = await createEngineJevPort({ db: t.db, resolve: ready(backend(() => result)) }).ask(
        FAILURE_Q,
        CTX,
      );
      expect(reply, why).toMatchObject({ asked: true, ok: false });
      expect(reply.asked && !reply.ok && reply.reason, why).toContain(why);
    }
  });

  it('本地就拦下、没问出去的（到了每日上限）：交回「没问」', async () => {
    await t.db.insert(settings).values({ key: 'judge.dailyCallLimit', value: 0 });
    const b = backend(() => answered('error-next', 'retry', 0.9));
    const reply = await createEngineJevPort({ db: t.db, resolve: ready(b) }).ask(FAILURE_Q, CTX);
    expect(reply).toMatchObject({ asked: false });
    expect(!reply.asked && reply.reason).toContain('每日上限');
    expect(b.calls).toHaveLength(0);
  });

  it('本机没接：不问、不碰库', async () => {
    const reply = await createEngineJevPort({
      db: t.db,
      resolve: async () => ({ state: 'absent', path: '/etc/fleet-dao/jev.json' }),
    }).ask(FAILURE_Q, CTX);
    expect(reply).toEqual({ asked: false, reason: '本机没接判断题（没有 /etc/fleet-dao/jev.json）' });
    expect(await t.db.select().from(jevAnswers)).toEqual([]);
  });

  it('起不来（配置坏了、钥匙读不到……）：不问，原因写明并打日志', async () => {
    const logs: string[] = [];
    const reply = await createEngineJevPort({
      db: t.db,
      resolve: async () => ({ state: 'broken', problem: '读不到 TypeSafe 密钥文件' }),
      log: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
    }).ask(FAILURE_Q, CTX);
    expect(reply).toEqual({ asked: false, reason: '判断题起不来：读不到 TypeSafe 密钥文件' });
    expect(logs.some((l) => l.includes('读不到 TypeSafe 密钥文件'))).toBe(true);
  });

  it('不认识的题：不问', async () => {
    const b = backend(() => answered('error-next', 'retry', 0.9));
    const odd = { ...FAILURE_Q, questionId: 'route-pick' } as unknown as JevQuestion<TriageChoice>;
    const reply = await createEngineJevPort({ db: t.db, resolve: ready(b) }).ask(odd, CTX);
    expect(reply).toMatchObject({ asked: false });
    expect(b.calls).toHaveLength(0);
  });
});

describe('引擎起来时登记两道题', () => {
  it('配好了：两道题登记成只记不拦、钉在判断路由的模型上；再起一次不重复登记', async () => {
    const deps = { db: t.db, resolve: ready(backend(() => answered('error-next', 'retry', 0.9))) };
    const first = await registerEngineJevQuestions(deps);
    expect(first.level).toBe('info');
    expect(first.message).toContain(`路由 ${ROUTE}`);
    const rows = await t.db.select().from(jevQuestions);
    expect(rows.map((r) => [r.id, r.mode, r.model]).sort()).toEqual(
      ENGINE_JEV_QUESTIONS.map((q) => [q.id, 'shadow', MODEL]).sort(),
    );
    expect((await registerEngineJevQuestions(deps)).message).toContain('两道题都登记过了');
  });

  it('没接：info，不登记', async () => {
    const r = await registerEngineJevQuestions({
      db: t.db,
      resolve: async () => ({ state: 'absent', path: '/etc/fleet-dao/jev.json' }),
    });
    expect(r).toEqual({
      level: 'info',
      message: '判断题没接：本机没有 /etc/fleet-dao/jev.json，错误分流、停滞预判照规则走',
    });
    expect(await t.db.select().from(jevQuestions)).toEqual([]);
  });

  it('起不来、登记不进库：error（要人看），不抛——引擎照规则走照样接活', async () => {
    const broken = await registerEngineJevQuestions({
      db: t.db,
      resolve: async () => ({ state: 'broken', problem: '调度台的判断阶段没有开着的路由' }),
    });
    expect(broken).toEqual({
      level: 'error',
      message: '判断题起不来，错误分流、停滞预判先照规则走：调度台的判断阶段没有开着的路由',
    });
    const failingDb = {
      transaction: async () => {
        throw new Error('Failed query', { cause: new Error('permission denied for table jev_questions') });
      },
    } as unknown as TestDb['db'];
    const stuck = await registerEngineJevQuestions({
      db: failingDb,
      resolve: ready(backend(() => answered('x', 'y', 1))),
    });
    expect(stuck).toEqual({
      level: 'error',
      message: '判断题登记不进库，错误分流、停滞预判先照规则走：permission denied for table jev_questions',
    });
  });
});

describe('生产装配：配置在哪按环境变量定', () => {
  const machine = (config: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-engine-jev-'));
    dirs.push(dir);
    const path = join(dir, 'jev.json');
    writeFileSync(path, JSON.stringify(config));
    return path;
  };

  it('FLEET_JEV_CONFIG 指的配置、库里判断阶段排第一的路由：起来时登记，问的时候记下路由', async () => {
    await seed(t.db);
    await loadCatalog(t.db, parseCatalog(repoFile(EXAMPLE), EXAMPLE));
    const path = machine({
      typesafe: { endpoint: 'https://jev.example.invalid/v1', keyFile: '/nonexistent/key' },
    });
    const b = backend(() => answered('error-next', 'retry', 0.9));
    const jev = engineJevFromEnv(t.db, { FLEET_JEV_CONFIG: path }, { makeBackend: async () => b });
    expect((await jev.register()).level).toBe('info');
    expect(await jev.port.ask(FAILURE_Q, CTX)).toMatchObject({ asked: true, ok: true, choice: 'retry' });
    const [row] = await t.db.select().from(jevAnswers);
    expect((row?.sample as { route?: string } | undefined)?.route).toBe(ROUTE);
  });

  it('FLEET_JEV_CONFIG 指的文件不在：起来时报 error，问的时候不问（不当成没配）', async () => {
    const missing = join(tmpdir(), 'fleet-engine-jev-nowhere', 'jev.json');
    const jev = engineJevFromEnv(t.db, { FLEET_JEV_CONFIG: missing }, { log: () => {} });
    const r = await jev.register();
    expect(r.level).toBe('error');
    expect(r.message).toContain(`FLEET_JEV_CONFIG 写的 ${missing} 不存在`);
    const reply = await jev.port.ask(FAILURE_Q, CTX);
    expect(reply).toMatchObject({ asked: false });
    expect(!reply.asked && reply.reason).toContain('判断题起不来');
  });
});
