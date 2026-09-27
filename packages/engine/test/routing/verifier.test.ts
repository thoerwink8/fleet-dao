// 给开 PR 前验证留一家（ChooseRouteInput.keepVerifier，0003 第 5 条「验证只派别家」）：选副手、Lead 换路由会给这张单加一个
// 写手族，加上以后验证那一步可能一家都派不出——#293 在法国是界面单：写的是 Claude（Lead）+ Grok（副手），GPT 不验界面、
// Grok 和 Claude 同族，干完才挂起「没有别家可验」，干等 47 分钟。验证那一步照法国排：Luna（GPT）第一、Grok 第二、Opus 垫底。
import { describe, expect, it } from 'vitest';
import {
  type ChooseRouteInput,
  chooseRoute,
  type KeepVerifier,
  type RouteFacts,
  RoutingInputError,
  type VerifyProbe,
} from '../../src/routing/index.ts';
import { input, route, win } from './helpers.ts';

const opus = route('opus', { poolName: '拼车号' });
const grok = route('grok', {
  channelId: 'grok-subscription',
  poolId: 'pool-grok',
  poolName: 'Grok 订阅',
  modelId: 'grok-4.7',
  modelName: 'Grok 4.7',
  family: 'grok',
  hostId: 'grok',
  upstreamModel: 'grok-4.7',
});
const luna = route('luna', {
  channelId: 'cursor',
  poolId: 'pool-cursor',
  poolName: 'Cursor 订阅',
  modelId: 'gpt-5.6-luna',
  modelName: 'GPT 5.6 luna',
  family: 'gpt',
  hostId: 'cursor-agent',
  upstreamModel: 'gpt-5.6-luna-high',
});
const offline = (r: RouteFacts): RouteFacts => ({ ...r, blockers: ['offline'] });

/** 开 PR 前验证那一步此刻的选路输入：默认照法国排（Luna、Grok、Opus）。 */
function probe(ui: boolean, routes: RouteFacts[] = [luna, grok, opus]): VerifyProbe {
  const { stage: _stage, ...rest } = input(routes, ui ? { uiWork: true } : {});
  return rest;
}

/** 选副手：界面类的在 UI 阶段派，副手顺序 Grok、Opus；Lead 是 claude（先避开它那一族）。 */
function sidekick(
  ui: boolean,
  keep: Partial<KeepVerifier> = {},
  routes: RouteFacts[] = [grok, opus],
): ChooseRouteInput {
  return input(routes, {
    stage: ui ? 'ui' : 'execute',
    ...(ui ? { uiWork: true } : {}),
    keepVerifier: { writers: ['claude'], verify: probe(ui), spare: ['claude'], otherwise: 'none', ...keep },
  });
}

/** 验证那一步真选（和 workflows/verify.ts 一样：整族避开写这张单的族）。 */
function verifyPick(writers: string[], ui: boolean, routes: RouteFacts[] = [luna, grok, opus]) {
  return chooseRoute(
    input(routes, { stage: 'verify', avoid: { families: writers }, ...(ui ? { uiWork: true } : {}) }),
  );
}

