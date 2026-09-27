// 排空（drain.ts、drain-control.ts、drain-file.ts、worker.ts 的停机信号）：不起新会话、截止只提前不推后、停机信号撤不掉、
// 到截止停下还在跑的、第二次信号马上停；请求认不出、锁查不成、状态文件写不进的路径各有一条故意造出失败的。
// 还核对 systemd 单元和发布脚本跟这里的常量对得上（KillMode=mixed、TimeoutStopSec 盖住宽限加收尾、release.sh 的宽限同一个数）。

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Cordon,
  createEngineDrain,
  DRAIN_POLL_MS,
  drainStatus,
  RELEASE_GRACE_MS,
  STOP_REPORT_MS,
  waitDrained,
} from '../src/drain.ts';
import {
  createDrainControl,
  type DrainEvent,
  judgeRequest,
  parseDrainRequest,
  REQUEST_STALE_MS,
  type RequestSeen,
  readDrainRequest,
  shaOfDir,
} from '../src/drain-control.ts';
import { startDrainStatusFile } from '../src/drain-file.ts';
import { drainAlertText } from '../src/real/drain-alerts.ts';
import { installGracefulShutdown, type SignalSource } from '../src/worker.ts';

const T0 = Date.parse('2026-09-28T01:30:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const SHA = 'c'.repeat(40);
const release = (until = T0 + RELEASE_GRACE_MS): Cordon => ({
  source: 'release',
  since: iso(T0),
  until: iso(until),
  why: '发布 cccccccccccc（auto）',
  sha: SHA,
});
const session = (runId: string) => ({
  runId,
  stage: 'execute',
  taskId: 't1',
  phase: 'running' as const,
  since: iso(T0),
});

describe('排空状态', () => {
  it('截止只提前不推后；停机信号接手后撤不掉；发布来的撤得掉', () => {
    const d = createEngineDrain();
    expect(d.cordon(release())).toBe(true);
    expect(d.cordon(release(T0 + 20 * 60_000))).toBe(false);
    expect(d.stopping()?.until).toBe(iso(T0 + RELEASE_GRACE_MS));
    expect(d.cordon(release(T0 + 60_000))).toBe(true);
    expect(d.stopping()?.until).toBe(iso(T0 + 60_000));
    expect(d.overdue(T0)).toBe(false);
    expect(d.overdue(T0 + 60_000)).toBe(true);
    // 停机信号接手：撤不掉
    d.cordon({ source: 'signal', since: iso(T0), until: iso(T0 + RELEASE_GRACE_MS), why: '收到 SIGTERM' });
    expect(d.stopping()).toMatchObject({ source: 'signal', until: iso(T0 + 60_000) });
    expect(d.lift()).toBe(false);
    const r = createEngineDrain();
    r.cordon(release());
    expect(r.lift()).toBe(true);
    expect(r.stopping()).toBeNull();
  });

  it('截止认不出当已经到了（宁可早停、按编号续上，不一直等）', () => {
    const d = createEngineDrain();
    d.cordon({ ...release(), until: '不是时间' });
    expect(d.overdue(T0)).toBe(true);
  });

  it('只数登记着的会话：交回了就不等（在等额度、等空位的单子不在这里，照常算空闲）', () => {
    const d = createEngineDrain();
    d.track(session('r1'));
    d.track(session('r2'));
    d.settle('r1');
    d.settle('没登记过的');
    expect(d.inFlight().map((s) => s.runId)).toEqual(['r2']);
    expect(drainStatus(d, { pid: 42, nowMs: T0 })).toMatchObject({
      schema: 2,
      pid: 42,
      cordon: null,
      overdue: false,
    });
  });
});

describe('停机时等排空（waitDrained）', () => {
  const fakeTime = () => {
    let now = T0;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
  };

  it('手上没会话马上结束', async () => {
    const d = createEngineDrain();
    d.cordon(release());
    const r = await waitDrained(d, { stopSessions: () => [], forced: () => false, ...fakeTime() });
    expect(r).toEqual({ end: 'empty', left: [] });
  });

  it('截止之前不停；到截止叫停，交回了就结束', async () => {
    const d = createEngineDrain();
    d.cordon(release());
    d.track(session('r1'));
    const time = fakeTime();
    const stopCalls: number[] = [];
    const r = await waitDrained(d, {
      ...time,
      forced: () => false,
      stopSessions: () => {
        stopCalls.push(time.now());
        // 叫停后看守交回
        d.settle('r1');
        return ['r1'];
      },
    });
    expect(r.end).toBe('empty');
    expect(stopCalls).toEqual([T0 + RELEASE_GRACE_MS]);
  });

  it('到截止叫停了、看守一直不交回：等 STOP_REPORT_MS 照停，交回还剩谁', async () => {
    const d = createEngineDrain();
    d.cordon(release());
    d.track(session('stuck'));
    const time = fakeTime();
    const r = await waitDrained(d, { ...time, forced: () => false, stopSessions: () => [] });
    expect(r.end).toBe('overdue');
    expect(r.left.map((s) => s.runId)).toEqual(['stuck']);
    expect(time.now()).toBeGreaterThanOrEqual(T0 + RELEASE_GRACE_MS + STOP_REPORT_MS);
    expect(time.now()).toBeLessThan(T0 + RELEASE_GRACE_MS + STOP_REPORT_MS + 2 * DRAIN_POLL_MS);
  });
});

class FakeSignals implements SignalSource {
  readonly e = new EventEmitter();
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void) {
    this.e.on(signal, handler);
  }
  off(signal: 'SIGTERM' | 'SIGINT', handler: () => void) {
    this.e.off(signal, handler);
  }
  send(signal: 'SIGTERM' | 'SIGINT') {
    this.e.emit(signal);
  }
}

