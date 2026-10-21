// 法国只读巡查（patrol-lib.mjs，决定 0034，#1372；#2370 起判法收口）：监控的主体是脚本，读不成一律 BROKEN、不当 OK；基线只由脚本写。
// 引擎的判法（发版卡住、推送不通、简报没到、该推的通知）不在这里抄：法国上只跑 fleet-api attention --json，巡检只读它的结论。
// ssh 全是假的（fetchRaw 换掉）；基线文件换成内存里的一份。故意造的失败：空输出、截断、库查询报错、采集时间过旧、
// 认不出的行、attention 命令不存在（旧版本）、attention 输出坏了、ssh 名字没配，都必须判 BROKEN；坏样本必须判 ALERT。
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runChildOk } from './child.ts';
import {
  FIXTURE_HOOK_MS,
  type FixtureDb,
  openPatrolSqlFixture,
  type PatrolSqlFixture,
} from './patrol-sql-fixture.ts';

const SCRIPTS = fileURLToPath(new URL('../skills/commander/scripts/', import.meta.url));

type Raw = { ok: true; stdout: string } | { ok: false; kind: string; why: string };
interface Report {
  verdict: 'OK' | 'ALERT' | 'BROKEN';
  alerts: string[];
  delta: string[];
  broken: string | null;
  facts: {
    at: string;
    notes: { key: string; level?: string }[];
    jobs: { job: string; outcome: string }[];
  } | null;
}
interface SampleOpts {
  at: Date;
  disk?: number;
  mem?: number;
  master?: string;
  tasks?: string[];
  jobs?: string[];
  notes?: string[];
  push?: string;
  brief?: string;
  noEnd?: boolean;
  err?: string;
  healthz?: number;
  healthRed?: string[];
  attention?: string;
  attentionErr?: string;
  localOrphans?: { repo: string; issue: number; labeledFor: string; reason: string }[];
}
interface PatrolLib {
  REMOTE_SCRIPT: string;
  FLEET_API: string;
  NO_ATTENTION_WHY: string;
  STALE_MINUTES: number;
  sampleRaw(o: SampleOpts): string;
  parseRaw(text: string): { ok: true; facts: NonNullable<Report['facts']> } | { ok: false; why: string };
  judge(input: { raw: Raw; now: Date; base: unknown }): Report;
  render(r: Report): string[];
  selftest(now: Date): { ok: boolean; lines: string[] };
  runPatrol(io: {
    fetchRaw: () => Promise<Raw>;
    now: () => Date;
    loadBaseline: () => string | null;
    saveBaseline: (text: string) => void;
    trainNote?: () => string;
    hkStatus?: () => Promise<string>;
  }): Promise<{ code: number; lines: string[]; report: Report }>;
  fetchFrance(opts: {
    home: string;
    env: Record<string, string | undefined>;
    readText: (f: string) => string;
  }): Promise<Raw>;
  readHkStatus(opts: {
    home: string;
    env: Record<string, string | undefined>;
    readText: (f: string) => string;
    fetchImpl?: typeof fetch;
  }): Promise<string>;
}

const lib = (await import(pathToFileURL(join(SCRIPTS, 'patrol-lib.mjs')).href)) as PatrolLib;
const NOW = new Date('2026-10-09T01:00:00Z');
const ok = (stdout: string): Raw => ({ ok: true, stdout });
const good = () => lib.sampleRaw({ at: NOW });
const baseOf = (text: string) => {
  const p = lib.parseRaw(text);
  if (!p.ok) throw new Error(p.why);
  return p.facts;
};

/** 跑一次 runPatrol，基线是内存里的一份 */
async function patrol(raw: Raw, baseline: string | null, hkStatus?: () => Promise<string>) {
  const saved: string[] = [];
  const r = await lib.runPatrol({
    fetchRaw: async () => raw,
    now: () => NOW,
    loadBaseline: () => baseline,
    saveBaseline: (t) => saved.push(t),
    ...(hkStatus ? { hkStatus } : {}),
  });
  return { ...r, saved };
}

