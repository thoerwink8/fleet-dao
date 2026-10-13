// 「发版预检」（/france 页，POST /api/france/preflight，#2021）：后端进程内直接读事实、算能不能发，不起任何子进程、不碰 home。
// 为什么不再起 pnpm release:onekey preflight：法国上后端是 systemd 单元 fleet-api（ProtectHome=yes、ProtectSystem=strict），
// 沙箱里读不了 home，pnpm 读配置就 EACCES；那条命令还要 gh、到法国的 ssh、~/.fleet-dao 下的文件，是给指挥官本机设计的。
// 真发版也不在后端跑：后端只写请求文件，法国上 root 的 fleet-release-request 单元接活（release-request.ts）。
//
// 一项一行，写清卡没卡住；读不到的写「读不到」和原因，算卡住（不拿 0、「没事」冒充）：
// ① 主线头和它的 CI（要绿）② 法国在用的提交 ③ 落后几个（要有东西可发）④ 有没有别的发布在走（进度记录、暂停标记）
// ⑤ 发版接活单元装没装、上一份请求被接走没有 ⑥ 引擎总开关（只报状态：发版会先关再恢复到发前，关着的保持关；读不到算卡住——恢复不了）
// ⑦ 法国在跑的会话数（只报数：发版会等它们收尾；读不到算卡住）。
// 退出码照旧：0 能发；2 不能发（有项卡住，什么都没改）。输出仍分 stdout（每项一行）和 stderr（只列卡住的那几项）。
// 形状见 packages/shared/src/web-api/france-release.ts 的 FrancePreflightResponse。

