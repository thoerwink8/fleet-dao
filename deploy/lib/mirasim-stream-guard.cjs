'use strict';
// Mirasim 0.0.425 的 server.cjs 会在某条连接已经 end 之后再 write。
// Node 24 这时不抛同步异常，而是在没有 error 监听的流上异步发出
// ERR_STREAM_WRITE_AFTER_END；events 模块没人接就 throw，进程退出码 1。
// systemd 的 Restart=on-failure 把整个 fleet-mirasim-session 拉起来，正在跑的会话全断。
// 法国 2026-10-15 13:06、20:44 和 2026-10-16 12:10 三次都是这样：server.log 里这一轮被
// outcome:interrupted 掐掉，紧接着就是新进程的「logs →」，中间没有「server closed」。
//
// 本文件由单元以 node --require 在 server.cjs 之前装上，只挡这一种写：
//   - 流已经 end / destroy：丢掉这次写入，拆掉这一条连接，进程继续听端口。
//   - 别的未捕获异常照旧打印并退出，不把真故障藏起来。
// 正常的 end(数据) 仍会把最后一块写出去（Node 是先 write 再把 writableEnded 置上）。
// 不进子进程：--require 只作用在这个 node 进程，经它起的 claude / grok 不会带上。

const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');

const CODES = new Set(['ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_DESTROYED']);
const seen = new WeakSet();

function isStreamEndWrite(err) {
  return !!err && typeof err === 'object' && CODES.has(err.code);
}

function streamEndErr() {
  const err = new Error('write after end');
  err.code = 'ERR_STREAM_WRITE_AFTER_END';
  return err;
}

function describe(stream) {
  const name = stream && stream.constructor ? stream.constructor.name : 'stream';
  const addr = stream && typeof stream.remoteAddress === 'string' ? stream.remoteAddress : '';
  return addr ? `${name} ${addr}` : name;
}

let noting = false;
function note(stream) {
  if (noting || !stream || seen.has(stream)) return;
  seen.add(stream);
  noting = true;
  try {
    console.error(
      `[mirasim-stream-guard] 已结束的流再 write（${describe(stream)}），丢掉这次写入并拆掉这条连接，进程继续`,
    );
  } finally {
    noting = false;
  }
}

function kick(stream) {
  if (!stream || stream === process.stdout || stream === process.stderr || stream === process.stdin) return;
  if (stream.destroyed || typeof stream.destroy !== 'function') return;
  try {
    stream.destroy();
  } catch {
    // 拆连接失败也不许再把进程带走；上面的写入已经丢了。
  }
}

function dropWrite(stream, cb) {
  note(stream);
  if (typeof cb === 'function') process.nextTick(cb, streamEndErr());
  kick(stream);
  return false;
}

function alreadyEnded(stream) {
  return !!(stream && (stream.writableEnded || stream.destroyed));
}

function guardWrite(orig) {
  if (typeof orig !== 'function' || orig.__mirasimStreamGuard) return orig;
  function guardedWrite(chunk, encoding, cb) {
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    if (alreadyEnded(this)) return dropWrite(this, cb);
    try {
      return orig.call(this, chunk, encoding, cb);
    } catch (err) {
      if (!isStreamEndWrite(err)) throw err;
      return dropWrite(this, cb);
    }
  }
  guardedWrite.__mirasimStreamGuard = true;
  return guardedWrite;
}

Writable.prototype.write = guardWrite(Writable.prototype.write);
http.OutgoingMessage.prototype.write = guardWrite(http.OutgoingMessage.prototype.write);

const origEmit = EventEmitter.prototype.emit;
EventEmitter.prototype.emit = function guardedEmit(type, err) {
  // 没人听 error 时，Node 会在 emit 里直接 throw，整进程退出。这里先接住这一种。
  if (type === 'error' && isStreamEndWrite(err) && this.listenerCount('error') === 0) {
    note(this);
    kick(this);
    return true;
  }
  return origEmit.apply(this, arguments);
};

process.on('uncaughtException', (err) => {
  if (isStreamEndWrite(err)) {
    const stack = err && err.stack ? err.stack : String(err);
    console.error(`[mirasim-stream-guard] 未捕获的写已结束流，进程继续：${stack}`);
    return;
  }
  console.error(err);
  process.exit(1);
});
