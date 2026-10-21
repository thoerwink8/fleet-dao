// 发布构建驾驶舱前端时的只读探针（#3491、#3494）：node 用 --import 预载它，给「发往本机的 GET /」打时间点。
// 为什么：react-router build 在 ssr:false 下用 vite preview 在本机起一个服务、发一个请求去取外壳 HTML，请求固定 10 秒不回就报
// 「Prerender: Request failed for /: The operation was aborted due to timeout」。光看这一句分不出是没连上、
// 连上了没回，还是响应来了但慢；这里把请求发出、连上、响应头、结束、关闭的时间和进程自己的资源读数打到构建日志里。
// 服务端那一头（预览服务和请求在同一个进程里）也看：服务端什么时候收到、什么时候发完或被掐断；请求在路上这段时间里
// 动态 import（预览中间件头一次载入服务端产物就是一个）用了多久、到关闭还有几个没结束，GC 停了多久，事件循环最长停多久。
// 服务端事件只按「同一条 TCP 连接」归到客户端请求上：客户端连上时记下这条连接两头的地址和端口，服务端收到请求时拿
// 它那条连接的对端地址、对端端口、本端地址、本端端口（四样全对）去对；对上的才是这个目标请求在这个服务（即客户端连的那个
// 预览服务）上的那一头。
// 同进程里别的本机服务、并发的别的请求、裸 socket 发来的 GET / 都对不上，不记。
// 本机实测（#3491）：这段时间的大头在服务端载入产物（经 vite、tailwind 装在进程里的模块解析钩子）和事件循环停顿上，
// 机器忙时从 1 秒涨到 4 秒多；法国那次 10 秒是不是同一回事没有现场数，靠这几行下次分清。
// 只观察：不改请求、不吞错、不加 error 监听、不包响应的方法、不改任何结果。
// 输出边界（#3494）：只认「本机主机 + GET + 路径恰好是 /」这一种请求，别的请求（别的路径、带查询串、别的方法、非本机）和
// 没发过这种请求的进程什么都不打（pnpm 等别的 node 进程保持安静）；打出去的只有固定文字、阶段、数字和回环地址，
// 不打 URL、路径、查询串、片段、用户信息、端口、方法原文，也不打任意 error.message / code / name——出错只记下面 ERROR_KINDS 里的固定类别。
// 探针自己出错一律吞掉，不能让它把构建弄红。
import dc from 'node:diagnostics_channel';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { PerformanceObserver } from 'node:perf_hooks';

const TAG = '[prerender-trace]';
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
// 出错只认这些固定类别：对照 err.code / err.name 做全等比较，输出的是这里的字面量，不是错误对象里的值
const ERROR_KINDS = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EADDRNOTAVAIL',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR',
  'TimeoutError',
  'AbortError',
];
const errorKind = (err) => {
  try {
    return ERROR_KINDS.find((k) => k === err?.code || k === err?.name) ?? '其他';
  } catch {
    return '其他';
  }
};
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const born = performance.now();
const now = () => Math.round(performance.now() - born);
const say = (text) => {
  try {
    process.stderr.write(`${TAG} ${text}\n`);
  } catch {
    // 日志写不出去也不影响构建
  }
};

let seen = 0;
let worstLag = 0;
let lagTimer;
// 「期间」：每个目标请求从发出到关闭各是一段。进程级的读数（动态 import、GC、事件循环）记进当时所有还开着的段；
// 几段叠在一起时那一行写明「是整个进程的读数，不单归这一个」
const active = new Set();
// 目标请求的连接：「对端地址|对端端口|本端地址|本端端口」（站在服务端看）→ 那一段。客户端连上时登记，段关闭时撤
const byConn = new Map();
// 同一个回环地址可能写成 IPv4 映射的 IPv6（服务端听 :: 时）：去掉前缀再比
const bare = (addr) => (typeof addr === 'string' && addr.startsWith('::ffff:') ? addr.slice(7) : addr);
const connKey = (remoteAddr, remotePort, localAddr, localPort) =>
  `${bare(remoteAddr)}|${remotePort}|${bare(localAddr)}|${localPort}`;

function openWindow(id) {
  const w = {
    id,
    sent: performance.now(),
    lag: 0,
    gcCount: 0,
    gcMs: 0,
    gcLongest: 0,
    importCount: 0,
    importLongest: 0,
    pending: new Map(), // 还没结束的动态 import：tracing 的上下文对象 → 开始时间
    server: false,
    conn: '',
    overlap: 1, // 这一段里同时开着的段最多几个（含自己）
  };
  active.add(w);
  for (const other of active) other.overlap = Math.max(other.overlap, active.size);
  return w;
}

