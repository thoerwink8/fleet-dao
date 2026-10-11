// 派前探测 + 换下一条（#1798 片 4）：选到一条就派前探一次，不通就避开它再选，一轮最多 3 条真探。
// 验收（real/task-verify.ts 经 cold-verify-pick.ts）和整理待办（real/groom.ts）共用这一份。
import { describe, expect, it } from 'vitest';
import type { PickRouteResult, RouteChoice } from '../src/ports.ts';
import {
  createProbeBudget,
  PICK_THEN_PROBE_LIMIT,
  type PickThenProbeFailure,
  pickThenProbe,
  pickThenProbeStopText,
} from '../src/real/pick-then-probe.ts';
import type { ProbeAssignedResult } from '../src/task-contract.ts';

const routeOf = (routeId: string, family = 'claude'): RouteChoice => ({
  routeId,
  poolId: `p-${routeId}`,
  modelId: `m-${routeId}`,
  family,
  hostId: 'claude-code',
});

/** 造一个按顺序交回候选的假选路：避开名单里的一律跳过（和真选路一个口径）。 */
function line(routeIds: readonly string[]) {
  const asked: string[][] = [];
  const pick = async (avoid: readonly string[]): Promise<PickRouteResult> => {
    asked.push([...avoid]);
    const next = routeIds.find((id) => !avoid.includes(id));
    if (next === undefined) return { ok: false, waitFor: 'none', detail: '避开之后一条都没有了' };
    return { ok: true, route: routeOf(next), why: `第 ${asked.length} 次问` };
  };
  return { pick, asked };
}

/** 探针：`pass` 里的探通，其余按不通（counted 默认真探）。 */
function prober(pass: readonly string[], counted = true) {
  const probed: string[] = [];
  const probe = async (input: { routeId: string; label: string }): Promise<ProbeAssignedResult> => {
    probed.push(input.routeId);
    if (pass.includes(input.routeId)) {
      return { kind: 'pass', label: input.label, detail: '答上了：OK', probed: true };
    }
    return { kind: 'fail', label: input.label, detail: `${input.routeId} 网络不通`, counted };
  };
  return { probe, probed };
}

describe('pickThenProbe：探通就交回', () => {
  it('第一条就探通：不再选、不占 3 条以外的名额', async () => {
    const { pick, asked } = line(['a', 'b']);
    const { probe, probed } = prober(['a']);
    const got = await pickThenProbe({ pick, probe });
    expect(got.kind).toBe('picked');
    if (got.kind !== 'picked') return;
    expect(got.route.routeId).toBe('a');
    expect(got.failures).toEqual([]);
    expect(probed).toEqual(['a']);
    expect(asked.length).toBe(1);
  });

  it('第一条不通、第二条通：避开第一条再选，失败名单带上第一条', async () => {
    const { pick, asked } = line(['a', 'b']);
    const { probe, probed } = prober(['b']);
    const got = await pickThenProbe({ pick, probe });
    expect(got.kind).toBe('picked');
    if (got.kind !== 'picked') return;
    expect(got.route.routeId).toBe('b');
    expect(got.failures).toEqual([{ routeId: 'a', label: 'm-a', detail: 'a 网络不通' }]);
    expect(probed).toEqual(['a', 'b']);
    // 第二次问选路时避开了第一条
    expect(asked[1]).toEqual(['a']);
  });

  it('探不通的那一条：当场放掉它预占的池名额（没进起会话，不占着池）', async () => {
    const { pick } = line(['a', 'b']);
    const { probe } = prober(['b']);
    const released: string[] = [];
    const got = await pickThenProbe({
      pick,
      probe,
      onUnprobed: async (route) => {
        released.push(route.routeId);
      },
    });
    expect(got.kind).toBe('picked');
    expect(released).toEqual(['a']);
  });
});

describe('pickThenProbe：探不通时换下一条、三条都不通就派不出', () => {
  it('三条都不通：回 exhausted，带上每一条的结果（谁、为什么）', async () => {
    const { pick } = line(['a', 'b', 'c', 'd']);
    const { probe, probed } = prober([]);
    const got = await pickThenProbe({ pick, probe });
    expect(got.kind).toBe('exhausted');
    if (got.kind !== 'exhausted') return;
    expect(probed).toEqual(['a', 'b', 'c']);
    expect(got.failures.map((f) => f.routeId)).toEqual(['a', 'b', 'c']);
    expect(got.failures.map((f) => f.detail)).toEqual(['a 网络不通', 'b 网络不通', 'c 网络不通']);
    expect(PICK_THEN_PROBE_LIMIT).toBe(3);
    expect(pickThenProbeStopText(got.failures)).toContain(
      '派前探测：m-a 不通（a 网络不通）；m-b 不通（b 网络不通）；m-c 不通（c 网络不通）',
    );
  });

  it('没真探的不占 3 条名额：counted 为假的一直换到 selection 自己说派不出', async () => {
    const { pick } = line(['a', 'b', 'c', 'd']);
    const { probe, probed } = prober([], false); // 每一条都「不占名额」（组织认不出、路由被删了）
    const got = await pickThenProbe({ pick, probe });
    // 4 条候选都探过（没占名额），选路第 5 次回「派不出」
    expect(probed).toEqual(['a', 'b', 'c', 'd']);
    expect(got.kind).toBe('unavailable');
    if (got.kind !== 'unavailable') return;
    expect(got.result.detail).toBe('避开之后一条都没有了');
    expect(got.failures.length).toBe(4);
  });

  it('选路一开始就说派不出（等空位、一条能用的都没有）：不探，原样交回', async () => {
    const pick = async (): Promise<PickRouteResult> => ({
      ok: false,
      waitFor: 'slot',
      detail: '这一族没空位',
    });
    const { probe, probed } = prober([]);
    const got = await pickThenProbe({ pick, probe });
    expect(got.kind).toBe('unavailable');
    if (got.kind !== 'unavailable') return;
    expect(got.result.detail).toBe('这一族没空位');
    expect(probed).toEqual([]);
  });
});

