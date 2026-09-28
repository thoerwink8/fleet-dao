// 桥接：以 Mirasim 服务自己的用户身份跑（引擎经 fleet-agent-scope 起它），连它自己家里的回环 ws（法国防火墙只放行
// 这个用户和 root 连那个口，见 docs/ops.md 第五节「会话用户的口只许它自己连」，#35；引擎自己的进程（fleet 用户）连不上，
// 2026-09-28 实测断链）。帧经 stdin/stdout 按行 JSON 转给引擎（bridge-connect.ts）：stdin 一行一个要发给 Mirasim 的帧，
// stdout 一行要么是一个 Mirasim 的帧、要么是一条本文件自己的控制行（下面「协议」）。
//
// 只用 node 自带的模块（装在会话用户读得到的检出/发布目录里，跑它的时候不保证 node_modules 在——不能指望 workspace
// 解析；#345 需求，见仓根 AGENTS.md「本机干活」一节）：node 22 全局就有 WebSocket，不用另外 import。
//
// 协议（stdout 的控制行，和 Mirasim 的帧用同一个 __bridge 字段分开——Mirasim 的帧不会有这个字段）：
//   {"__bridge":"ready"}                      —— 连上了，往后 stdout 每行要么是 Mirasim 的帧、要么下面这两种
//   {"__bridge":"closed"}                     —— 连接断了（服务端关的、或者 stdin 关时我们自己关的），之后不会再有帧
//   {"__bridge":"error","kind":"...","message":"..."} —— 连不上（见 fail() 的 kind），这条之后不会有 ready、进程退出非 0
// 用法：node bridge.ts <port> <tokenFile>；SIGTERM/SIGINT、stdin 关都当「该收场了」，优雅关 ws 再退。
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * 建连总共重试这么久（和直连那份 mirasimConnector 同一个预算，MS-08：codex 会话会把服务端单线程堵 40–58 秒）。
 * 测试用环境变量把它调短，别真等 90 秒；生产不设这个变量，照默认值。
 */
const CONNECT_BUDGET_MS = Number(process.env.FLEET_MIRASIM_BRIDGE_CONNECT_BUDGET_MS) || 90_000;

function writeLine(obj: unknown): void {
  try {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  } catch {
    // stdout 已经没人读了（引擎那边先断的）：没法报，反正马上就要退出
  }
}

function fail(kind: string, message: string): never {
  writeLine({ __bridge: 'error', kind, message });
  process.exitCode = 1;
  process.exit(1);
}

/** 开一条 ws，等 open 或者失败（不含重试）。 */
function connectOnce(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    ws.onopen = () => done(() => resolve(ws));
    ws.onerror = () => done(() => reject(new Error('建连失败')));
    ws.onclose = () => done(() => reject(new Error('建连被关')));
  });
}

async function main(): Promise<void> {
  const port = Number(process.argv[2]);
  const tokenFile = process.argv[3];
  if (!Number.isInteger(port) || port <= 0 || !tokenFile) {
    fail('usage', `用法：node bridge.ts <port> <tokenFile>（收到 ${JSON.stringify(process.argv.slice(2))}）`);
  }

  // 单元测试里连真的 Mirasim 服务一律拒绝（和直连那份 assertNotRealMirasimInTests 同一条规矩，GEN-08：旧系统的假会话
  // 就是这么漏出去的）；本进程零依赖，这里就地重复一遍这条判断，不额外引入 import。生产的 scope launch 会把
  // VITEST 这类变量滤掉，这条只在万一漏传时兜底。
  if (process.env.VITEST && port === 4316) {
    fail('usage', '测试里不许连真的 Mirasim 服务（旧系统那份端口 4316）：换成假服务端，真跑放到测试之外');
  }

  let token: string;
  try {
    token = (await readFile(tokenFile as string, 'utf8')).trim();
  } catch (err) {
    fail('token_missing', `读不了 Mirasim 的回环令牌（${tokenFile}）：${(err as Error).message}`);
  }
  if (!token) fail('token_empty', `Mirasim 的回环令牌文件是空的：${tokenFile}`);

  const url = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
  const deadline = Date.now() + CONNECT_BUDGET_MS;
  let wait = 500;
  let lastError = '';
  let ws: WebSocket | undefined;
  for (;;) {
    try {
      ws = await connectOnce(url);
      break;
    } catch (err) {
      lastError = (err as Error).message;
    }
    if (Date.now() + wait > deadline) {
      fail('connect_failed', `连不上 Mirasim 的回环 ws（127.0.0.1:${port}）：${lastError}`);
    }
    await sleep(wait);
    wait = Math.min(wait * 2, 8_000);
  }

  // 连上了：宣布 ready，往后只管转发，不再报「连不上」这一类错——断了一律按 closed 收场（和直连那份 openWire 一个道理：
  // 建连之后的失败不是「没连上」，是「连着连着断了」）。
  writeLine({ __bridge: 'ready' });
  let closed = false;
  const finishClosed = () => {
    if (closed) return;
    closed = true;
    writeLine({ __bridge: 'closed' });
    process.exit(0);
  };
  ws.onmessage = (ev: MessageEvent) => {
    let frame: unknown;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return; // 不是 JSON 的帧不认（和 openWire 一样）
    }
    if (frame && typeof frame === 'object' && !Array.isArray(frame)) writeLine(frame);
  };
  ws.onclose = finishClosed;
  ws.onerror = () => {
    // 只指望 close 跟着来翻状态（Node 的 WebSocket 出错之后总会关）；这里不重复报，免得 stdout 上一条帧都没有就先来一条错
  };

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim() || closed) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return; // 引擎那边不该发出这种，但读不出来的行不转发、不崩
    }
    try {
      ws?.send(JSON.stringify(frame));
    } catch {
      // ws 已经断了，next 那头的 closed 会跟着到
    }
  });
  rl.on('close', () => {
    // 引擎关了 stdin：这条连接不再要了，主动关，不等服务端先断
    try {
      ws?.close();
    } catch {
      // 已经断了
    }
  });

  const onSignal = () => {
    try {
      ws?.close();
    } catch {
      // 已经断了
    }
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

main().catch((err: unknown) => {
  // main 本身不该抛（每条失败路径都走 fail()，它自己 exit 了）；真抛到这里说明漏了一种没想到的失败，一样报错退出，
  // 不静默吞掉。
  fail('unexpected', err instanceof Error ? err.message : String(err));
});
