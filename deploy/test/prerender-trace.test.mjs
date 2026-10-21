// 发布构建时预载的预渲染探针（deploy/lib/prerender-trace.mjs，#3491、#3494）：
// 发往本机的 GET / 打得出发出、连上、响应头、收完、关闭，以及进程结束时的资源读数；
// 超时被掐断的请求打得出「没拿到响应」和固定的出错类别；只观察——不加 error 监听（没人接的错照样让进程崩）、不改响应、
// 非目标请求（别的路径、方法、查询串、非本机）和没发过请求的进程一个字都不多说；
// 假的查询串、路径、片段、用户信息、方法、端口、error.message / code 标记一个都不能原样出现在输出里。
// 用法：node --test deploy/test/prerender-trace.test.mjs（run.sh 的 node-tests 里跑）。
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runChild } from './child.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PRELOAD = pathToFileURL(join(here, '..', 'lib', 'prerender-trace.mjs')).href;

/** 带探针跑一段脚本（ESM，stdin 不用），返回退出码和两路输出。真起子进程一律走 child.mjs（static-child 测试扫这条）。 */
function run(script) {
  const r = runChild(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', script]);
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const lines = (err) => err.split('\n').filter((l) => l.startsWith('[prerender-trace]'));

test('本机请求拿到 200：打发出、连上、响应头、响应收完、关闭、进程结束，响应内容原样', () => {
  const r = run(`
    import http from 'node:http';
    const server = http.createServer((_, res) => res.end('shell'));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    const body = await new Promise((ok, bad) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'GET', agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok(Buffer.concat(chunks).toString()));
      });
      req.on('error', bad);
      req.end();
    });
    process.stdout.write('body=' + body);
    server.close();
  `);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'body=shell');
  const l = lines(r.err);
  assert.match(l[0], /^\[prerender-trace\] #1 GET \/ 发出，进程已跑 \d+ms$/);
  assert.ok(
    l.some((x) => /#1 GET \/ 拿到 socket \+\d+ms$/.test(x)),
    l.join('\n'),
  );
  assert.ok(
    l.some((x) => /#1 连上 127\.0\.0\.1（IPv4）\+\d+ms$/.test(x)),
    l.join('\n'),
  );
  assert.ok(
    l.some((x) => /#1 响应头 200 \+\d+ms$/.test(x)),
    l.join('\n'),
  );
  assert.ok(
    l.some((x) => /#1 响应收完 \+\d+ms$/.test(x)),
    l.join('\n'),
  );
  assert.ok(
    l.some((x) => /#1 关闭 \+\d+ms$/.test(x)),
    l.join('\n'),
  );
  const end = l.at(-1);
  assert.match(
    end,
    /进程结束（只是读数，单看比例不能当根因）：墙钟 \d+ms，自己用掉 CPU \d+ms，非自愿上下文切换 \d+ 次，事件循环最长停 \d+ms，最大内存 \d+MB，系统 load [\d.]+\/[\d.]+\/[\d.]+，\d+ 核$/,
  );
  assert.ok(!/抢占/.test(r.err), '读数不断言被抢占');
});

test('对端不回、调用方自己超时掐断：关闭那行写没拿到响应和固定的出错类别，调用方看到的错不变', () => {
  const r = run(`
    import http from 'node:http';
    const server = http.createServer(() => {}); // 收到不回
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    const signal = AbortSignal.timeout(300);
    const seen = await new Promise((ok) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/', agent: false }, () => ok('response?'));
      req.on('error', (e) => ok('error=' + e.message));
      signal.addEventListener('abort', () => req.destroy(signal.reason), { once: true });
      req.end();
    });
    process.stdout.write(seen);
    server.close();
    process.exitCode = 3;
  `);
  assert.equal(r.code, 3, '探针不改退出码');
  assert.equal(r.out, 'error=The operation was aborted due to timeout');
  const l = lines(r.err);
  const closed = l.find((x) => /#1 关闭 /.test(x));
  assert.ok(closed, l.join('\n'));
  assert.match(closed, /，没拿到响应，出错类别：TimeoutError$/);
  assert.ok(!l.some((x) => /响应头/.test(x)), '没响应头就不能打响应头');
  assert.ok(!r.err.includes('The operation was aborted'), 'error.message 不进输出');
});

test('假标记不外泄：query / path / fragment / 用户信息 / 方法 / 端口 / error.message / code / name 都不原样出现，原错照传', () => {
  const MARKERS = [
    'SYNTHETIC_QUERY_MARKER',
    'SYNTHETIC_PATH_MARKER',
    'SYNTHETIC_FRAGMENT_MARKER',
    'SYNTHETIC_AUTH_MARKER',
    'SYNTHETIC_METHOD_MARKER',
    'SYNTHETIC_PORT_MARKER',
    'SYNTHETIC_ERROR_MARKER',
    'SYNTHETIC_CODE_MARKER',
    'SYNTHETIC_NAME_MARKER',
  ];
  const r = run(`
    import http from 'node:http';
    const server = http.createServer((_, res) => res.end('x'));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    const done = (req) =>
      new Promise((ok) => {
        req.on('error', (e) => ok('err:' + e.message));
        req.on('response', (res) => { res.resume(); res.on('end', () => ok('res')); });
        req.end();
      });
    const results = [];
    // 目标请求带上假的用户信息和头：探针不能把它们打出来
    results.push(await done(http.request({ hostname: '127.0.0.1', port, path: '/', auth: 'SYNTHETIC_AUTH_MARKER:x', headers: { 'x-m': 'SYNTHETIC_AUTH_MARKER' }, agent: false })));
    // 目标请求被自己掐断，错误带假的 message / code / name：调用方拿到的原错不变
    const bad = http.request({ hostname: '127.0.0.1', port, path: '/', agent: false });
    const err = Object.assign(new Error('SYNTHETIC_ERROR_MARKER'), { code: 'SYNTHETIC_CODE_MARKER', name: 'SYNTHETIC_NAME_MARKER' });
    const pending = done(bad);
    bad.destroy(err);
    results.push(await pending);
    // 非目标：带查询串 / 片段 / 别的路径 / 别的方法 / 假端口字符串的请求，一个字都不打
    results.push(await done(http.request({ hostname: '127.0.0.1', port, path: '/?token=SYNTHETIC_QUERY_MARKER', agent: false })));
    results.push(await done(http.request({ hostname: '127.0.0.1', port, path: '/SYNTHETIC_PATH_MARKER#SYNTHETIC_FRAGMENT_MARKER', agent: false })));
    results.push(await done(http.request({ hostname: '127.0.0.1', port, path: '/', method: 'POST', agent: false })));
    const weird = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'SYNTHETIC_METHOD_MARKER', agent: false });
    weird.on('error', () => {});
    weird.destroy();
    results.push('weird');
    process.stdout.write(results.join('|'));
    server.close();
  `);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'res|err:SYNTHETIC_ERROR_MARKER|res|res|res|weird', '请求、响应、原错都不被探针改动');
  for (const m of MARKERS) assert.ok(!r.err.includes(m), `${m} 不能出现在输出里：\n${r.err}`);
  const l = lines(r.err);
  assert.ok(
    l.some((x) => /#1 响应头 200 /.test(x)),
    '固定的 GET / 仍可观察：\n' + l.join('\n'),
  );
  assert.ok(
    l.some((x) => /#2 关闭 .*，没拿到响应，出错类别：其他$/.test(x)),
    '任意 code / name 只归到固定的「其他」：\n' + l.join('\n'),
  );
  assert.ok(!l.some((x) => /#3 /.test(x)), '非目标请求不占序号、不打字：\n' + l.join('\n'));
});

test('目标请求的端口是怪字符串：端口不进输出，探针不改 http.request 本来的行为', () => {
  const r = run(`
    import http from 'node:http';
    let how = 'no-throw';
    try {
      const req = http.request({ hostname: '127.0.0.1', port: 'SYNTHETIC_PORT_MARKER', path: '/', agent: false });
      req.on('error', () => {});
      req.destroy();
    } catch (e) {
      how = 'threw:' + (e.code ?? 'x');
    }
    process.stdout.write(how);
  `);
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.err.includes('SYNTHETIC_PORT_MARKER'), r.err);
  assert.ok(!lines(r.err).some((x) => /SYNTHETIC|:\d+\//.test(x)), r.err);
});

test('不吞错：没人接 error 的请求（连被拒）照样让进程带着原错崩，探针没替它接', () => {
  const r = run(`
    import http from 'node:http';
    import net from 'node:net';
    const probe = net.createServer();
    await new Promise((ok) => probe.listen(0, '127.0.0.1', ok));
    const { port } = probe.address();
    await new Promise((ok) => probe.close(ok)); // 这个口现在没人听
    http.request({ hostname: '127.0.0.1', port, path: '/', agent: false }).end();
  `);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /ECONNREFUSED/);
});

test('非本机的请求、没发过请求的进程：一个字都不多说', () => {
  const none = run(`process.stdout.write('quiet');`);
  assert.equal(none.code, 0);
  assert.equal(none.out, 'quiet');
  assert.deepEqual(lines(none.err), []);
  const remote = run(`
    import http from 'node:http';
    const req = http.request({ hostname: 'example.invalid', port: 9, path: '/', agent: false });
    req.on('error', () => {});
    req.destroy();
  `);
  assert.equal(remote.code, 0, remote.err);
  assert.deepEqual(lines(remote.err), []);
});

test('探针装在 URL 参数的 http.request(url, cb) 上也不出错、不乱打', () => {
  const r = run(`
    import http from 'node:http';
    const server = http.createServer((_, res) => res.end('x'));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    await new Promise((ok, bad) => {
      const req = http.request('http://127.0.0.1:' + port + '/', (res) => { res.resume(); res.on('end', ok); });
      req.on('error', bad);
      req.end();
    });
    server.close();
  `);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(lines(r.err), [], '字符串参数不是选项对象：认不出主机，不打也不崩');
});

test("别的模块用 import { request } from 'node:http' 取函数，也看得到（实测只改 http.request 属性时命名导出不同步）", () => {
  const r = run(`
    import http from 'node:http';
    const { request } = await import('node:http');
    const server = http.createServer((_, res) => res.end('shell'));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    const body = await new Promise((ok, bad) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/', method: 'GET', agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok(Buffer.concat(chunks).toString()));
      });
      req.on('error', bad);
      req.end();
    });
    process.stdout.write('body=' + body);
    server.close();
  `);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'body=shell');
  const l = lines(r.err);
  assert.ok(
    l.some((x) => /#1 GET \/ 发出/.test(x)),
    l.join('\n'),
  );
  assert.ok(
    l.some((x) => /#1 响应头 200 \+\d+ms$/.test(x)),
    l.join('\n'),
  );
});

test('走 http.get（命名导出 get）的本机 GET / 也看得到，响应原样', () => {
  const r = run(`
    import http, { get } from 'node:http';
    const server = http.createServer((_, res) => res.end('shell'));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    const body = await new Promise((ok, bad) => {
      get({ hostname: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok(Buffer.concat(chunks).toString()));
      }).on('error', bad);
    });
    process.stdout.write('body=' + body);
    server.close();
  `);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'body=shell');
  const l = lines(r.err);
  assert.ok(
    l.some((x) => /#1 GET \/ 发出/.test(x)),
    l.join('\n'),
  );
  assert.ok(
    l.some((x) => /#1 响应收完 \+\d+ms$/.test(x)),
    l.join('\n'),
  );
});

// 服务端处理里先动态 import 一个慢模块（顶层 await 等 300ms），模拟预览中间件头一次载入服务端产物
const SLOW_IMPORT = 'data:text/javascript,await new Promise((ok) => setTimeout(ok, 300)); export default 1;';
// 永远等不完的模块：模拟载入服务端产物卡住，客户端 10 秒（这里 300ms）掐断时它还没结束
const STUCK_IMPORT = 'data:text/javascript,await new Promise(() => {}); export default 1;';

test('服务端那一头和期间：收到、发完响应、动态 import 用时、GC、事件循环停顿各打一行，响应原样', () => {
  const r = run(`
    import http from 'node:http';
    const server = http.createServer(async (_, res) => {
      await import(${JSON.stringify(SLOW_IMPORT)});
      res.end('shell');
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    const body = await new Promise((ok, bad) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok(Buffer.concat(chunks).toString()));
      });
      req.on('error', bad);
      req.end();
    });
    process.stdout.write('body=' + body);
    server.close();
  `);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'body=shell');
  const l = lines(r.err);
  assert.ok(
    l.some((x) => /^\[prerender-trace\] #1 服务端收到 GET \/ \+\d+ms$/.test(x)),
    l.join('\n'),
  );
  assert.ok(
    l.some((x) => /^\[prerender-trace\] #1 服务端发完响应 200 \+\d+ms$/.test(x)),
    l.join('\n'),
  );
  const span = l.find((x) => /#1 期间：/.test(x));
  assert.ok(span, l.join('\n'));
  const m = span.match(
    /#1 期间：动态 import 结束 1 次，最长 (\d+)ms；GC \d+ 次，共停 \d+ms，最长 \d+ms；事件循环最长停 \d+ms$/,
  );
  assert.ok(m, span);
  assert.ok(Number(m[1]) >= 250, `慢 import 至少等了 300ms：${span}`);
  assert.ok(!r.err.includes('data:'), '不打 import 的地址');
});

test('超时掐断时服务端还在载入：打出服务端断开没发完、期间还有 1 个 import 没结束和已等多久，调用方的错不变', () => {
  const r = run(`
    import http from 'node:http';
    const server = http.createServer(async (_, res) => {
      await import(${JSON.stringify(STUCK_IMPORT)});
      res.end('never');
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    const signal = AbortSignal.timeout(300);
    const seen = await new Promise((ok) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/', agent: false }, () => ok('response?'));
      req.on('error', (e) => ok('error=' + e.message));
      signal.addEventListener('abort', () => req.destroy(signal.reason), { once: true });
      req.end();
    });
    process.stdout.write(seen);
    server.close();
    server.closeAllConnections();
    process.exitCode = 3;
  `);
  assert.equal(r.code, 3, `探针不改退出码：${r.err}`);
  assert.equal(r.out, 'error=The operation was aborted due to timeout');
  const l = lines(r.err);
  assert.ok(
    l.some((x) => /#1 服务端收到 GET \/ \+\d+ms$/.test(x)),
    l.join('\n'),
  );
  assert.ok(
    l.some((x) => /#1 服务端：连接断了，响应还没发完 \+\d+ms$/.test(x)),
    l.join('\n'),
  );
  assert.ok(!l.some((x) => /服务端发完响应/.test(x)), l.join('\n'));
  const span = l.find((x) => /#1 期间：/.test(x));
  const m = span?.match(
    /动态 import 结束 0 次，最长 0ms，(到关闭|进程退出时)还有 1 个没结束（最久已等 (\d+)ms）/,
  );
  assert.ok(m, l.join('\n'));
  assert.ok(Number(m[2]) >= 250, span);
});

/** 用裸 socket 发一个 GET（不经 http.request，探针的客户端那一头看不到），返回状态行 */
const RAW_GET = `
  const rawGet = (port, path) =>
    new Promise((ok, bad) => {
      const s = net.connect(port, '127.0.0.1', () => s.end('GET ' + path + ' HTTP/1.1' + CRLF + 'Host: x' + CRLF + 'Connection: close' + CRLF + CRLF));
      let got = '';
      s.on('data', (c) => (got += c));
      s.on('end', () => ok(got.split(CRLF)[0]));
      s.on('error', bad);
    });
`;

test('只当服务端、没发过目标请求的进程：本机连来的 GET / 也一个字都不打', () => {
  const r = run(`
    import http from 'node:http';
    import net from 'node:net';
    const CRLF = String.fromCharCode(13, 10);
    ${RAW_GET}
    const server = http.createServer((_, res) => res.end('x'));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    process.stdout.write(await rawGet(port, '/'));
    server.close();
  `);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'HTTP/1.1 200 OK');
  assert.deepEqual(lines(r.err), []);
});

test('目标请求在路上时，服务端收到的带查询串的请求不记、不外泄', () => {
  const r = run(`
    import http from 'node:http';
    import net from 'node:net';
    const CRLF = String.fromCharCode(13, 10);
    ${RAW_GET}
    let raw = '';
    let port = 0;
    const server = http.createServer(async (req, res) => {
      // 目标请求在路上：这时用裸 socket 发一个带查询串的 GET，服务端收到它不能打
      if (req.url === '/') raw = await rawGet(port, '/?SYNTHETIC_QUERY_MARKER=1');
      res.end('x');
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    port = server.address().port;
    await new Promise((ok, bad) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/', agent: false }, (res) => { res.resume(); res.on('end', ok); });
      req.on('error', bad);
      req.end();
    });
    process.stdout.write(raw);
    server.close();
  `);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'HTTP/1.1 200 OK');
  assert.ok(!r.err.includes('SYNTHETIC_QUERY_MARKER'), r.err);
  const l = lines(r.err);
  assert.equal(l.filter((x) => /服务端收到/.test(x)).length, 1, l.join('\n'));
  assert.equal(l.filter((x) => /服务端发完响应/.test(x)).length, 1, l.join('\n'));
});
