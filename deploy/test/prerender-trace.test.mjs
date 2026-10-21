// 发布构建时预载的预渲染探针（deploy/lib/prerender-trace.mjs，#3491）：
// 发往本机的 http 请求打得出发出、连上、响应头、收完、关闭，以及进程结束时的 CPU 用量；
// 超时被掐断的请求打得出「没拿到响应」和原因；只观察——不加 error 监听（没人接的错照样让进程崩）、不改响应、
// 非本机请求和没发过请求的进程一个字都不多说。用法：node --test deploy/test/prerender-trace.test.mjs（run.sh 的 node-tests 里跑）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PRELOAD = pathToFileURL(join(here, '..', 'lib', 'prerender-trace.mjs')).href;

/** 带探针跑一段脚本（ESM，stdin 不用），返回退出码和两路输出。 */
function run(script) {
  const r = spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  });
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
  assert.match(l[0], /^\[prerender-trace\] #1 GET 127\.0\.0\.1:\d+\/ 发出，进程已跑 \d+ms$/);
  assert.ok(
    l.some((x) => /#1 GET 127\.0\.0\.1:\d+\/ 拿到 socket \+\d+ms$/.test(x)),
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
    /进程结束：墙钟 \d+ms，自己用掉 CPU \d+ms，被抢占切走 \d+ 次，事件循环最长停 \d+ms，最大内存 \d+MB，系统 load [\d.]+\/[\d.]+\/[\d.]+，\d+ 核$/,
  );
});

test('对端不回、调用方自己超时掐断：关闭那行写没拿到响应和原因，调用方看到的错不变', () => {
  const r = run(`
    import http from 'node:http';
    const server = http.createServer(() => {}); // 收到不回
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address();
    const signal = AbortSignal.timeout(300);
    const seen = await new Promise((ok) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/slow', agent: false }, () => ok('response?'));
      req.on('error', (e) => ok('error=' + e.message));
      signal.addEventListener('abort', () => req.destroy(new Error('The operation was aborted due to timeout')), { once: true });
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
  assert.match(closed, /，没拿到响应，出错：The operation was aborted due to timeout$/);
  assert.ok(!l.some((x) => /响应头/.test(x)), '没响应头就不能打响应头');
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