describe('巡查脚本：判法', () => {
  it('一切正常：OK，最后一行 VERDICT: OK，每项一行带采集时间', () => {
    const r = lib.judge({ raw: ok(good()), now: NOW, base: null });
    expect(r.verdict).toBe('OK');
    const lines = lib.render(r);
    expect(lines.at(-1)).toBe('VERDICT: OK');
    expect(lines.filter((l) => l.includes(`@${NOW.toISOString()}`)).length).toBeGreaterThanOrEqual(5);
    expect(lines.some((l) => l.startsWith('本机没人领 0 张'))).toBe(true);
  });

  it('贴了「本机做」没人领：消费者原样报对账确认过的名单；没有或旧版没这栏是空的，不报', () => {
    const items = [
      {
        repo: 'acme/app',
        issue: 12,
        labeledFor: '25 小时',
        reason: 'fleet-engine[bot]：涉及 .github/workflows/ci.yml',
      },
      {
        repo: 'acme/app',
        issue: 13,
        labeledFor: '26 小时',
        reason: '普通超过 24 小时，条件已由对账选择器确认',
      },
    ];
    const hit = lib.judge({ raw: ok(lib.sampleRaw({ at: NOW, localOrphans: items })), now: NOW, base: null });
    expect(hit.verdict).toBe('ALERT');
    expect(hit.alerts).toEqual([
      '本机没人领 #12（acme/app）贴了「本机做」25 小时：fleet-engine[bot]：涉及 .github/workflows/ci.yml',
      '本机没人领 #13（acme/app）贴了「本机做」26 小时：普通超过 24 小时，条件已由对账选择器确认',
    ]);
    const none = lib.judge({ raw: ok(good()), now: NOW, base: baseOf(good()) });
    expect(none.alerts.filter((a) => a.startsWith('本机没人领'))).toEqual([]);
  });

  it('坏样本：每条不变量各记一行，VERDICT: ALERT <条数>', () => {
    const base = baseOf(good());
    const raw = lib.sampleRaw({
      at: NOW,
      disk: 91,
      mem: 512,
      master: 'false',
      tasks: ['task|12|fleet-dao|running|parked|45|等人'],
      jobs: ['job|probe|failed|7|探针连不上'],
      notes: ['note|alert|deploy-lag|发布落后', 'note|alert|task-stuck:12|单卡住了'],
    });
    const r = lib.judge({ raw: ok(raw), now: NOW, base });
    expect(r.verdict).toBe('ALERT');
    expect(r.alerts).toHaveLength(6);
    expect(lib.render(r).at(-1)).toBe('VERDICT: ALERT 6');
  });

  it('日报级不进留意、不进变化；decision 仍算新通知', () => {
    const base = baseOf(good());
    const raw = lib.sampleRaw({
      at: NOW,
      notes: [
        'note|alert|deploy-lag|发布落后',
        'note|daily|release:done:abc|【发版成功】法国已在用 abc',
        'note|daily|feishu:brief:2026-10-09|每日简报',
        'note|decision|github-app:o/r|o/r：先去 GitHub 把两个机器人装到这个仓',
      ],
    });
    const r = lib.judge({ raw: ok(raw), now: NOW, base });
    expect(r.alerts).toEqual(['新通知 github-app:o/r：o/r：先去 GitHub 把两个机器人装到这个仓']);
    expect(r.delta.join('\n')).not.toContain('release:');
    expect(r.delta.join('\n')).not.toContain('brief');
    expect(lib.render(r).join('\n')).not.toContain('【发版成功】');
    expect(lib.render(r).at(-1)).toBe('VERDICT: ALERT 1');
  });

  it('和基线比：只报变了的（新单、状态变了、新通知、消失的通知），分钟数每次变不算', () => {
    const base = baseOf(good());
    const raw = lib.sampleRaw({
      at: new Date(NOW.getTime() + 60_000),
      tasks: ['task|12|fleet-dao|merging||9|在合并', 'task|13|fleet-dao|running||1|刚起'],
      notes: ['note|alert|other|别的'],
    });
    const r = lib.judge({ raw: ok(raw), now: NOW, base });
    expect(r.delta).toEqual([
      '~ 单 #12（fleet-dao）running → merging',
      '+ 单 #13（fleet-dao）running',
      '+ 通知 other：别的',
      '- 通知 deploy-lag',
    ]);
    const same = lib.judge({
      raw: ok(lib.sampleRaw({ at: NOW, tasks: ['task|12|fleet-dao|running||40|在写代码'] })),
      now: NOW,
      base,
    });
    expect(same.delta).toEqual([]);
  });

  it('单卡住没超过线（30 分钟）不报；卡住超过才报', () => {
    const short = lib.judge({
      raw: ok(lib.sampleRaw({ at: NOW, tasks: ['task|12|fleet-dao|stalled||10|等'] })),
      now: NOW,
      base: null,
    });
    expect(short.verdict).toBe('OK');
    const long = lib.judge({
      raw: ok(lib.sampleRaw({ at: NOW, tasks: ['task|12|fleet-dao|stalled||31|等'] })),
      now: NOW,
      base: null,
    });
    expect(long.alerts).toHaveLength(1);
  });

  it('飞书推送、每日简报：引擎 attention 给的话非空就是 ALERT，原话照搬；是 null 就不报', () => {
    const push = '飞书推送不通：3 条该推的没送到，最老的一条「x」从 2026-10-09T00:00:00.000Z 起就该推';
    const brief = '今天（2026-10-09）08:30 的每日简报没跑：定时任务 daily-brief 今天一轮都没起';
    const r = lib.judge({ raw: ok(lib.sampleRaw({ at: NOW, push, brief })), now: NOW, base: null });
    expect(r.verdict).toBe('ALERT');
    expect(r.alerts).toEqual([push, brief]);
    const text = lib.render(r).join('\n');
    expect(text).toContain('飞书推送 不通');
    expect(text).toContain('每日简报 没送到');
    const fine = lib.render(lib.judge({ raw: ok(good()), now: NOW, base: null })).join('\n');
    expect(fine).toContain('飞书推送 通着');
    expect(fine).toContain('每日简报 没问题');
  });

  it('/healthz 非 200 是 BROKEN，列出红的检查；连不上（0）也是 BROKEN；服务状态不再单独判', () => {
    const r = lib.judge({
      raw: ok(lib.sampleRaw({ at: NOW, healthz: 503, healthRed: ['database', 'temporal'] })),
      now: NOW,
      base: null,
    });
    expect(r.verdict).toBe('BROKEN');
    expect(r.broken).toContain('/healthz 回 503，红的检查：database、temporal');
    expect(lib.render(r).at(-1)).toBe('VERDICT: BROKEN');
    // 法国答了：不加「读不到法国」
    expect(lib.render(r).some((l) => l.includes('读不到法国'))).toBe(false);
    const down = lib.judge({ raw: ok(lib.sampleRaw({ at: NOW, healthz: 0 })), now: NOW, base: null });
    expect(down.verdict).toBe('BROKEN');
    expect(down.broken).toContain('/healthz 回 不出来（连不上）');
    expect(lib.render(r).join('\n')).not.toContain('服务');
  });

  it('【故意造出的失败】法国还没有 attention 命令（旧版本打用法、退出码 2）：BROKEN，理由明说，不当 OK', async () => {
    const raw = ok(
      lib.sampleRaw({
        at: NOW,
        attentionErr: '2|用法：fleet-api set-password <飞书名> 用法：fleet-api dispatch',
      }),
    );
    const r = lib.judge({ raw, now: NOW, base: null });
    expect(r.verdict).toBe('BROKEN');
    expect(r.broken).toBe('法国版本还没有 attention 命令');
    expect(lib.NO_ATTENTION_WHY).toBe('法国版本还没有 attention 命令');
    const ran = await patrol(raw, null);
    expect(ran.code).toBe(2);
    expect(ran.saved).toEqual([]);
    expect(ran.lines.join('\n')).toContain('法国版本还没有 attention 命令');
    expect(ran.lines.at(-1)).toBe('VERDICT: BROKEN');
  });

  it('【故意造出的失败】attention 别的方式跑不起来（退出码 1、不是用法）：BROKEN，写明退出码和输出', () => {
    const r = lib.judge({
      raw: ok(
        lib.sampleRaw({ at: NOW, attentionErr: '1|读不到 /srv/x/fleet-api.service 里的 EnvironmentFile=' }),
      ),
      now: NOW,
      base: null,
    });
    expect(r.verdict).toBe('BROKEN');
    expect(r.broken).toContain('fleet-api attention 跑不起来（退出码 1）');
    expect(r.broken).not.toContain('还没有 attention 命令');
  });

  it('【故意造出的失败】attention 自己报没读成、输出不是 JSON、缺字段、通知里有认不出的一条：都是 BROKEN', () => {
    const cases = [
      JSON.stringify({ ok: false, reason: 'error', why: '库连不上' }),
      '{坏的',
      JSON.stringify({ ok: true, healthz: { code: 200, red: [] }, notes: [] }),
      JSON.stringify({
        ok: true,
        healthz: { code: 200, red: [] },
        notes: [{ key: 'x', level: '随便', title: 't' }],
        feishuPushProblem: null,
        dailyBriefProblem: null,
      }),
      JSON.stringify({
        ok: true,
        healthz: { code: '200', red: [] },
        notes: [],
        feishuPushProblem: null,
        dailyBriefProblem: null,
      }),
    ];
    for (const attention of cases) {
      const r = lib.judge({ raw: ok(lib.sampleRaw({ at: NOW, attention })), now: NOW, base: null });
      expect(r.verdict, attention).toBe('BROKEN');
      expect(r.broken, attention).toContain('fleet-api attention');
    }
    const noLine = lib.sampleRaw({ at: NOW }).replace(/^attention\|.*\n/m, '');
    const missing = lib.judge({ raw: ok(noLine), now: NOW, base: null });
    expect(missing.verdict).toBe('BROKEN');
    expect(missing.broken).toContain('attention');
  });

  it('【故意造出的失败】空输出：BROKEN，不当 OK', () => {
    for (const text of ['', '\n\n', '   ']) {
      const r = lib.judge({ raw: ok(text), now: NOW, base: null });
      expect(r.verdict, JSON.stringify(text)).toBe('BROKEN');
      expect(lib.render(r).at(-1)).toBe('VERDICT: BROKEN');
    }
  });

  it('读不到法国：VERDICT 前多一行显眼中文，写明原因，并指向香港状态页', async () => {
    const raw: Raw = { ok: false, kind: 'ssh-failed', why: '连不上' };
    const judged = lib.judge({ raw, now: NOW, base: null });
    const lines = lib.render(judged);
    expect(lines.at(-1)).toBe('VERDICT: BROKEN');
    const note = lines.find((l) => l.includes('读不到法国'));
    expect(note).toContain('！！！读不到法国：');
    expect(note).toContain('连不上');
    expect(note).toContain('https://<驾驶舱域名>/health/');
    expect(note).toContain('法国失联');
    const ran = await patrol(raw, null);
    expect(ran.code).toBe(2);
    expect(ran.lines.at(-1)).toBe('VERDICT: BROKEN');
    expect(ran.lines.some((l) => l.includes('读不到法国') && l.includes('连不上'))).toBe(true);
    const empty = lib.judge({ raw: ok(''), now: NOW, base: null });
    const emptyLines = lib.render(empty);
    expect(emptyLines.at(-1)).toBe('VERDICT: BROKEN');
    expect(emptyLines.some((l) => l.startsWith('！！！读不到法国：') && l.includes(empty.broken ?? ''))).toBe(
      true,
    );
  });

  it('读不到法国时顺手读香港状态页：结果多一行（在 VERDICT 前），读它抛错也只多一行说明；法国答了不去读', async () => {
    const raw: Raw = { ok: false, kind: 'ssh-failed', why: '连不上' };
    const a = await patrol(raw, null, async () => '香港状态页 法国失联自 10:21');
    expect(a.lines.at(-2)).toBe('香港状态页 法国失联自 10:21');
    expect(a.lines.at(-1)).toBe('VERDICT: BROKEN');
    const b = await patrol(raw, null, async () => {
      throw new Error('curl 超时');
    });
    expect(b.lines.at(-2)).toContain('香港状态页 读不了（curl 超时）');
    let called = 0;
    await patrol(ok(good()), null, async () => {
      called += 1;
      return 'x';
    });
    expect(called).toBe(0);
  });

  it('readHkStatus：没配地址明说没读；配了读 /health/france-link.json，down 就写失联自几点，读不到也明说', async () => {
    const noFile = () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    };
    const reply = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    expect(await lib.readHkStatus({ home: '/h', env: {}, readText: noFile })).toContain('没配地址');
    const env = { FLEET_HK_STATUS_URL: 'https://hk.example/' };
    expect(
      await lib.readHkStatus({
        home: '/h',
        env,
        readText: noFile,
        fetchImpl: reply(200, { down: true, since: '10:21' }),
      }),
    ).toBe('香港状态页 法国失联自 10:21');
    expect(
      await lib.readHkStatus({ home: '/h', env, readText: noFile, fetchImpl: reply(200, { down: false }) }),
    ).toBe('香港状态页 法国隧道通着');
    expect(
      await lib.readHkStatus({ home: '/h', env, readText: noFile, fetchImpl: reply(404, {}) }),
    ).toContain('回 404');
    const boom = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    expect(await lib.readHkStatus({ home: '/h', env, readText: noFile, fetchImpl: boom })).toContain(
      '读不到：ECONNRESET',
    );
    // 地址写在文件里也认
    expect(
      await lib.readHkStatus({
        home: '/h',
        env: {},
        readText: () => 'https://hk.example\n',
        fetchImpl: reply(200, { down: false }),
      }),
    ).toBe('香港状态页 法国隧道通着');
  });

  it('【故意造出的失败】截断（没有 end）、库查询报错、少一块、认不出的行、ssh 没读成：都是 BROKEN', () => {
    const cases: Raw[] = [
      ok(lib.sampleRaw({ at: NOW, noEnd: true })),
      ok(lib.sampleRaw({ at: NOW, err: 'ERR|jobs|permission denied' })),
      ok(good().replace('ok|jobs\n', '')),
      ok(good().replace('ok|master\n', 'ok|master\n乱七八糟\n')),
      { ok: false, kind: 'ssh-failed', why: '连不上' },
    ];
    for (const raw of cases) expect(lib.judge({ raw, now: NOW, base: null }).verdict).toBe('BROKEN');
  });

  it('【故意造出的失败】采集时间比本机早超过 15 分钟（或晚超过）：BROKEN', () => {
    const old = lib.sampleRaw({ at: new Date(NOW.getTime() - (lib.STALE_MINUTES + 1) * 60_000) });
    expect(lib.judge({ raw: ok(old), now: NOW, base: null }).verdict).toBe('BROKEN');
    const future = lib.sampleRaw({ at: new Date(NOW.getTime() + (lib.STALE_MINUTES + 1) * 60_000) });
    expect(lib.judge({ raw: ok(future), now: NOW, base: null }).verdict).toBe('BROKEN');
    const fresh = lib.sampleRaw({ at: new Date(NOW.getTime() - (lib.STALE_MINUTES - 1) * 60_000) });
    expect(lib.judge({ raw: ok(fresh), now: NOW, base: null }).verdict).toBe('OK');
  });

  it('--selftest 用的那几份已知样本全过', () => {
    const r = lib.selftest(NOW);
    expect(r.lines.at(-1)).toBe('SELFTEST: OK');
    expect(r.ok).toBe(true);
  });
});

