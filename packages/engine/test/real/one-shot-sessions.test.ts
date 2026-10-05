// 三段一次性会话的登记（real/one-shot-sessions.ts，#59、#957）：切号照它停下跑在带组织类型的池上的那一段、等它们都收场；
// 发布排空照它看手上还有几段在动手、验收，到点不分池停下。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEngineDrain } from '../../src/drain.ts';
import { oneShotSessions } from '../../src/real/one-shot-sessions.ts';

const pools = (...ids: string[]) => new Set(ids);
const who = (poolId: string) => ({ poolId, stage: 'execute', taskId: 'task-1' });

describe('oneShotSessions：一段从定了路由起登记，收场走', () => {
  it('还没起会话的用登记号认，起了会话换成 runs 的编号；只看问到的池', () => {
    const reg = oneShotSessions();
    const a = reg.enter(who('claude-carpool'));
    const b = reg.enter(who('relay'));
    expect(reg.live(pools('claude-carpool'))).toEqual(['one-shot-1']);
    a.attempt('run-a');
    expect(reg.live(pools('claude-carpool', 'claude-solo'))).toEqual(['run-a']);
    expect(reg.live(pools('relay'))).toEqual(['one-shot-2']);
    b.leave();
    expect(reg.live(pools('relay'))).toEqual([]);
  });

  it('stop：只停问到的池上的，信号带着为什么；已经叫停的不重复叫停；收场之后不在 live 里', () => {
    const reg = oneShotSessions();
    const car = reg.enter(who('claude-carpool'));
    car.attempt('run-car');
    const other = reg.enter(who('relay'));
    expect(reg.stop(pools('claude-carpool', 'claude-solo'), '切号：拼车切到独享')).toEqual(['run-car']);
    expect(car.signal.aborted).toBe(true);
    expect((car.signal.reason as Error).message).toBe('切号：拼车切到独享');
    expect(other.signal.aborted).toBe(false);
    // 再叫一遍：已经在停的不算这一次叫停的，但没收场就还在 live 里（切号要等它收场）
    expect(reg.stop(pools('claude-carpool'), '又一次')).toEqual([]);
    expect(reg.live(pools('claude-carpool'))).toEqual(['run-car']);
    car.leave();
    car.leave();
    expect(reg.live(pools('claude-carpool'))).toEqual([]);
  });
});