describe('停机信号（installGracefulShutdown）', () => {
  const fakeWorker = () => {
    const w = { state: 'RUNNING', shutdowns: 0 };
    return {
      w,
      worker: {
        getState: () => w.state as 'RUNNING',
        shutdown: () => {
          w.shutdowns += 1;
          w.state = 'STOPPING';
        },
      },
    };
  };

  it('第一次 SIGTERM：不起新会话、等会话交回再让工人停下，不马上停', async () => {
    const d = createEngineDrain();
    d.track(session('r1'));
    const s = new FakeSignals();
    const { w, worker } = fakeWorker();
    const logs: string[] = [];
    let wake: () => void = () => {};
    const g = installGracefulShutdown({
      worker,
      drain: d,
      stopSessions: () => [],
      log: (m) => logs.push(m),
      signals: s,
      now: () => T0,
      sleep: (_ms, woken) =>
        new Promise((resolve) => {
          wake = resolve;
          void woken.then(resolve);
        }),
    });
    s.send('SIGTERM');
    expect(d.stopping()).toMatchObject({ source: 'signal', until: iso(T0 + RELEASE_GRACE_MS) });
    await Promise.resolve();
    expect(w.shutdowns).toBe(0);
    d.settle('r1');
    expect(await g.done).toBe('empty');
    expect(w.shutdowns).toBe(1);
    expect(logs[0]).toContain('不起新会话');
    wake();
    g.dispose();
  });

  it('第二次 SIGTERM（或 SIGINT）：马上停下会话、让工人停下', async () => {
    const d = createEngineDrain();
    d.track(session('r1'));
    const s = new FakeSignals();
    const { w, worker } = fakeWorker();
    const stopped: string[] = [];
    const g = installGracefulShutdown({
      worker,
      drain: d,
      stopSessions: (why) => {
        stopped.push(why);
        return ['r1'];
      },
      log: () => {},
      signals: s,
      now: () => T0,
      sleep: () => new Promise(() => {}),
    });
    s.send('SIGTERM');
    s.send('SIGTERM');
    expect(await g.done).toBe('forced');
    expect(w.shutdowns).toBe(1);
    expect(stopped).toEqual(['收到 第二次 SIGTERM，马上停']);
    expect(d.overdue(T0)).toBe(true);
    g.dispose();
  });

  it('发布请求的截止更早：停机信号不把它往后挪', () => {
    const d = createEngineDrain();
    d.cordon(release(T0 + 60_000));
    const s = new FakeSignals();
    const { worker } = fakeWorker();
    const g = installGracefulShutdown({
      worker,
      drain: d,
      stopSessions: () => [],
      log: () => {},
      signals: s,
      now: () => T0,
      sleep: () => new Promise(() => {}),
    });
    d.track(session('r1'));
    s.send('SIGTERM');
    expect(d.stopping()).toMatchObject({ source: 'signal', until: iso(T0 + 60_000) });
    g.dispose();
  });
});