describe('巡查脚本：VERDICT 三种出口照旧，基线只由脚本写', () => {
  it('OK、ALERT 都写新基线；退出码 0、1', async () => {
    const a = await patrol(ok(good()), null);
    expect(a.code).toBe(0);
    expect(a.lines.at(-1)).toBe('VERDICT: OK');
    expect(a.saved).toHaveLength(1);
    const b = await patrol(ok(lib.sampleRaw({ at: NOW, disk: 99 })), a.saved[0] ?? null);
    expect(b.code).toBe(1);
    expect(b.lines.at(-1)).toBe('VERDICT: ALERT 1');
    expect(b.saved).toHaveLength(1);
  });

  it('【故意造出的失败】BROKEN 不写基线（不拿坏读数盖掉好基线），退出码 2', async () => {
    const r = await patrol(ok(''), null);
    expect(r.code).toBe(2);
    expect(r.saved).toEqual([]);
    expect(r.lines.at(-1)).toBe('VERDICT: BROKEN');
    const h = await patrol(ok(lib.sampleRaw({ at: NOW, healthz: 503 })), null);
    expect(h.code).toBe(2);
    expect(h.saved).toEqual([]);
  });

  it('基线认不出：照没有基线算，并打一行说明，不悄悄吞掉', async () => {
    const r = await patrol(ok(good()), '{坏的');
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.startsWith('基线 基线文件不是 JSON'))).toBe(true);
    expect(r.lines.at(-1)).toBe('VERDICT: OK');
  });
});