describe('给开 PR 前验证留一家：选副手', () => {
  it('【故意造出的失败】修之前的选法（副手整族避开 Lead、不管验证）：界面单副手选 Grok，写手成了 claude + grok，验证无路可派', () => {
    const before = chooseRoute(
      input([grok, opus], { stage: 'ui', uiWork: true, avoid: { families: ['claude'] } }),
    );
    expect(before).toMatchObject({ kind: 'dispatch', routeId: 'grok' });
    const verify = verifyPick(['claude', 'grok'], true);
    expect(verify.kind).toBe('none');
    expect(verify.kind === 'none' && verify.reason).toContain('犯禁令');
    expect(verify.kind === 'none' && verify.reason).toContain('这一步只派别家：Grok 4.7 是 grok 族');
  });

  it('界面单、Lead 是 claude：副手改派 Opus（和 Lead 同族，不多加一族），验证派到 Grok；理由里写明为什么没派 Grok', () => {
    const r = chooseRoute(sidekick(true));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'opus', family: 'claude' });
    expect(r.noVerifier).toBeUndefined();
    const why = r.kind === 'dispatch' ? r.why : '';
    expect(why).toContain(
      '第 1 条 Grok 订阅 · Grok 4.7 · Grok 命令行：选它开 PR 前验证就没有别家可派了（写这张单的会是 claude、grok 族）',
    );
    expect(why).toContain('别家的都会让开 PR 前验证没有别家可派，改派写这张单的同族（不多加一族）');
    // 驾驶舱逐条看得到：Grok 那条挡在 no-verifier
    expect(r.verdicts.find((v) => v.routeId === 'grok')?.blocks.map((b) => b.code)).toEqual(['no-verifier']);
    expect(verifyPick(['claude'], true)).toMatchObject({ kind: 'dispatch', routeId: 'grok' });
  });

  it('非界面单不受影响：副手照旧先派 Grok（GPT 验得了），Opus 照旧先避开', () => {
    const r = chooseRoute(sidekick(false));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'grok' });
    expect(r.noVerifier).toBeUndefined();
    expect(r.verdicts.find((v) => v.routeId === 'opus')?.blocks.map((b) => b.code)).toEqual(['avoided']);
    expect(verifyPick(['claude', 'grok'], false)).toMatchObject({ kind: 'dispatch', routeId: 'luna' });
  });

  it('非界面单、Grok 连不上或没额度：照旧交派不出、等额度（Lead 自己干，0003 第 7 条），不改派 Opus——别家只是派不出，验证没落空', () => {
    const down = chooseRoute(sidekick(false, {}, [offline(grok), opus]));
    expect(down.kind).toBe('none');
    expect(down.noVerifier).toBeUndefined();
    const full = { ...grok, quota: 'exhausted' as const, blockers: ['quota-exhausted' as const] };
    const spent = chooseRoute(
      sidekick(false, {}, [{ ...full, windows: [win({ state: 'exhausted', used: 1 })] }, opus]),
    );
    expect(spent).toMatchObject({ kind: 'wait', waitFor: 'quota' });
  });

  it('Lead 兜底成 Grok：界面单副手派 Grok（和 Lead 同族），验证由 Opus 验；一般的单副手先派别家 Opus', () => {
    const lead = (ui: boolean) =>
      input([grok, opus], {
        stage: ui ? 'ui' : 'execute',
        ...(ui ? { uiWork: true } : {}),
        keepVerifier: { writers: ['grok'], verify: probe(ui), spare: ['grok'], otherwise: 'none' },
      });
    expect(chooseRoute(lead(true))).toMatchObject({ kind: 'dispatch', routeId: 'grok' });
    expect(verifyPick(['grok'], true)).toMatchObject({ kind: 'dispatch', routeId: 'opus' });
    expect(chooseRoute(lead(false))).toMatchObject({ kind: 'dispatch', routeId: 'opus' });
    expect(verifyPick(['grok', 'claude'], false)).toMatchObject({ kind: 'dispatch', routeId: 'luna' });
  });

  it('能给验证留一家的都派不出（同族的 Opus 连不上）：交派不出让 Lead 自己干，写手族不变、验证照样有人，不报警', () => {
    const r = chooseRoute(sidekick(true, {}, [grok, offline(opus)]));
    expect(r.kind).toBe('none');
    expect(r.noVerifier).toBeUndefined();
    expect(r.kind === 'none' && r.reason).toContain('选它开 PR 前验证就没有别家可派了');
  });

  it('验证那一步的别家只是在等（额度清零）：不算派不出，照样给它留着', () => {
    const waiting = {
      ...grok,
      quota: 'exhausted' as const,
      blockers: ['quota-exhausted' as const],
      windows: [win({ state: 'exhausted', used: 1 })],
    };
    const r = chooseRoute(sidekick(true, { verify: probe(true, [luna, waiting, opus]) }, [grok, opus]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'opus' });
    expect(r.noVerifier).toBeUndefined();
  });

  it('【故意造出的失败】写这张单的族已经让验证没人可派（验证那一步只有 GPT、又是界面类）：选谁都救不回来，照常选、带上报警原因', () => {
    const r = chooseRoute(sidekick(true, { verify: probe(true, [luna]) }));
    // 照常选：先避开的照旧避开
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'grok' });
    expect(r.noVerifier).toMatch(
      /^写这张单的已经有 claude 族，开 PR 前验证阶段没有能派的路由（第 1 条 Cursor 订阅 · GPT 5.6 luna · Cursor Agent：犯禁令/,
    );
  });
});