describe('排空请求（发布脚本写的 .drain-request）', () => {
  const good = { schema: 1, sha: SHA, requestedAt: iso(T0), until: iso(T0 + RELEASE_GRACE_MS), by: 'auto' };

  it('认得出的请求；每一项不对都写明是哪一项', () => {
    expect(parseDrainRequest(JSON.stringify(good))).toEqual({
      sha: SHA,
      requestedAt: good.requestedAt,
      until: good.until,
      by: 'auto',
    });
    expect(() => parseDrainRequest('{')).toThrow('不是 JSON');
    expect(() => parseDrainRequest(JSON.stringify({ ...good, schema: 2 }))).toThrow('schema');
    expect(() => parseDrainRequest(JSON.stringify({ ...good, sha: 'abc' }))).toThrow('sha');
    expect(() => parseDrainRequest(JSON.stringify({ ...good, until: '明天' }))).toThrow('until');
    expect(() => parseDrainRequest(JSON.stringify({ ...good, by: ' ' }))).toThrow('by');
  });

  it('文件不在 = 没有请求；读不成、认不出 = bad（不当成没有）', async () => {
    const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(await readDrainRequest('/x', async () => Promise.reject(enoent))).toEqual({ kind: 'none' });
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(await readDrainRequest('/x', async () => Promise.reject(denied))).toMatchObject({
      kind: 'bad',
      why: expect.stringContaining('读不成'),
    });
    expect(await readDrainRequest('/x', async () => 'garbage')).toMatchObject({
      kind: 'bad',
      why: expect.stringContaining('认不出'),
    });
  });

  const ok: RequestSeen = {
    kind: 'ok',
    request: { sha: SHA, requestedAt: iso(T0), until: iso(T0 + RELEASE_GRACE_MS), by: 'auto' },
  };

  it('锁占着：认；锁空着：旧请求，不认；锁查不成：没过期才认', () => {
    expect(judgeRequest(ok, true, null, T0)).toMatchObject({
      kind: 'cordon',
      cordon: { source: 'release', sha: SHA },
    });
    expect(judgeRequest(ok, false, null, T0)).toMatchObject({
      kind: 'ignore',
      why: expect.stringContaining('发布锁空着'),
    });
    expect(judgeRequest(ok, undefined, null, T0)).toMatchObject({
      kind: 'cordon',
      note: expect.stringContaining('没查成'),
    });
    expect(judgeRequest(ok, undefined, null, T0 + RELEASE_GRACE_MS + REQUEST_STALE_MS + 1)).toMatchObject({
      kind: 'ignore',
      why: expect.stringContaining('过去太久'),
    });
  });

  it('要切到的就是自己这一版：不认（切完新引擎起来那一下）', () => {
    expect(judgeRequest(ok, true, SHA, T0)).toMatchObject({
      kind: 'ignore',
      why: expect.stringContaining('就是在跑的'),
    });
  });

  it('认不出的请求：锁占着按默认宽限排空；锁空着、查不成都不认', () => {
    const bad: RequestSeen = { kind: 'bad', why: '认不出：不是 JSON' };
    expect(judgeRequest(bad, true, null, T0)).toMatchObject({
      kind: 'cordon',
      cordon: { until: iso(T0 + RELEASE_GRACE_MS) },
    });
    expect(judgeRequest(bad, false, null, T0).kind).toBe('ignore');
    expect(judgeRequest(bad, undefined, null, T0).kind).toBe('ignore');
  });

  it('没有请求：absent', () => {
    expect(judgeRequest({ kind: 'none' }, undefined, null, T0)).toEqual({ kind: 'absent' });
  });

  it('引擎认自己的版本：发布目录下的提交号目录；别的认不出', () => {
    expect(shaOfDir(`/srv/fleet-dao-releases/${SHA}`)).toBe(SHA);
    expect(shaOfDir(`/srv/fleet-dao-releases/${SHA}/`)).toBe(SHA);
    expect(shaOfDir('/srv/fleet-dao')).toBeNull();
  });
});