describe('巡查脚本：只读、不抄引擎的判法、读不到 ssh 名字明确失败', () => {
  let home = '';
  let dir = '';
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
    home = '';
    dir = '';
  });

  it('法国上跑的那段 sh 只读：库连接带只读事务，没有写库语句、没有往文件写', () => {
    const s = lib.REMOTE_SCRIPT;
    expect(s).toContain('default_transaction_read_only=on');
    expect(s).not.toMatch(/\b(?:insert|update|delete|drop|alter|truncate|create|grant)\b/i);
    expect(s.replace(/2>&1/g, '')).not.toMatch(/>\s*[/\w]/);
    expect(s.trimEnd().split('\n').at(-1)).toBe('echo end');
  });

  it('远端脚本里不再有抄来的判法：没有送达记录表、发版进度记录、发布历史、systemctl、healthz 地址；只调 fleet-api attention --json', () => {
    const s = lib.REMOTE_SCRIPT;
    for (const gone of [
      'notification_deliveries',
      'release-train.json',
      '.train',
      '.auto',
      '.history',
      'systemctl',
      'feishu.push',
      'feishu:',
      '8787/healthz',
    ])
      expect(s, gone).not.toContain(gone);
    expect(s).not.toMatch(/\bfrom notifications\b/);
    expect(s).toContain(`${lib.FLEET_API} attention --json`);
    expect(s).toContain('</dev/null');
  });

  /** 真用 sh 跑远端脚本里调 fleet-api 的那三行（把 fleet-api 换成一个假脚本），回它打出来的行 */
  function runAttentionLines(fake: string): string {
    dir = mkdtempSync(join(tmpdir(), 'patrol-att-'));
    const fakePath = join(dir, 'fleet-api').replaceAll('\\', '/');
    writeFileSync(fakePath, fake);
    chmodSync(fakePath, 0o755);
    const lines = lib.REMOTE_SCRIPT.split('\n').filter((l) => /^(att=|json=|if \[ -n "\$json" \])/.test(l));
    expect(lines).toHaveLength(3);
    const script = lines.map((l) => l.replace(lib.FLEET_API, fakePath)).join('\n');
    return runChildOk('sh', ['-c', script]);
  }

  it('新版本：fleet-api attention 打出 JSON 就原样传回 attention| 一行，过 parseRaw 判得出', () => {
    const json = JSON.stringify({
      ok: true,
      healthz: { code: 200, red: [] },
      notes: [{ key: 'a|b', level: 'decision', title: '带|竖线' }],
      feishuPushProblem: null,
      dailyBriefProblem: null,
    });
    const out = runAttentionLines(`#!/bin/sh\necho '${json}'\n`);
    expect(out).toBe(`attention|${json}`);
    const raw = lib.sampleRaw({ at: NOW }).replace(/^attention\|.*$/m, out);
    const p = lib.parseRaw(raw);
    expect(p.ok, p.ok ? '' : p.why).toBe(true);
  });

  it('【故意造出的失败】旧版本：fleet-api 不认 attention，打用法、退出码 2：传回 attention-err，巡检判「法国版本还没有 attention 命令」', () => {
    const out = runAttentionLines(
      `#!/bin/sh\necho '用法：fleet-api set-password <飞书名或用户 id>' >&2\necho '用法：fleet-api dispatch <owner/仓名> on|off|status' >&2\nexit 2\n`,
    );
    expect(out.startsWith('attention-err|2|')).toBe(true);
    expect(out.split('\n')).toHaveLength(1);
    const raw = lib.sampleRaw({ at: NOW }).replace(/^attention\|.*$/m, out);
    const r = lib.judge({ raw: ok(raw), now: NOW, base: null });
    expect(r.verdict).toBe('BROKEN');
    expect(r.broken).toBe('法国版本还没有 attention 命令');
  });

  it('【故意造出的失败】fleet-api 起不来（退出码 1、没有 JSON）：attention-err，巡检判跑不起来，不是旧版本', () => {
    const out = runAttentionLines(`#!/bin/sh\necho '读不到 unit 里的 EnvironmentFile=，没跑' >&2\nexit 1\n`);
    expect(out.startsWith('attention-err|1|')).toBe(true);
    const raw = lib.sampleRaw({ at: NOW }).replace(/^attention\|.*$/m, out);
    const r = lib.judge({ raw: ok(raw), now: NOW, base: null });
    expect(r.verdict).toBe('BROKEN');
    expect(r.broken).toContain('跑不起来（退出码 1）');
  });

  it('【故意造出的失败】这台没配登法国的 ssh 名字：fetchFrance 回失败，runPatrol 判 BROKEN', async () => {
    home = mkdtempSync(join(tmpdir(), 'patrol-'));
    const raw = await lib.fetchFrance({
      home,
      env: {},
      readText: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    });
    expect(raw.ok).toBe(false);
    const r = await patrol(raw, null);
    expect(r.code).toBe(2);
  });
});

