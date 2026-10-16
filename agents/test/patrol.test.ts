// 法国只读巡查（patrol-lib.mjs，决定 0034，#1372；#2370 起判法收口）：监控的主体是脚本，读不成一律 BROKEN、不当 OK；基线只由脚本写。
// 引擎的判法（发版卡住、推送不通、简报没到、该推的通知）不在这里抄：法国上只跑 fleet-api attention --json，巡检只读它的结论。
// ssh 全是假的（fetchRaw 换掉）；基线文件换成内存里的一份。故意造的失败：空输出、截断、库查询报错、采集时间过旧、
// 认不出的行、attention 命令不存在（旧版本）、attention 输出坏了、ssh 名字没配，都必须判 BROKEN；坏样本必须判 ALERT。
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChildOk } from './child.ts';

const SCRIPTS = fileURLToPath(new URL('../skills/commander/scripts/', import.meta.url));

type Raw = { ok: true; stdout: string } | { ok: false; kind: string; why: string };
interface Report {
  verdict: 'OK' | 'ALERT' | 'BROKEN';
  alerts: string[];
  delta: string[];
  broken: string | null;
  facts: { at: string; notes: { key: string; level?: string }[] } | null;
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

  it('贴了「本机做」没人领：ALERT 写出单号、贴了多久和原因；没有或旧版没这栏是空的，不报', () => {
    const one = {
      repo: 'acme/app',
      issue: 12,
      labeledFor: '25 小时',
      reason: 'fleet-engine[bot]：涉及 .github/workflows/ci.yml',
    };
    const hit = lib.judge({ raw: ok(lib.sampleRaw({ at: NOW, localOrphans: [one] })), now: NOW, base: null });
    expect(hit.verdict).toBe('ALERT');
    expect(hit.alerts).toEqual([
      '本机没人领 #12（acme/app）贴了「本机做」25 小时：fleet-engine[bot]：涉及 .github/workflows/ci.yml',
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