describe('排空的控制（createDrainControl）', () => {
  const rig = () => {
    const d = createEngineDrain();
    let req: RequestSeen = { kind: 'none' };
    let now = T0;
    const events: DrainEvent[] = [];
    const logs: string[] = [];
    const stops: string[] = [];
    let notifyFails = false;
    const c = createDrainControl({
      drain: d,
      readRequest: async () => req,
      releaseLockBusy: async () => true,
      ownSha: null,
      stopSessions: (why) => {
        stops.push(why);
        return d.inFlight().map((s) => s.runId);
      },
      notify: async (e) => {
        if (notifyFails) throw new Error('库连不上');
        events.push(e);
      },
      log: (m) => logs.push(m),
      now: () => now,
    });
    return {
      d,
      c,
      events,
      logs,
      stops,
      set: (r: RequestSeen) => {
        req = r;
      },
      at: (ms: number) => {
        now = ms;
      },
      failNotify: () => {
        notifyFails = true;
      },
    };
  };
  const req = (until = T0 + RELEASE_GRACE_MS): RequestSeen => ({
    kind: 'ok',
    request: { sha: SHA, requestedAt: iso(T0), until: iso(until), by: 'manual' },
  });

  it('开始只报一次提醒；截止之前不停，到了截止停下在跑的；请求撤了撤掉排空、报一次', async () => {
    const r = rig();
    r.d.track(session('r1'));
    r.set(req());
    await r.c.tick();
    await r.c.tick();
    expect(r.events.map((e) => e.kind)).toEqual(['start']);
    expect(r.stops).toEqual([]);
    r.at(T0 + RELEASE_GRACE_MS);
    await r.c.tick();
    expect(r.stops).toHaveLength(1);
    expect(r.logs.some((l) => l.includes('r1'))).toBe(true);
    r.set({ kind: 'none' });
    await r.c.tick();
    expect(r.d.stopping()).toBeNull();
    expect(r.events.map((e) => e.kind)).toEqual(['start', 'lift']);
  });

  it('提醒写不进去：排空照做，日志写明', async () => {
    const r = rig();
    r.failNotify();
    r.set(req());
    await r.c.tick();
    expect(r.d.stopping()).not.toBeNull();
    expect(r.logs.join('\n')).toContain('提醒没写进去');
  });

  it('读请求抛了：当认不出处理（锁占着照默认宽限排空），不当成没有请求', async () => {
    const d = createEngineDrain();
    const c = createDrainControl({
      drain: d,
      readRequest: async () => {
        throw new Error('磁盘坏了');
      },
      releaseLockBusy: async () => true,
      ownSha: null,
      stopSessions: () => [],
      log: () => {},
      now: () => T0,
    });
    await c.tick();
    expect(d.stopping()).toMatchObject({ until: iso(T0 + RELEASE_GRACE_MS) });
  });
});

describe('排空状态文件（drain.json）', () => {
  it('起来先写一份，排空开始当场改写；写不进去记日志、只记一次', async () => {
    const d = createEngineDrain();
    const writes: string[] = [];
    const logs: string[] = [];
    let fail = false;
    const f = startDrainStatusFile({
      drain: d,
      file: '/state/drain.json',
      pid: 7,
      now: () => T0,
      log: (m) => logs.push(m),
      write: async (_file, text) => {
        if (fail) throw new Error('只读文件系统');
        writes.push(text);
      },
    });
    await f.flush();
    expect(JSON.parse(writes[0] ?? '{}')).toMatchObject({ schema: 2, pid: 7, cordon: null });
    d.cordon(release());
    await f.flush();
    expect(JSON.parse(writes.at(-1) ?? '{}')).toMatchObject({ cordon: { source: 'release', sha: SHA } });
    fail = true;
    d.track(session('r1'));
    await f.flush();
    d.track(session('r2'));
    await f.flush();
    expect(logs.filter((l) => l.includes('写不进'))).toHaveLength(1);
    f.stop();
  });
});

describe('排空的提醒文案', () => {
  it('写截止、在跑几个；不写会变的倒计时以外的东西', () => {
    const text = drainAlertText({ kind: 'start', cordon: release(), inFlight: [session('r1')] }, '法国', T0);
    expect(text.title).toContain(iso(T0 + RELEASE_GRACE_MS));
    expect(text.body).toContain('约 10 分钟');
    expect(text.body).toContain('手上 1 个会话在跑');
    expect(text.body).toContain('在等额度');
  });
});

describe('和 systemd 单元、发布脚本对得上', () => {
  const unit = readFileSync(new URL('../../../deploy/france/fleet-engine.service', import.meta.url), 'utf8');
  const releaseSh = readFileSync(new URL('../../../deploy/release.sh', import.meta.url), 'utf8');

  it('KillMode=mixed：停机信号只发给引擎主进程，不经 sudo 转给会话', () => {
    expect(unit).toMatch(/^KillMode=mixed$/m);
  });

  it('TimeoutStopSec 盖住宽限、叫停后等交回、工人收尾（30 秒）再留余量', () => {
    const m = /^TimeoutStopSec=(\d+)min$/m.exec(unit);
    expect(m).not.toBeNull();
    const stopMs = Number(m?.[1]) * 60_000;
    expect(stopMs).toBeGreaterThanOrEqual(RELEASE_GRACE_MS + STOP_REPORT_MS + 30_000 + 60_000);
  });

  it('发布脚本的宽限和引擎同一个数', () => {
    const m = /^DRAIN_GRACE=(\d+)\b/m.exec(releaseSh);
    expect(Number(m?.[1]) * 1000).toBe(RELEASE_GRACE_MS);
    const n = /^DRAIN_REQUEST=\$RELEASES\/(\S+)/m.exec(releaseSh);
    expect(n?.[1]).toBe('.drain-request');
  });
});