const dbRequire = createRequire(fileURLToPath(new URL('../../packages/db/package.json', import.meta.url)));
const loadPglite = async () =>
  (
    (await import(pathToFileURL(dbRequire.resolve('@electric-sql/pglite')).href)) as {
      PGlite: new () => FixtureDb;
    }
  ).PGlite;

/**
 * #3513：定时任务「最近一次已结束」的真实结局。这一组不手喂 job| 行：用 REMOTE_SCRIPT 里实际的 `q jobs` 那条 SQL，
 * 在隔离的 PGlite 里按生产的表结构（schedule_outcome 枚举、两张表的约束）真执行，再把结果按 psql -At -F'|' 的样子
 * 拼成远端输出喂回 judge，走完 REMOTE_SCRIPT → parseRaw → invariants → delta → render 一整条链。
 * 夹具的装载、起库、建表各段限时、失败回收、建完读回，见 patrol-sql-fixture.ts（#3524）；这里的 hook 窗跟着它的期限走，不用默认 10 秒。
 */
describe('巡查脚本：定时任务最近结局，partial 要报、恢复要有真实 ok（#3513）', () => {
  let fixture: PatrolSqlFixture<FixtureDb> | undefined;
  let db: FixtureDb;
  beforeAll(async () => {
    fixture = await openPatrolSqlFixture({ load: loadPglite });
    db = fixture.db;
  }, FIXTURE_HOOK_MS);
  afterAll(async () => {
    await fixture?.close();
  }, FIXTURE_HOOK_MS);
  beforeEach(async () => {
    await db.exec('truncate schedule_runs restart identity; truncate scheduled_jobs cascade;');
  });

  /** 登记任务；retired 的带摘除时刻 */
  const job = (id: string, retired = false) =>
    db.exec(`insert into scheduled_jobs (id, removed_at) values ('${id}', ${retired ? 'now()' : 'null'})`);
  /** 一次跑。minutesAgo 是结束时刻；outcome 为 null 是还在跑（没有结束时刻） */
  const run = (
    jobId: string,
    outcome: 'ok' | 'partial' | 'failed' | 'unscanned' | null,
    minutesAgo: number,
    why = '',
  ) =>
    db.exec(
      outcome === null
        ? `insert into schedule_runs (job, started_at) values ('${jobId}', now() - interval '${minutesAgo} minutes')`
        : `insert into schedule_runs (job, started_at, ended_at, outcome, scanned, found, why) values ('${jobId}', now() - interval '${minutesAgo + 1} minutes', now() - interval '${minutesAgo} minutes', '${outcome}', 259, 7, ${why ? `'${why}'` : 'null'})`,
    );

  /** 取出 REMOTE_SCRIPT 里 `q jobs "<sql>"` 那条实际 SQL，真执行，结果按 psql -At -F'|' 拼成行（NULL 是空） */
  async function jobsLines(): Promise<string[]> {
    const m = lib.REMOTE_SCRIPT.split('\n')
      .find((l) => l.startsWith('q jobs "'))
      ?.match(/^q jobs "(.*)"$/);
    if (!m?.[1]) throw new Error('REMOTE_SCRIPT 里找不到 q jobs 那一行');
    expect(m[1]).not.toMatch(/\\"|\$|`/); // sh 双引号里没有要转义的东西，SQL 原样就是 psql 收到的
    const r = await db.query(m[1], [], { rowMode: 'array' });
    return r.rows.map((row) => row.map((v) => (v === null ? '' : String(v))).join('|'));
  }
  /** 拿这一刻的库读数走一整轮 judge */
  async function round(base: ReturnType<typeof baseOf> | null) {
    const at = new Date();
    const raw = lib.sampleRaw({ at, jobs: await jobsLines() });
    return { raw, report: lib.judge({ raw: ok(raw), now: at, base }), at };
  }

  async function seedRound96() {
    await job('hourly-reconcile');
    await job('healthy-job');
    await run('hourly-reconcile', 'failed', 120, '旧的失败');
    await run('hourly-reconcile', 'partial', 30, '扫 259 处，7 处有问题，46 处没查成');
    await run('hourly-reconcile', null, 1);
    await run('healthy-job', 'ok', 60);
  }

  it('真实 SQL：较新的在途不盖住最近已结束的 partial，why 和时点留着；healthy-job 的 ok 不进异常列表', async () => {
    await seedRound96();
    const lines = await jobsLines();
    expect(lines).toContain('job|healthy-job|ok|60|');
    const partial = lines.find((l) => l.startsWith('job|hourly-reconcile|'));
    expect(partial).toMatch(/^job\|hourly-reconcile\|partial\|30\|扫 259 处，7 处有问题，46 处没查成$/);
    const { report } = await round(null);
    expect(report.verdict).toBe('ALERT');
    expect(report.alerts).toEqual([
      '定时任务 hourly-reconcile 最近一次是 partial（30 分钟前）：扫 259 处，7 处有问题，46 处没查成',
    ]);
    const text = lib.render(report);
    expect(text).toContain(`定时任务 最近一次不是 ok 的 1 个 @${report.facts?.at ?? ''}`);
    expect(text.join('\n')).not.toContain('healthy-job');
    expect(text.at(-1)).toBe('VERDICT: ALERT 1');
  });

  it('纯 ok：不报警，不在计数、变化里刷健康任务；退役任务和从没跑完的任务也不计', async () => {
    await job('healthy-job');
    await job('retired-job', true);
    await job('never-finished');
    await run('healthy-job', 'ok', 60);
    await run('retired-job', 'failed', 10, '退役前最后一次是失败');
    await run('never-finished', null, 1);
    const first = await round(null);
    expect(first.report.verdict).toBe('OK');
    expect(first.report.alerts).toEqual([]);
    expect(lib.render(first.report)).toContain(`定时任务 最近一次不是 ok 的 0 个 @${first.report.facts?.at}`);
    const second = await round(first.report.facts as ReturnType<typeof baseOf>);
    expect(second.report.verdict).toBe('OK');
    expect(second.report.delta).toEqual([]);
  });

  it('failed → partial 不是恢复；partial → 当前真实 ok 才是恢复；ok 之后又冒出新的在途不影响', async () => {
    await job('hourly-reconcile');
    await run('hourly-reconcile', 'failed', 120, '旧的失败');
    const r1 = await round(null);
    expect(r1.report.facts?.jobs.map((j) => j.outcome)).toEqual(['failed']);
    await run('hourly-reconcile', 'partial', 30, '46 处没查成');
    const r2 = await round(r1.report.facts as ReturnType<typeof baseOf>);
    expect(r2.report.verdict).toBe('ALERT');
    expect(r2.report.delta).toEqual(['~ 定时任务 hourly-reconcile failed → partial']);
    expect(r2.report.delta.join('\n')).not.toContain('恢复');
    await run('hourly-reconcile', 'ok', 5);
    await run('hourly-reconcile', null, 1);
    const r3 = await round(r2.report.facts as ReturnType<typeof baseOf>);
    expect(r3.report.verdict).toBe('OK');
    expect(r3.report.delta).toEqual(['- 定时任务 hourly-reconcile（恢复了：最近一次已结束的是 ok）']);
  });

  it('旧异常任务本轮不见了（退役，或还没有已结束的跑）：不凭缺席叫恢复', async () => {
    await job('hourly-reconcile');
    await run('hourly-reconcile', 'partial', 30, '46 处没查成');
    const r1 = await round(null);
    expect(r1.report.verdict).toBe('ALERT');
    await db.exec(`update scheduled_jobs set removed_at = now() where id = 'hourly-reconcile'`);
    const r2 = await round(r1.report.facts as ReturnType<typeof baseOf>);
    expect(r2.report.verdict).toBe('OK');
    expect(r2.report.delta.join('\n')).not.toContain('恢复了');
    expect(r2.report.delta).toEqual(['- 定时任务 hourly-reconcile（本轮不再出现，没读到当前 ok，不算恢复）']);
  });

  it('旧基线（没有 okJobs，也从没记过 partial）照读：旧失败读到 ok 才是恢复；缺席不是恢复；新冒出的 partial 报成新增', async () => {
    const old = (jobs: { job: string; outcome: string }[]) => {
      const f = JSON.parse(JSON.stringify(baseOf(lib.sampleRaw({ at: NOW }))));
      f.jobs = jobs.map((j) => ({ ...j, minutes: 9, why: '旧' }));
      delete f.okJobs;
      const parsed = JSON.parse(`{"schema":1,"facts":${JSON.stringify(f)}}`);
      return parsed.facts as ReturnType<typeof baseOf>;
    };
    await job('a-job');
    await job('b-job');
    await run('a-job', 'ok', 5);
    await run('b-job', 'partial', 5, '没查成');
    const base = old([
      { job: 'a-job', outcome: 'failed' },
      { job: 'gone-job', outcome: 'failed' },
    ]);
    const r = await round(base);
    expect(r.report.delta).toEqual([
      '+ 定时任务 b-job partial',
      '- 定时任务 a-job（恢复了：最近一次已结束的是 ok）',
      '- 定时任务 gone-job（本轮不再出现，没读到当前 ok，不算恢复）',
    ]);
    // 同一份旧基线经 readBaseline 过一遍也认
    const read = JSON.stringify({ schema: 1, facts: base });
    const viaRun = await patrol(ok(lib.sampleRaw({ at: NOW, jobs: await jobsLines() })), read);
    expect(viaRun.lines.join('\n')).toContain('- 定时任务 a-job（恢复了：最近一次已结束的是 ok）');
    expect(viaRun.code).toBe(1);
  });

  it('读失败、截断、认不出的 job 行：照旧 BROKEN，不写基线、不拿旧值或空 0 凑绿', async () => {
    await job('hourly-reconcile');
    await run('hourly-reconcile', 'partial', 30, '46 处没查成');
    const lines = await jobsLines();
    const at = NOW;
    const base = JSON.stringify({ schema: 1, facts: baseOf(lib.sampleRaw({ at: NOW })) });
    // 对照：同一份读数没坏的时候是 ALERT（不是因为时间差才 BROKEN）
    expect((await patrol(ok(lib.sampleRaw({ at, jobs: lines })), base)).code).toBe(1);
    const fails = [
      lib.sampleRaw({ at, jobs: lines, err: 'ERR|jobs|permission denied' }),
      lib.sampleRaw({ at, jobs: lines, noEnd: true }),
      lib.sampleRaw({ at, jobs: [...lines, 'job|x||5|空结局'] }),
      lib.sampleRaw({ at, jobs: [...lines, 'job|x|ok|不是数字|y'] }),
    ];
    for (const stdout of fails) {
      const r = await patrol(ok(stdout), base);
      expect(r.code, stdout).toBe(2);
      expect(r.saved, stdout).toEqual([]);
      expect(r.report.facts, stdout).toBeNull();
      expect(r.lines.at(-1)).toBe('VERDICT: BROKEN');
    }
  });

  it('--selftest 里有 partial 必须报的样本', () => {
    const r = lib.selftest(NOW);
    expect(r.lines.some((l) => l.startsWith('自检 过 定时任务最近一次是 partial'))).toBe(true);
  });
});

describe('巡查脚本：总开关关着时带上发版车状态（#1674）', () => {
  const closed = () => lib.sampleRaw({ at: NOW, master: 'false' });
  const run = (raw: Raw, trainNote?: () => string) =>
    lib.runPatrol({
      fetchRaw: async () => raw,
      now: () => NOW,
      loadBaseline: () => null,
      saveBaseline: () => {},
      ...(trainNote ? { trainNote } : {}),
    });

  it('总开关关着：那条 ALERT 后面接发版车的一句话，条数不变', async () => {
    const r = await run(ok(closed()), () => '发版车驱动死在第 4 步「发版」，没人恢复');
    expect(r.code).toBe(1);
    const line = r.report.alerts.find((a) => a.startsWith('引擎总开关关着'));
    expect(line).toContain('发版车：发版车驱动死在第 4 步「发版」，没人恢复');
    expect(r.report.alerts.length).toBe(1);
    expect(r.lines.join('\n')).toContain('没人恢复');
  });

  it('总开关开着：不去读发版车状态', async () => {
    let called = 0;
    const r = await run(ok(good()), () => {
      called += 1;
      return 'x';
    });
    expect(r.code).toBe(0);
    expect(called).toBe(0);
  });

  it('【故意造出的失败】读发版车状态抛错：照样报总开关关着，并写明读不了，不吞掉', async () => {
    const r = await run(ok(closed()), () => {
      throw new Error('磁盘坏了');
    });
    expect(r.code).toBe(1);
    expect(r.report.alerts[0]).toContain('发版车状态读不了（磁盘坏了）');
  });

  it('没接 trainNote：和以前一样', async () => {
    const r = await run(ok(closed()));
    expect(r.report.alerts[0]).toBe('引擎总开关关着（engine.master 是 false）');
  });
});