describe('pickThenProbe：跨调用共用的名额（验收按族问好几轮）', () => {
  it('budget 跨调用共用：第一族用满 3 条，第二族一条也不探', async () => {
    const budget = createProbeBudget();
    // 第一族：a、b、c 都不通 → 用满 3 条
    const first = line(['a', 'b', 'c', 'd']);
    const p1 = prober([]);
    const one = await pickThenProbe({ pick: first.pick, probe: p1.probe, budget });
    expect(one.kind).toBe('exhausted');
    expect(budget.probed).toBe(3);
    // 第二族：名额已满，一条也不探，直接派不出
    const second = line(['x', 'y']);
    const p2 = prober(['x']);
    const two = await pickThenProbe({ pick: second.pick, probe: p2.probe, budget });
    expect(two.kind).toBe('exhausted');
    expect(p2.probed).toEqual([]);
  });

  it('返工：探通的那条也占名额——第一族 2 条不通、第 3 条探通，第二族不再有 3 条可探', async () => {
    const budget = createProbeBudget();
    // 第一族：a、b 不通，c 探通 → 真探 3 条（含探通的 c）
    const first = line(['a', 'b', 'c']);
    const p1 = prober(['c']);
    const one = await pickThenProbe({ pick: first.pick, probe: p1.probe, budget });
    expect(one.kind).toBe('picked');
    expect(p1.probed).toEqual(['a', 'b', 'c']);
    expect(budget.probed).toBe(3);
    // 第二族：名额已满，一条也不探
    const second = line(['x', 'y']);
    const p2 = prober(['x']);
    const two = await pickThenProbe({ pick: second.pick, probe: p2.probe, budget });
    expect(two.kind).toBe('exhausted');
    expect(p2.probed).toEqual([]);
  });

  it('返工：跨族共用的打掉名单——第一族打掉 a、第二族打掉 x，第三族 exhausted 带上两条', async () => {
    const budget = createProbeBudget();
    // 第一族：a 不通 → 打掉 a（占 1 条）
    const p1 = prober([]);
    const one = await pickThenProbe({ pick: line(['a']).pick, probe: p1.probe, budget });
    expect(one.kind).toBe('unavailable'); // 避开 a 之后选路说派不出
    // 第二族：用一个「一条都没有」的选路，打掉 x、y（占 2 条，累计满 3）
    const second = line(['x', 'y']);
    const p2 = prober([]);
    const two = await pickThenProbe({ pick: second.pick, probe: p2.probe, budget });
    expect(two.kind).toBe('exhausted');
    expect(p2.probed).toEqual(['x', 'y']);
    // 第三族：名额已满，exhausted 必须带上前面两族打掉的每一条，不能只留最后一个族那两条
    const p3 = prober([]);
    const three = await pickThenProbe({ pick: line(['z']).pick, probe: p3.probe, budget });
    expect(three.kind).toBe('exhausted');
    expect(p3.probed).toEqual([]);
    expect(three.failures.map((f) => f.routeId)).toEqual(['a', 'x', 'y']);
    expect(pickThenProbeStopText(three.failures)).toContain('m-a 不通（a 网络不通）');
    expect(pickThenProbeStopText(three.failures)).toContain('m-x 不通（x 网络不通）');
    expect(pickThenProbeStopText(three.failures)).toContain('m-y 不通（y 网络不通）');
  });

  it('起点就是 exhausted：一开始名额满了就不探', async () => {
    const budget = createProbeBudget();
    budget.probed = 3;
    const { pick } = line(['a']);
    const { probe, probed } = prober(['a']);
    const got = await pickThenProbe({ pick, probe, budget });
    expect(got.kind).toBe('exhausted');
    expect(probed).toEqual([]);
  });
});

describe('pickThenProbe：调用方本来要避开的路由接着往下攒', () => {
  it('input.avoidRouteIds 传进来：第一次问选路就带上', async () => {
    const { pick, asked } = line(['a', 'b']);
    const { probe } = prober(['b']);
    const got = await pickThenProbe({ pick, probe }, { avoidRouteIds: ['z'] });
    expect(got.kind).toBe('picked');
    expect(asked[0]).toEqual(['z']);
  });

  it('探不通那条的 onUnprobed 抛了：只记日志，不改这一轮的结果', async () => {
    const { pick } = line(['a', 'b']);
    const { probe } = prober(['b']);
    const logged: string[] = [];
    const got = await pickThenProbe({
      pick,
      probe,
      onUnprobed: async () => {
        throw new Error('放不掉');
      },
      log: (message) => logged.push(message),
    });
    expect(got.kind).toBe('picked');
    if (got.kind !== 'picked') return;
    expect(got.route.routeId).toBe('b');
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('预占没放掉');
  });
});

describe('pickThenProbe.stopText：给停下来时写原因用', () => {
  it('每条「谁 不通（为什么）」用「；」连起来', () => {
    const failures: PickThenProbeFailure[] = [
      { routeId: 'a', label: 'm-a', detail: '网络不通' },
      { routeId: 'b', label: 'm-b', detail: '登录失效' },
    ];
    expect(pickThenProbeStopText(failures)).toBe('派前探测：m-a 不通（网络不通）；m-b 不通（登录失效）');
  });
});