describe('发布排空的在途清单（#957）：登记就 track、收场一定 settle', () => {
  it('登记进清单（带阶段、单、在起）；起了会话换成 runs 的编号；进程要起了改成在跑；收场撤掉，撤几次都行', () => {
    const drain = createEngineDrain();
    const reg = oneShotSessions({ drain, now: () => new Date('2026-10-05T00:00:00Z') });
    const t = reg.enter({ poolId: 'p1', stage: 'review', taskId: 'task-9' });
    expect(drain.inFlight()).toEqual([
      {
        runId: 'one-shot-1',
        stage: 'review',
        taskId: 'task-9',
        phase: 'starting',
        since: '2026-10-05T00:00:00.000Z',
      },
    ]);
    t.attempt('run-1');
    expect(drain.inFlight().map((s) => [s.runId, s.phase])).toEqual([['run-1', 'starting']]);
    // 同一个编号再报一次不重复
    t.attempt('run-1');
    t.running();
    expect(drain.inFlight().map((s) => [s.runId, s.phase])).toEqual([['run-1', 'running']]);
    // 内存放不下、换新编号再试：清单里还是一条
    t.attempt('run-2');
    expect(drain.inFlight().map((s) => [s.runId, s.phase])).toEqual([['run-2', 'running']]);
    t.leave();
    t.leave();
    expect(drain.inFlight()).toEqual([]);
    // 收场之后再报编号、改阶段都不能把它登记回来
    t.attempt('run-3');
    t.running();
    expect(drain.inFlight()).toEqual([]);
  });

  it('drainStop：不分池，没叫停过的全停下，信号带着「发布排空」；已经叫停的不重复；没收场前还在清单里', () => {
    const drain = createEngineDrain();
    const reg = oneShotSessions({ drain });
    const a = reg.enter(who('claude-carpool'));
    a.attempt('run-a');
    const b = reg.enter(who('relay'));
    b.attempt('run-b');
    expect(reg.drainStop('到了发布宽限的截止').sort()).toEqual(['run-a', 'run-b']);
    expect((a.signal.reason as Error).message).toContain('发布排空：到了发布宽限的截止');
    expect(reg.drainStop('再来一次')).toEqual([]);
    expect(drain.inFlight()).toHaveLength(2);
    a.leave();
    b.leave();
    expect(drain.inFlight()).toEqual([]);
  });

  it('已经在排空时才登记：信号一开始就是响的（不起会话），照样登记、收场照样撤', () => {
    const drain = createEngineDrain();
    drain.cordon({ source: 'release', since: 'x', until: 'y', why: '发布 aaaa' });
    const reg = oneShotSessions({ drain });
    const t = reg.enter(who('p1'));
    expect(t.signal.aborted).toBe(true);
    expect((t.signal.reason as Error).message).toContain('要发新版本');
    expect(drain.inFlight()).toHaveLength(1);
    t.leave();
    expect(drain.inFlight()).toEqual([]);
  });

  it('不接 drain 的（只有测试）：什么都照常，不抛', () => {
    const reg = oneShotSessions();
    const t = reg.enter(who('p1'));
    t.attempt('run-x');
    t.running();
    expect(reg.drainStop('x')).toEqual(['run-x']);
    t.leave();
  });
});

describe('【故意造出的失败】生产装配漏接排空：real/index.ts 必须把 drain 交给登记、到点停会话也要停一次性会话', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/real/index.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('oneShotSessions 带着 extra.drain 起；stopSessions 里有 oneShots.drainStop', () => {
    expect(source).toMatch(/oneShotSessions\(\{[^)]*extra\.drain[^)]*\}\)/);
    expect(source).toMatch(/stopSessions:[^\n]*oneShots\.drainStop\(/);
  });

  it('检查本身有牙：把那两处拿掉，同一个检查会红', () => {
    const without = source
      .replace(
        'oneShotSessions({ ...(extra.drain ? { drain: extra.drain } : {}), master })',
        'oneShotSessions()',
      )
      .replace('stopSessions: (why) => oneShots.drainStop(why)', 'stopSessions: () => []');
    expect(without).not.toBe(source);
    expect(without).not.toMatch(/oneShotSessions\(\{[^)]*extra\.drain[^)]*\}\)/);
    expect(without).not.toMatch(/stopSessions:[^\n]*oneShots\.drainStop\(/);
  });
});

describe('【故意造出的失败】生产装配漏接引擎总开关（#1086）：real/index.ts 必须把 master 交给选路和一次性会话登记', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/real/index.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('createRealPorts 带着 master（选路读它）、oneShotSessions 带着 master（登记读它）、对外把 master 给 worker（定时器入口读它）', () => {
    expect(source).toMatch(/createRealPorts\(\{[^}]*\bmaster,/);
    expect(source).toMatch(/oneShotSessions\(\{[^\n]*\bmaster \}\)/);
    expect(source).toMatch(/\n\s+master,\n\s+recordSkippedRun:/);
  });

  it('检查本身有牙：把 master 从任何一处拿掉，同一个检查会红', () => {
    const noPicker = source.replace(/createRealPorts\(\{(\s*)db,(\s*)master,/, 'createRealPorts({$1db,');
    expect(noPicker).not.toBe(source);
    expect(noPicker).not.toMatch(/createRealPorts\(\{[^}]*\bmaster,/);
    const noEnter = source.replace(', master })', ' })');
    expect(noEnter).not.toBe(source);
    expect(noEnter).not.toMatch(/oneShotSessions\(\{[^\n]*\bmaster \}\)/);
  });
});
