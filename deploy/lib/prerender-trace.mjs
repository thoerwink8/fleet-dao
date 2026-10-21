// 发布构建驾驶舱前端时的只读探针（#3491）：node 用 --import 预载它，给「发往本机的 http 请求」打时间点。
// 为什么：react-router build 在 ssr:false 下用 vite preview 在本机起一个服务、发一个请求去取外壳 HTML，请求固定 10 秒不回就报
// 「Prerender: Request failed for /: The operation was aborted due to timeout」。光看这一句分不出是没连上、
// 连上了没回，还是进程被别的任务抢着核跑得慢；这里把请求发出、连上、响应头、结束、关闭的时间和进程自己的 CPU 用量打到构建日志里。
// 只观察：不改请求、不吞错、不加 error 监听、不改任何结果；非本机的请求、没发过本机请求的进程什么都不打（pnpm 等别的 node 进程保持安静）。
// 探针自己出错一律吞掉，不能让它把构建弄红。
import http from 'node:http';
import os from 'node:os';

const TAG = '[prerender-trace]';
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
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

function observe(req, id, label) {
  const sent = performance.now();
  const since = () => Math.round(performance.now() - sent);
  req.on('socket', (socket) => {
    say(`#${id} ${label} 拿到 socket +${since()}ms`);
    socket.on('connect', () =>
      say(`#${id} 连上 ${socket.remoteAddress}（${socket.remoteFamily}）+${since()}ms`),
    );
  });
  req.on('response', (res) => {
    say(`#${id} 响应头 ${res.statusCode} +${since()}ms`);
    res.on('end', () => say(`#${id} 响应收完 +${since()}ms`));
  });
  // 错误只旁听：包一层 emit 记下 error 事件的消息再原样放行。不用 req.on('error')——多一个监听会让「没人接的错」不再崩进程
  let errorMessage = '';
  const emit = req.emit;
  req.emit = function observedEmit(event, ...rest) {
    if (event === 'error') errorMessage = String(rest[0]?.message ?? rest[0]);
    return emit.call(this, event, ...rest);
  };
  req.on('close', () => {
    const why = errorMessage ? `，出错：${errorMessage}` : '';
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
      if (opts && LOCAL.has(host)) {
        seen += 1;
        startLagProbe();
        const label = `${opts.method ?? 'GET'} ${host}:${opts.port ?? ''}${opts.path ?? ''}`;
        say(`#${seen} ${label} 发出，进程已跑 ${now()}ms`);
        observe(req, seen, label);
      }
    } catch {
      // 探针的毛病不上抛
    }
    return req;
  };

  process.on('exit', () => {
    try {
      if (seen === 0) return;
      const usage = process.resourceUsage();
      const cpuMs = Math.round((usage.userCPUTime + usage.systemCPUTime) / 1000);
      const [l1, l5, l15] = os.loadavg().map((n) => n.toFixed(2));
      say(
        `进程结束：墙钟 ${now()}ms，自己用掉 CPU ${cpuMs}ms，被抢占切走 ${usage.involuntaryContextSwitches} 次，` +
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
