// 法国只读巡查（patrol-lib.mjs，决定 0034，#1372）：监控的主体是脚本，读不成一律 BROKEN、不当 OK；基线只由脚本写。
// ssh 全是假的（fetchRaw 换掉）；基线文件换成内存里的一份。故意造的失败：空输出、截断、库查询报错、采集时间过旧、
// 认不出的行、ssh 名字没配，都必须判 BROKEN；坏样本必须判 ALERT。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  facts: { at: string; dailyOpen?: number; notes: { key: string }[] } | null;
}
interface SampleOpts {
  at: Date;
  disk?: number;
  mem?: number;
  engine?: string;
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
  hist?: string[];
  noHist?: boolean;
  train?: string;
  trainRaw?: string;
  noState?: boolean;
  autoNote?: string;
  behind?: number;
  behindMinutes?: number;
}
interface PatrolLib {
  REMOTE_SCRIPT: string;
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
  }): Promise<{ code: number; lines: string[]; report: Report }>;
  fetchFrance(opts: {
    home: string;
    env: Record<string, string | undefined>;
    readText: (f: string) => string;
  }): Promise<Raw>;
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
async function patrol(raw: Raw, baseline: string | null) {
  const saved: string[] = [];
  const r = await lib.runPatrol({
    fetchRaw: async () => raw,
    now: () => NOW,
    loadBaseline: () => baseline,
    saveBaseline: (t) => saved.push(t),
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
  });

  it('坏样本：每条不变量各记一行，VERDICT: ALERT <条数>', () => {
    const base = baseOf(good());
    const raw = lib.sampleRaw({
      at: NOW,
      engine: 'failed',
      disk: 91,
      mem: 512,
      master: 'false',
      tasks: ['task|12|fleet-dao|running|parked|45|等人'],
      jobs: ['job|probe|failed|7|探针连不上'],
      notes: ['note|alert|deploy-lag|发布落后', 'note|alert|task-stuck:12|单卡住了'],
    });
    const r = lib.judge({ raw: ok(raw), now: NOW, base });
    expect(r.verdict).toBe('ALERT');
    expect(r.alerts).toHaveLength(7);
    expect(lib.render(r).at(-1)).toBe('VERDICT: ALERT 7');
  });

  it('日报级不进留意、不进变化，只单独一行报数量；decision 仍算新通知', () => {
    const base = baseOf(good());
    const raw = lib.sampleRaw({
      at: NOW,
      notes: [
        'note|alert|deploy-lag|发布落后',
        'note|daily|release:done:abc|【发版成功】法国已在用 abc',
        'note|daily|release:start:abc|【发版开始】',
        'note|decision|github-app-missing:o/r|o/r：先去 GitHub 把两个机器人装到这个仓',
      ],
    });
    const r = lib.judge({ raw: ok(raw), now: NOW, base });
    expect(r.facts?.dailyOpen).toBe(2);
    expect(r.facts?.notes.map((n) => n.key)).toEqual(['deploy-lag', 'github-app-missing:o/r']);
    expect(r.alerts).toEqual(['新通知 github-app-missing:o/r：o/r：先去 GitHub 把两个机器人装到这个仓']);
    expect(r.delta.join('\n')).not.toContain('release:');
    expect(r.alerts.join('\n')).not.toContain('发版');
    const text = lib.render(r).join('\n');
    expect(text).toContain(`日报 2 条 @${NOW.toISOString()}`);
    expect(text).not.toContain('【发版成功】');
    expect(lib.render(r).at(-1)).toBe('VERDICT: ALERT 1');
  });

  it('note 行少了 level 认不出（SQL 和解析要一起改）', () => {
    const raw = lib.sampleRaw({ at: NOW, notes: ['note|deploy-lag|发布落后'] });
    expect(lib.judge({ raw: ok(raw), now: NOW, base: baseOf(good()) }).verdict).toBe('BROKEN');
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

  it('飞书推送：没配马上 ALERT；该推的到点超过 60 分钟、60 分钟里没送成过才 ALERT；有送成的、还不到点的不报', () => {
    const judge = (push: string) =>
      lib.judge({ raw: ok(lib.sampleRaw({ at: NOW, push })), now: NOW, base: null });
    const off = judge('push|off|飞书机器人在 2 个群里|-1|0|-1');
    expect(off.verdict).toBe('ALERT');
    expect(off.alerts).toEqual(['飞书推送没配：飞书机器人在 2 个群里']);
    const dead = judge('push|on||95|3|12960');
    expect(dead.alerts[0]).toContain('飞书推送不通：3 条该推的没送到');
    expect(dead.alerts[0]).toContain('最近一次送到是 12960 分钟前');
    // 2026-10-05 那种：推送整条没了，后端从没记过状态——哪怕眼下没有该推的也报
    expect(judge('push|none||-1|0|13835').alerts).toEqual([
      '飞书推送没在跑：后端从没记过推送状态（设置 feishu.push 没有）',
    ]);
    expect(judge('push|on||95|3|20').verdict).toBe('OK');
    expect(judge('push|on||30|1|-1').verdict).toBe('OK');
    expect(lib.render(dead).join('\n')).toContain('飞书推送 不通');
  });

  it('每日简报：08:30 过了 30 分钟还没送到才 ALERT（没跑、没做成、没推到飞书各一句）；没到点、还在跑、送到了不报', () => {
    const judge = (brief: string) =>
      lib.judge({ raw: ok(lib.sampleRaw({ at: NOW, brief })), now: NOW, base: null });
    expect(judge('brief|2026-10-09|-30|none|0|0|0|').verdict).toBe('OK');
    expect(judge('brief|2026-10-09|29|none|0|0|0|').verdict).toBe('OK');
    expect(judge('brief|2026-10-09|31|none|0|0|0|').alerts).toEqual([
      '今天（2026-10-09）08:30 的每日简报没跑：定时任务 daily-brief 今天一轮都没起',
    ]);
    expect(judge('brief|2026-10-09|40|failed|0|0|0|#1055 评论没发成：403').alerts).toEqual([
      '今天（2026-10-09）的每日简报没做成：#1055 评论没发成：403',
    ]);
    expect(judge('brief|2026-10-09|40|ok|1|0|3|').alerts).toEqual([
      '今天（2026-10-09）的每日简报没推到飞书：试了 3 次',
    ]);
    expect(judge('brief|2026-10-09|40|running|0|0|0|').verdict).toBe('OK');
    const fine = judge('brief|2026-10-09|40|ok|1|1|1|');
    expect(fine.verdict).toBe('OK');
    expect(lib.render(fine).join('\n')).toContain('每日简报 2026-10-09 送到了');
  });

  it('【故意造出的失败】简报那一块认不出、少了：BROKEN，不当送到了', () => {
    const bad = lib.sampleRaw({ at: NOW, brief: 'brief|昨天|40|ok|1|1|1|' });
    expect(lib.judge({ raw: ok(bad), now: NOW, base: null }).verdict).toBe('BROKEN');
    const missing = lib.sampleRaw({ at: NOW }).replace('ok|brief\n', '');
    expect(lib.judge({ raw: ok(missing), now: NOW, base: null }).verdict).toBe('BROKEN');
  });

  it('【故意造出的失败】推送那一块认不出、库查询报错：BROKEN，不当推送通着', () => {
    const bad = lib.sampleRaw({ at: NOW, push: 'push|maybe||1|1|1' });
    expect(lib.judge({ raw: ok(bad), now: NOW, base: null }).verdict).toBe('BROKEN');
    const err = lib
      .sampleRaw({ at: NOW })
      .replace('ok|push\n', 'ERR|push|relation "settings" does not exist\n');
    expect(lib.judge({ raw: ok(err), now: NOW, base: null }).verdict).toBe('BROKEN');
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

  it('法国答了就不加「读不到法国」（全好，以及 healthz 503 这种有盘面的 BROKEN）', () => {
    const okLines = lib.render(lib.judge({ raw: ok(good()), now: NOW, base: null }));
    expect(okLines.at(-1)).toBe('VERDICT: OK');
    expect(okLines.some((l) => l.includes('读不到法国'))).toBe(false);
    const bad = lib.sampleRaw({ at: NOW, healthz: 503, healthRed: ['database'] });
    const lines = lib.render(lib.judge({ raw: ok(bad), now: NOW, base: null }));
    expect(lines.at(-1)).toBe('VERDICT: BROKEN');
    expect(lines.some((l) => l.includes('读不到法国'))).toBe(false);
  });

  it('【故意造出的失败】截断（没有 end）、库查询报错、少一块、认不出的行、ssh 没读成：都是 BROKEN', () => {
    const cases: Raw[] = [
      ok(lib.sampleRaw({ at: NOW, noEnd: true })),
      ok(lib.sampleRaw({ at: NOW, err: 'ERR|notes|permission denied' })),
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

describe('巡查脚本：基线只由脚本写', () => {
  it('OK、ALERT 都写新基线；退出码 0、1', async () => {
    const a = await patrol(ok(good()), null);
    expect(a.code).toBe(0);
    expect(a.saved).toHaveLength(1);
    const b = await patrol(ok(lib.sampleRaw({ at: NOW, disk: 99 })), a.saved[0] ?? null);
    expect(b.code).toBe(1);
    expect(b.saved).toHaveLength(1);
  });

  it('【故意造出的失败】BROKEN 不写基线（不拿坏读数盖掉好基线），退出码 2', async () => {
    const r = await patrol(ok(''), null);
    expect(r.code).toBe(2);
    expect(r.saved).toEqual([]);
    expect(r.lines.at(-1)).toBe('VERDICT: BROKEN');
  });

  it('基线认不出：照没有基线算，并打一行说明，不悄悄吞掉', async () => {
    const r = await patrol(ok(good()), '{坏的');
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.startsWith('基线 基线文件不是 JSON'))).toBe(true);
    expect(r.lines.at(-1)).toBe('VERDICT: OK');
  });
});

describe('巡查脚本：只读、读不到 ssh 名字明确失败', () => {
  let home = '';
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = '';
  });

  it('法国上跑的那段 sh 只读：库连接带只读事务，没有写库语句、没有往文件写', () => {
    const s = lib.REMOTE_SCRIPT;
    expect(s).toContain('default_transaction_read_only=on');
    expect(s).not.toMatch(/\b(?:insert|update|delete|drop|alter|truncate|create|grant)\b/i);
    expect(s.replace(/2>&1/g, '')).not.toMatch(/>\s*[/\w]/);
    expect(s.trimEnd().split('\n').at(-1)).toBe('echo end');
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

describe('巡查脚本：发版事故和健康页（2026-10-14 法国发版失败，巡检却报 OK 近一小时）', () => {
  const CUR = `abcd1234${'0'.repeat(32)}`;
  const judge = (o: Partial<SampleOpts>) =>
    lib.judge({ raw: ok(lib.sampleRaw({ at: NOW, ...o })), now: NOW, base: null });
  /** 那次事故的读数：503、发布历史 release→unhealthy→auto-rollback→unhealthy、自动发布说要人看、落后 19 个提交 */
  const incident = {
    healthz: 503,
    healthRed: ['db', 'temporal'],
    hist: [
      `2026-10-14T17:03:00Z ${CUR} release`,
      `2026-10-14T17:05:00Z ${CUR} unhealthy`,
      '2026-10-14T17:06:00Z 1111aaaa auto-rollback',
      '2026-10-14T17:08:00Z 1111aaaa unhealthy',
    ],
    train: 'failed',
    autoNote: '现在不发：上一趟发版是「failed」状态，要人看，不自动再发',
    behind: 19,
    behindMinutes: 90,
  };

  it('【故意造出的失败】重放那次事故（服务 2/2 active、定时任务全 ok，但 /healthz 503）：BROKEN，列出红的检查，不是 OK', async () => {
    const r = await patrol(ok(lib.sampleRaw({ at: NOW, ...incident })), null);
    expect(r.report.verdict).toBe('BROKEN');
    expect(r.code).toBe(2);
    expect(r.report.broken).toContain('/healthz 回 503，红的检查：db、temporal');
    expect(r.report.broken).toContain('最近一次发版是 unhealthy');
    expect(r.report.broken).toContain('发版进度记录停在「failed」');
    expect(r.report.broken).toContain('自动发布处于「要人看」');
    expect(r.lines.at(-1)).toBe('VERDICT: BROKEN');
    expect(r.lines.join(' / ')).toContain('服务 2/2 active');
    // BROKEN 不写基线
    expect(r.saved).toEqual([]);
  });

  it('/healthz 连不上（状态码 000）也是 BROKEN，写明连不上', () => {
    const r = judge({ healthz: 0 });
    expect(r.verdict).toBe('BROKEN');
    expect(r.broken).toContain('/healthz 回 不出来（连不上）');
  });

  it('最近一次发版是 auto-rollback、或 unhealthy：各自 BROKEN；最近一次是 release、recovered 就不是', () => {
    for (const event of ['auto-rollback', 'unhealthy']) {
      const r = judge({
        hist: [`2026-10-14T17:00:00Z ${CUR} release`, `2026-10-14T17:05:00Z 1111aaaa ${event}`],
      });
      expect(r.verdict, event).toBe('BROKEN');
      expect(r.broken).toContain(`最近一次发版是 ${event}`);
    }
    for (const event of ['release', 'recovered', 'rollback']) {
      expect(judge({ hist: [`2026-10-14T17:05:00Z ${CUR} ${event}`] }).verdict, event).toBe('OK');
    }
  });

  it('发版进度记录停在 failed 等 done、aborted 以外的状态：BROKEN；done、aborted、没有这份文件：不是', () => {
    expect(judge({ train: 'failed' }).verdict).toBe('BROKEN');
    expect(judge({ train: 'deploying' }).verdict).toBe('BROKEN');
    for (const t of ['done', 'aborted', '-'])
      expect(judge(t === '-' ? {} : { train: t }).verdict, t).toBe('OK');
  });

  describe('进度记录 running：正常在走不判 BROKEN，超过 LIMITS.trainStuckMinutes 才算（2026-10-14 22:58Z 每趟自动发版都判 BROKEN）', () => {
    const NEW = '2f5dc42f4636fe0a68264eb11ecc39a723e36b7d';
    const RUNNING_NOTE = '现在不发：有一趟发版在跑（2f5dc42f4636），等它收尾';
    const LAST = [`2026-10-14T22:49:55Z ${CUR} release`];
    // 法国打回来的是去掉空白的原 JSON（REMOTE_SCRIPT 里 tr -d '[:space:]'）
    const train = (status: string, startedMinAgo: number | null) =>
      JSON.stringify({
        schema: 1,
        status,
        phase: 4,
        ...(startedMinAgo === null
          ? {}
          : {
              startedAt: new Date(NOW.getTime() - startedMinAgo * 60_000).toISOString(),
              updatedAt: new Date(NOW.getTime() - startedMinAgo * 60_000).toISOString(),
            }),
        target: { kind: 'sha', value: NEW },
      });

    it('进行中 5 分钟：OK；自动发布写的是在跑，不含「要人看」', () => {
      expect(RUNNING_NOTE).not.toContain('要人看');
      const r = judge({ hist: LAST, trainRaw: train('running', 5), autoNote: RUNNING_NOTE });
      expect(r.verdict).toBe('OK');
      expect(r.broken).toBeNull();
    });

    it('【故意造出的失败】超过阈值：BROKEN，写正在发的提交，不写上一版', () => {
      const r = judge({ hist: LAST, trainRaw: train('running', 71), autoNote: RUNNING_NOTE });
      expect(r.verdict).toBe('BROKEN');
      expect(r.broken).toContain('正在发 2f5dc42f4636 的这一趟');
      expect(r.broken).toContain('超过 70 分钟没收尾');
      expect(r.broken).not.toContain('自动发布处于「要人看」');
      expect(judge({ hist: LAST, trainRaw: train('running', 70) }).verdict).toBe('OK');
    });

    it('done 不判（自动发布写的是在跑，不含「要人看」）', () => {
      expect(judge({ hist: LAST, trainRaw: train('done', 300), autoNote: RUNNING_NOTE }).verdict).toBe('OK');
    });

    it('旧格式（只有 status）的 running：判不了多久，照旧 BROKEN，写明老格式', () => {
      const r = judge({ hist: LAST, train: 'running' });
      expect(r.verdict).toBe('BROKEN');
      expect(r.broken).toContain('没有起止时间（老格式）');
      expect(judge({ hist: LAST, trainRaw: train('running', null) }).verdict).toBe('BROKEN');
    });

    it('【故意造出的失败】这一趟落地了（done、current 就是目标），末行「健康检查没过」说的是它：OK；current 不是目标、或退回了：BROKEN（#2207）', () => {
      // sampleRaw 的 current 是 CUR
      const done = JSON.stringify({
        schema: 1,
        status: 'done',
        phase: 8,
        target: { kind: 'sha', value: CUR },
      });
      const r = judge({ hist: [...LAST, `2026-10-14T23:05:30Z ${CUR} unhealthy`], trainRaw: done });
      expect(r.verdict).toBe('OK');
      expect(r.broken).toBeNull();
      const other = JSON.stringify({
        schema: 1,
        status: 'done',
        phase: 8,
        target: { kind: 'sha', value: NEW },
      });
      const r2 = judge({ hist: [...LAST, `2026-10-14T23:05:30Z ${NEW} unhealthy`], trainRaw: other });
      expect(r2.verdict).toBe('BROKEN');
      expect(r2.broken).toContain('最近一次发版是 unhealthy');
      const r3 = judge({ hist: [...LAST, `2026-10-14T23:05:31Z ${CUR} auto-rollback`], trainRaw: done });
      expect(r3.verdict).toBe('BROKEN');
      expect(r3.broken).toContain('最近一次发版是 auto-rollback');
    });

    it('阈值从发版接活脚本各步上限推出来（和引擎看门狗 TRAIN_STUCK_MS 同一条线：不小于各步加起来、最多多 5 分钟余量）', async () => {
      // 引擎那份（packages/engine/src/jobs/release-watch.ts）不在这一组的依赖里，两边各自钉在同一份上限上：
      // packages/engine/test/watchdog.test.ts 对 TRAIN_STUCK_MS 做同样的核对
      const { LIMITS: L } = (await import(
        pathToFileURL(fileURLToPath(new URL('../../deploy/france/release-request/lib.mjs', import.meta.url)))
          .href
      )) as { LIMITS: Record<'releaseMs' | 'deployMs' | 'checkMs' | 'verifyMs' | 'stepMs', number> };
      const { LIMITS } = (await import(pathToFileURL(join(SCRIPTS, 'patrol-lib.mjs')).href)) as {
        LIMITS: { trainStuckMinutes: number };
      };
      const worst = L.releaseMs + L.deployMs + L.checkMs + L.verifyMs + 8 * L.stepMs;
      expect(LIMITS.trainStuckMinutes * 60_000).toBeGreaterThanOrEqual(worst);
      expect(LIMITS.trainStuckMinutes * 60_000).toBeLessThanOrEqual(worst + 5 * 60_000);
    });
  });

  it('自动发布处于「要人看」（只有它这一条，别的都正常）：BROKEN', () => {
    const r = judge({ autoNote: '现在不发：上一趟发版是「failed」状态，要人看，不自动再发' });
    expect(r.verdict).toBe('BROKEN');
    expect(r.broken).toContain('自动发布处于「要人看」');
  });

  it('落后主线超过 5 个提交且最老的落下超过 60 分钟：ALERT（不是 BROKEN）；任何一条没到线都不报', () => {
    const r = judge({ behind: 8, behindMinutes: 90 });
    expect(r.verdict).toBe('ALERT');
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toContain('落后主线 8 个提交');
    expect(judge({ behind: 8, behindMinutes: 30 }).verdict).toBe('OK');
    expect(judge({ behind: 5, behindMinutes: 300 }).verdict).toBe('OK');
    expect(judge({ behind: 0 }).verdict).toBe('OK');
  });

  it('在用的版本不在主线最近的提交里：ALERT，不当成没落后', () => {
    const raw = lib.sampleRaw({ at: NOW }).replace(/^cur\|.*$/m, `cur|${'9'.repeat(40)}`);
    const r = lib.judge({ raw: ok(raw), now: NOW, base: null });
    expect(r.verdict).toBe('ALERT');
    expect(r.alerts[0]).toContain('不在主线最近');
  });

  it('【故意造出的失败】读不到这几块（没有发布历史、没有自动发布状态、进度记录不是 JSON、少了健康页那行）：都是 BROKEN，不当 OK', () => {
    expect(judge({ noHist: true }).verdict).toBe('BROKEN');
    expect(judge({ noState: true }).verdict).toBe('BROKEN');
    expect(judge({ trainRaw: '{坏的' }).verdict).toBe('BROKEN');
    const noHealthz = lib.sampleRaw({ at: NOW }).replace(/^healthz\|.*$/m, '');
    const r = lib.judge({ raw: ok(noHealthz), now: NOW, base: null });
    expect(r.verdict).toBe('BROKEN');
    expect(r.broken).toContain('healthz');
  });

  it('远端那段 sh 读这几样：问 /healthz、读 .history、.train、.auto/state.json（都是读）', () => {
    const s = lib.REMOTE_SCRIPT;
    expect(s).toContain('http://10.99.0.2:8787/healthz');
    expect(s).toContain('/srv/fleet-dao-releases/.history');
    expect(s).toContain('/srv/fleet-dao-releases/.train/release-train.json');
    expect(s).toContain('/srv/fleet-dao-releases/.auto/state.json');
    expect(s).not.toMatch(/curl.*(?:-X|--data|-d )/);
  });
});

describe('巡查脚本：发版文件原样传回来（回归：sh 的 echo 会把 JSON 字符串里的 \\n 变成真换行，法国回来的进度记录就「不是 JSON」）', () => {
  /** 进度记录、状态文件里字符串内有转义的 \n、\t、\"、反斜杠：法国上真实的 why 字段就带 */
  const train = JSON.stringify(
    { status: 'failed', why: 'release.sh 第一行\n第二行\t制表\r"引号"\\反斜杠' },
    null,
    2,
  );
  const state = JSON.stringify(
    {
      main: { commits: [['a'.repeat(40), '2026-10-14T17:00:00Z']] },
      auto: { note: '现在不发：要人看\n换行' },
    },
    null,
    1,
  );
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  /** 真用 sh 跑远端脚本里读这两份文件的两行（把发布目录换成临时目录），回它们打出来的行 */
  function runRemoteLines(): string[] {
    dir = mkdtempSync(join(tmpdir(), 'patrol-rel-'));
    mkdirSync(join(dir, '.train'));
    mkdirSync(join(dir, '.auto'));
    writeFileSync(join(dir, '.train', 'release-train.json'), train);
    writeFileSync(join(dir, '.auto', 'state.json'), state);
    const rel = dir.replaceAll('\\', '/');
    const lines = lib.REMOTE_SCRIPT.split('\n').filter((l) => /^if \[ -r \S+\/\.(train|auto)\//.test(l));
    expect(lines).toHaveLength(2);
    const script = lines.map((l) => l.replaceAll('/srv/fleet-dao-releases', rel)).join('\n');
    return runChildOk('sh', ['-c', script])
      .split('\n')
      .filter((l) => l !== '');
  }

  it('进度记录、状态文件各占一行、能 JSON.parse，内容（去掉空白后）和原文件一致', () => {
    const out = runRemoteLines();
    expect(out).toHaveLength(2);
    const [t, s] = out as [string, string];
    expect(t.startsWith('train|')).toBe(true);
    expect(s.startsWith('state|')).toBe(true);
    expect(JSON.parse(t.slice('train|'.length)).why).toContain('第一行\n第二行');
    expect(JSON.parse(s.slice('state|'.length)).auto.note).toBe('现在不发：要人看\n换行');
  });

  it('传回来的整屏过 parseRaw 不报「不是 JSON」（落后、自动发布「要人看」照样判出）', () => {
    const [t, s] = runRemoteLines();
    const raw = lib
      .sampleRaw({ at: NOW })
      .replace(/^train\|.*$/m, t ?? '')
      .replace(/^state\|.*$/m, s ?? '');
    const p = lib.parseRaw(raw);
    expect(p.ok, p.ok ? '' : p.why).toBe(true);
  });

  it('远端脚本里读这两份文件不用 echo（dash 的 echo 会解释反斜杠）', () => {
    for (const l of lib.REMOTE_SCRIPT.split('\n').filter((x) => /\.(train|auto)\//.test(x)))
      expect(l).not.toMatch(/then echo "(train|state)\|\$\(/);
  });
});