function closeWindow(w) {
  active.delete(w);
  if (w.conn && byConn.get(w.conn) === w) byConn.delete(w.conn);
}

function windowLine(w, how) {
  const t = performance.now();
  let waited = 0;
  for (const started of w.pending.values()) waited = Math.max(waited, t - started);
  const left =
    w.pending.size > 0 ? `，${how}还有 ${w.pending.size} 个没结束（最久已等 ${Math.round(waited)}ms）` : '';
  const shared =
    w.overlap > 1
      ? `；期间同时在路上的目标请求最多 ${w.overlap} 个，import、GC、事件循环是整个进程的读数，不单归这一个`
      : '';
  return (
    `#${w.id} 期间：${w.server ? '' : '本进程的服务端没在这个请求的连接上收到它，'}动态 import 结束 ${w.importCount} 次，` +
    `最长 ${Math.round(w.importLongest)}ms${left}；GC ${w.gcCount} 次，共停 ${Math.round(w.gcMs)}ms，` +
    `最长 ${Math.round(w.gcLongest)}ms；事件循环最长停 ${Math.round(w.lag)}ms${shared}`
  );
}

function startLagProbe() {
  if (lagTimer) return;
  let last = performance.now();
  lagTimer = setInterval(() => {
    const t = performance.now();
    const lag = t - last - 100;
    worstLag = Math.max(worstLag, lag);
    for (const w of active) w.lag = Math.max(w.lag, lag);
    last = t;
  }, 100);
  lagTimer.unref();
  // GC 停顿：只记次数和毫秒
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        for (const w of active) {
          w.gcCount += 1;
          w.gcMs += e.duration;
          w.gcLongest = Math.max(w.gcLongest, e.duration);
        }
      }
    }).observe({ entryTypes: ['gc'] });
  } catch {
    // 这版 node 不给就不记
  }
  // 动态 import：node 的 module.import 追踪通道（22 的新版本有；没有就一直不触发，期间那行记 0 次）。
  // 只记时间，不碰 url；订阅了 node 照样把原结果、原错交回调用方
  try {
    dc.tracingChannel('module.import').subscribe({
      start(ctx) {
        const t = performance.now();
        for (const w of active) w.pending.set(ctx, t);
      },
      end() {},
      asyncStart() {},
      asyncEnd(ctx) {
        const t = performance.now();
        for (const w of active) {
          const started = w.pending.get(ctx);
          if (started === undefined) continue;
          w.pending.delete(ctx);
          w.importCount += 1;
          w.importLongest = Math.max(w.importLongest, t - started);
        }
      },
      error(ctx) {
        for (const w of active) w.pending.delete(ctx);
      },
    });
  } catch {
    // 同上
  }
}

// 服务端那一头：http.Server 收到 GET /，而且它这条连接正是某个目标请求连上的那一条，才记收到、发完、断开
function observeServer(req, res) {
  const s = req.socket;
  if (!s || req.method !== 'GET' || req.url !== '/') return;
  const w = byConn.get(connKey(s.remoteAddress, s.remotePort, s.localAddress, s.localPort));
  if (!w || w.server) return;
  const since = () => Math.round(performance.now() - w.sent);
  w.server = true;
  say(`#${w.id} 服务端收到 GET / +${since()}ms`);
  let finished = false;
  res.on('finish', () => {
    finished = true;
    const code = Number.isInteger(res.statusCode) ? res.statusCode : '未知';
    say(`#${w.id} 服务端发完响应 ${code} +${since()}ms`);
  });
  res.on('close', () => {
    if (!finished) say(`#${w.id} 服务端：连接断了，响应还没发完 +${since()}ms`);
  });
}