import {
  describeEngineMaster,
  type EngineMasterState,
  type FrancePreflightResponse,
  FrancePreflightResponseSchema,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { readEngineMaster } from './engine-switch.ts';
import { type FranceReleasePort, readFranceReleaseState } from './france-release.ts';
import { reply } from './http.ts';
import { buildRows, type ReleaseCardPort } from './release-card.ts';
import type { ReleaseRequestPort } from './release-request.ts';
import type { CockpitEnv } from './session.ts';

/** 命令那一栏写给人看的话：没有命令，后端自己读。 */
export const PREFLIGHT_COMMAND = '后端自己读事实（不起任何进程）';

export const PREFLIGHT_EXIT = { ok: 0, blocked: 2 } as const;

export interface RunFrancePreflightInput {
  franceRelease: FranceReleasePort | undefined;
  card: ReleaseCardPort | undefined;
  request: ReleaseRequestPort | undefined;
  readMaster: () => Promise<EngineMasterState>;
  /** 读主线、法国在用提交那几行用的仓列表（和发版卡同一个 store）。 */
  store: Deps['store'];
  now: () => Date;
  signal?: AbortSignal | undefined;
}

interface Item {
  /** ok 通过；block 卡住（读不到也算）；info 只报事实、不拦。 */
  kind: 'ok' | 'block' | 'info';
  text: string;
}

const MARK = { ok: '[通过]', block: '[卡住]', info: '[留意]' } as const;

export async function runFrancePreflight(input: RunFrancePreflightInput): Promise<FrancePreflightResponse> {
  const startedAt = input.now().getTime();
  const asOf = input.now().toISOString();
  if (!input.franceRelease || !input.card || !input.request) {
    return {
      state: 'unreadable',
      why: '这台后端没接上发版预检要读的东西（开发、内存版）；到法国那台的驾驶舱开才有这颗按钮',
      asOf,
    };
  }
  const { franceRelease, request } = input;

  // 主线、法国在用的提交、差几个：同一份读法（发版卡），各行各自带「查成了 / 没查成 + 原因」
  const cardP = buildRows({
    port: input.card,
    store: input.store,
    now: input.now,
    signal: input.signal,
  });
  const trainP = readFranceReleaseState(franceRelease, input.now);
  const sessionsP = franceRelease.readEngineSessions().catch(
    (e: unknown): Awaited<ReturnType<FranceReleasePort['readEngineSessions']>> => ({
      ok: false,
      why: `读引擎排空状态失败：${errMessage(e)}`,
    }),
  );
  const masterP = input.readMaster().then(
    (m) => ({ ok: true as const, m }),
    (e: unknown) => ({ ok: false as const, why: errMessage(e) }),
  );
  const receiverP = request.receiverInstalled().then(
    (r) => r,
    (e: unknown) => ({ ok: false as const, why: `没查成：${errMessage(e)}` }),
  );
  const pendingP = request.pendingRequest().then(
    (p) => ({ ok: true as const, pending: p }),
    (e: unknown) => ({ ok: false as const, why: errMessage(e) }),
  );
  const [card, train, sessions, master, receiver, pending] = await Promise.all([
    cardP,
    trainP,
    sessionsP,
    masterP,
    receiverP,
    pendingP,
  ]);

  const items: Item[] = [];

  // ① 主线头和 CI
  if (card.mainline.state !== 'ok') {
    items.push({ kind: 'block', text: `主线头：读不到（${card.mainline.why}）` });
  } else {
    const { commit, ci } = card.mainline;
    const head = `${commit.short} ${commit.title}`;
    if (ci.state === 'green') items.push({ kind: 'ok', text: `主线 CI：绿（${head}）` });
    else if (ci.state === 'unreadable')
      items.push({ kind: 'block', text: `主线 CI：读不到（${ci.why}；主线头 ${head}）` });
    else
      items.push({
        kind: 'block',
        text: `主线 CI：${ci.state === 'red' ? '红' : '还在跑'}（${ci.detail}；主线头 ${head}）`,
      });
  }

  // ② 法国在用的提交
  if (card.deployed.state !== 'ok') {
    items.push({ kind: 'block', text: `法国在用的提交：读不到（${card.deployed.why}）` });
  } else {
    items.push({
      kind: 'ok',
      text: `法国在用的提交：${card.deployed.short}${card.deployed.title ? ` ${card.deployed.title}` : ''}`,
    });
  }

  // ③ 落后几个
  if (card.gap.state === 'same')
    items.push({ kind: 'block', text: '落后几个：0，法国已经是最新，没有要发的' });
  else if (card.gap.state === 'ahead')
    items.push({ kind: 'ok', text: `落后几个：法国落后主线 ${card.gap.count} 个提交，有东西可发` });
  else items.push({ kind: 'block', text: `落后几个：读不到（${card.gap.why}）` });

  // ④ 别的发布在不在走
  if (train.state === 'idle') items.push({ kind: 'ok', text: '别的发布：没有在走的，也没有留下的暂停标记' });
  else if (train.state === 'unreadable')
    items.push({ kind: 'block', text: `别的发布：读不到进度记录（${train.why}）` });
  else if (train.state === 'paused')
    items.push({ kind: 'block', text: '别的发布：暂停标记还留着、但一趟的记录不在（上次的没收干净）' });
  else
    items.push({
      kind: 'block',
      text: `别的发布：有一趟还没了结（${train.phase}，目标 ${train.target}，${train.status === 'running' ? '在走' : train.status === 'blocked' ? '卡住了' : '没成'}${train.why ? `：${train.why}` : ''}）`,
    });

  // ⑤ 发版接活单元、上一份请求
  if (receiver.ok) items.push({ kind: 'ok', text: '发版接活单元：法国上装着' });
  else items.push({ kind: 'block', text: `发版接活单元：${receiver.why}` });
  if (!pending.ok) items.push({ kind: 'block', text: `上一份发布请求：读不到（${pending.why}）` });
  else if (pending.pending) items.push({ kind: 'block', text: '上一份发布请求：还没被法国接走' });
  else items.push({ kind: 'ok', text: '上一份发布请求：没有排着的' });

  // ⑥ 引擎总开关
  if (!master.ok)
    items.push({
      kind: 'block',
      text: `引擎总开关：读不到（${master.why}）；发版要先关再恢复到发版前的样子，读不到就恢复不了`,
    });
  else
    items.push({
      kind: 'info',
      text: `引擎总开关：${describeEngineMaster(master.m)}（发版会先关、发完恢复到发版前：开着的开回，关着的保持关）`,
    });

  // ⑦ 法国在跑的会话
  if (!sessions.ok) items.push({ kind: 'block', text: `法国在跑的会话：读不到（${sessions.why}）` });
  else if (sessions.engineDown) items.push({ kind: 'info', text: '法国在跑的会话：0 个（引擎没在跑）' });
  else
    items.push({
      kind: 'info',
      text: `法国在跑的会话：${sessions.running} 个${sessions.running > 0 ? `（${sessions.names.join('、')}；发版会等它们收尾）` : ''}`,
    });

  const blocked = items.filter((i) => i.kind === 'block');
  const lines = [
    '—— 发版预检（后端自己读的事实；只读，什么都没改、没暂停）——',
    ...items.map((i) => `${MARK[i.kind]} ${i.text}`),
    blocked.length === 0
      ? '结论：能发。点「在用版本」那一行里的「发布到法国」。'
      : `结论：不能发（${blocked.length} 项卡住）。`,
  ];
  return {
    state: 'done',
    command: PREFLIGHT_COMMAND,
    code: blocked.length === 0 ? PREFLIGHT_EXIT.ok : PREFLIGHT_EXIT.blocked,
    signal: null,
    stdout: `${lines.join('\n')}\n`,
    stderr: blocked.length === 0 ? '' : `${blocked.map((i) => `${MARK.block} ${i.text}`).join('\n')}\n`,
    durationMs: Math.max(0, input.now().getTime() - startedAt),
    timedOut: false,
    truncated: false,
    asOf,
  };
}

export function registerFrancePreflightRoute(app: Hono<CockpitEnv>, deps: Deps): void {
  app.post('/france/preflight', async (c) =>
    reply(
      c,
      FrancePreflightResponseSchema,
      await runFrancePreflight({
        franceRelease: deps.franceRelease,
        card: deps.releaseCard,
        request: deps.releaseRequest,
        readMaster: () => readEngineMaster(deps.store),
        store: deps.store,
        now: deps.now,
        signal: c.req.raw.signal,
      }),
    ),
  );
}