describe('给开 PR 前验证留一家：Lead 换路由（非派不可）', () => {
  const leadStep = (routes: RouteFacts[], taskRouteId?: string) =>
    input(routes, {
      stage: 'plan',
      ...(taskRouteId ? { taskRouteId } : {}),
      keepVerifier: { writers: ['claude'], verify: probe(true), otherwise: 'any' },
    });

  it('续不上原来的 Opus、只剩 Grok：照常派 Grok（Lead 非派不可），带上「做完没人能验」的原因让调用方当场报警', () => {
    const r = chooseRoute(leadStep([offline(opus), grok]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'grok' });
    expect(r.noVerifier).toMatch(
      /^再派 grok 族的话，写这张单的就有 claude、grok 族，开 PR 前验证阶段没有能派的路由（/,
    );
  });

  it('还有同族的能派：派它，不加一族，不报警', () => {
    const r = chooseRoute(leadStep([grok, opus]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'opus' });
    expect(r.noVerifier).toBeUndefined();
  });

  it('任务指定的路由（续会话、人点名）不挡、不换：会让验证没人可派也照派并带原因；不会的不带', () => {
    const named = chooseRoute(leadStep([opus, grok], 'grok'));
    expect(named).toMatchObject({ kind: 'dispatch', routeId: 'grok' });
    expect(named.noVerifier).toContain('再派 grok 族的话');
    const stuck = chooseRoute(leadStep([opus, grok], 'opus'));
    expect(stuck).toMatchObject({ kind: 'dispatch', routeId: 'opus' });
    expect(stuck.noVerifier).toBeUndefined();
  });

  it('续的会话正是上一次放行的同族副手：先避开的族不挡它（换了就续不上）', () => {
    const r = chooseRoute({ ...sidekick(true), taskRouteId: 'opus' });
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'opus' });
    expect(r.noVerifier).toBeUndefined();
  });

  it('渠道自己挑模型的路由（Cursor Auto）：认不出是哪一家，判不了验证留不留得下，不派', () => {
    const auto = route('auto', {
      channelId: 'cursor',
      poolId: 'pool-cursor',
      modelId: 'cursor-auto',
      modelName: 'Cursor Auto',
      family: 'cursor',
      hostId: 'cursor-agent',
      upstreamModel: 'auto',
    });
    const r = chooseRoute(leadStep([auto, opus]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'opus' });
    expect(r.verdicts.find((v) => v.routeId === 'auto')?.blocks[0]?.text).toContain(
      '给开 PR 前验证留一家要认得出是哪一家：Cursor Auto 由渠道自己挑模型',
    );
  });
});

describe('给开 PR 前验证留一家：输入', () => {
  it('同样的输入同样的结果', () => {
    expect(chooseRoute(sidekick(true))).toEqual(chooseRoute(sidekick(true)));
  });

  it.each<[string, Partial<ChooseRouteInput>]>([
    [
      '写这张单的族一个都没给（判不了验证是不是别家）',
      { keepVerifier: { writers: [], verify: probe(true), otherwise: 'none' } },
    ],
    [
      '留不下时怎么办认不出',
      { keepVerifier: { writers: ['claude'], verify: probe(true), otherwise: 'maybe' as 'none' } },
    ],
    [
      '验证那一步的输入又带了给验证留一家',
      {
        keepVerifier: {
          writers: ['claude'],
          verify: { ...probe(true), keepVerifier: {} } as VerifyProbe,
          otherwise: 'none',
        },
      },
    ],
    [
      '验证那一步自己带',
      { stage: 'verify', keepVerifier: { writers: ['claude'], verify: probe(true), otherwise: 'none' } },
    ],
    [
      '验证那一步的事实认不出（时刻读坏了）',
      {
        keepVerifier: {
          writers: ['claude'],
          verify: { ...probe(true), now: 'yesterday' },
          otherwise: 'none',
        },
      },
    ],
  ])('【故意造出的失败】%s：抛 RoutingInputError，不当成验证留得下', (_name, over) => {
    expect(() => chooseRoute({ ...sidekick(true), ...over })).toThrow(RoutingInputError);
  });
});
