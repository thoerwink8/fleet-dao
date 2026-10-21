// 发布构建驾驶舱前端时的只读探针（#3491、#3494）：node 用 --import 预载它，给「发往本机的 GET /」打时间点。
// 为什么：react-router build 在 ssr:false 下用 vite preview 在本机起一个服务、发一个请求去取外壳 HTML，请求固定 10 秒不回就报
// 「Prerender: Request failed for /: The operation was aborted due to timeout」。光看这一句分不出是没连上、
// 连上了没回，还是响应来了但慢；这里把请求发出、连上、响应头、结束、关闭的时间和进程自己的资源读数打到构建日志里。
// 只观察：不改请求、不吞错、不加 error 监听、不改任何结果。
// 输出边界（#3494）：只认「本机主机 + GET + 路径恰好是 /」这一种请求，别的请求（别的路径、带查询串、别的方法、非本机）和
// 没发过这种请求的进程什么都不打（pnpm 等别的 node 进程保持安静）；打出去的只有固定文字、阶段、数字和回环地址，
// 不打 URL、路径、查询串、片段、用户信息、端口、方法原文，也不打任意 error.message / code / name——出错只记下面 ERROR_KINDS 里的固定类别。
// 探针自己出错一律吞掉，不能让它把构建弄红。
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';

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

function startLagProbe() {
  if (lagTimer) return;
  let last = performance.now();
  lagTimer = setInterval(() => {
    const t = performance.now();
    worstLag = Math.max(worstLag, t - last - 100);
    last = t;
  }, 100);
  lagTimer.unref();
}

function observe(req, id) {
  const sent = performance.now();
  const since = () => Math.round(performance.now() - sent);
  req.on('socket', (socket) => {
    say(`#${id} GET / 拿到 socket +${since()}ms`);
    socket.on('connect', () => {
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

  process.on('exit', () => {
    try {
      if (seen === 0) return;
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