function observe(req, id) {
  const w = openWindow(id);
  const sent = w.sent;
  const since = () => Math.round(performance.now() - sent);
  // 客户端这条连接两头的地址、端口记下来，服务端收到请求时按它对（端口不进输出）
  const bind = (socket) => {
    if (w.conn || !Number.isInteger(socket.localPort) || !Number.isInteger(socket.remotePort)) return;
    w.conn = connKey(socket.localAddress, socket.localPort, socket.remoteAddress, socket.remotePort);
    byConn.set(w.conn, w);
  };
  req.on('socket', (socket) => {
    say(`#${id} GET / 拿到 socket +${since()}ms`);
    // 发请求前 socket 已经连上（复用的连接）就当场记；没连上的等 connect——客户端的连接回调先于服务端读到请求
    if (!socket.connecting) bind(socket);
    socket.on('connect', () => {
      bind(socket);
      const family =
        socket.remoteFamily === 'IPv4' || socket.remoteFamily === 'IPv6' ? socket.remoteFamily : '未知';
      const address = LOOPBACK.has(socket.remoteAddress) ? socket.remoteAddress : '非回环地址';
      say(`#${id} 连上 ${address}（${family}）+${since()}ms`);
    });
  });
  req.on('response', (res) => {
    const code = Number.isInteger(res.statusCode) ? res.statusCode : '未知';
    say(`#${id} 响应头 ${code} +${since()}ms`);
    res.on('end', () => say(`#${id} 响应收完 +${since()}ms`));
  });
  // 错误只旁听：包一层 emit 记下 error 事件的类别再原样放行。不用 req.on('error')——多一个监听会让「没人接的错」不再崩进程
  let errorKindSeen = '';
  const emit = req.emit;
  req.emit = function observedEmit(event, ...rest) {
    if (event === 'error') errorKindSeen = errorKind(rest[0]);
    return emit.call(this, event, ...rest);
  };
  req.on('close', () => {
    const why = errorKindSeen ? `，出错类别：${errorKindSeen}` : '';
    say(`#${id} 关闭 +${since()}ms${req.destroyed && !req.res ? '，没拿到响应' : ''}${why}`);
    // 服务端的「发完 / 断开」可能和客户端关闭同一轮才到：留到下一轮再收期间那一行
    setImmediate(() => {
      try {
        if (!active.has(w)) return;
        say(windowLine(w, '到关闭'));
        closeWindow(w);
      } catch {
        // 同上
      }
    });
  });
}

try {
  const original = http.request;
  http.request = function patchedRequest(...args) {
    const req = original.apply(this, args);
    try {
      const first = args[0];
      const opts = typeof first === 'object' && first !== null && !(first instanceof URL) ? first : null;
      const host = String(opts?.hostname ?? opts?.host ?? '').toLowerCase();
      // 固定只认本机 GET /：方法、路径是别的（含带查询串、片段、用户信息的）一律不观察、不打
      const method = opts?.method === undefined ? 'GET' : opts.method;
      const path = opts?.path === undefined ? '/' : opts.path;
      if (opts && LOCAL.has(host) && method === 'GET' && path === '/') {
        seen += 1;
        startLagProbe();
        say(`#${seen} GET / 发出，进程已跑 ${now()}ms`);
        observe(req, seen);
      }
    } catch {
      // 探针的毛病不上抛
    }
    return req;
  };
  // http.get 在 node 里直接调内部的 request，不经 http.request；补一层同样的转手，免得走 get 的请求漏看
  http.get = function patchedGet(...args) {
    const req = http.request.apply(this, args);
    req.end();
    return req;
  };
  // 只改 http 对象上的属性，别处用 `import { request } from 'node:http'` 拿到的还是老函数（实测不同步），探针会整个漏看；
  // 同步一次，ESM 命名导出才跟着换。预载在业务代码加载之前跑，之后 import 的拿到的就是包过的
  syncBuiltinESMExports();

  // 服务端：http.Server 收到请求时 node 内部调 server.emit('request', req, res)。转手看一眼再原样交出去，不加监听、不改参数
  const serverEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function observedServerEmit(event, ...rest) {
    if (event === 'request') {
      try {
        observeServer(rest[0], rest[1]);
      } catch {
        // 探针的毛病不上抛
      }
    }
    return serverEmit.call(this, event, ...rest);
  };

  process.on('exit', () => {
    try {
      if (seen === 0) return;
      // 请求还没关（或关了还没来得及收尾）进程就要退：期间那一行在这里补上，不丢
      for (const w of active) say(windowLine(w, '进程退出时'));
      const usage = process.resourceUsage();
      const cpuMs = Math.round((usage.userCPUTime + usage.systemCPUTime) / 1000);
      const [l1, l5, l15] = os.loadavg().map((n) => n.toFixed(2));
      say(
        `进程结束（只是读数，单看比例不能当根因）：墙钟 ${now()}ms，自己用掉 CPU ${cpuMs}ms，非自愿上下文切换 ${usage.involuntaryContextSwitches} 次，` +
          `事件循环最长停 ${Math.round(worstLag)}ms，最大内存 ${Math.round(usage.maxRSS / 1024)}MB，` +
          `系统 load ${l1}/${l5}/${l15}，${os.cpus().length} 核`,
      );
    } catch {
      // 同上
    }
  });
} catch {
  // 装不上就当没有探针
}
