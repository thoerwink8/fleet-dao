// 假执行体：按 FAKE_MODE 吐 Claude Code stream-json 那样的行。测试里不起真的执行体。
import { spawn } from 'node:child_process';
import { appendFileSync, readSync, writeSync } from 'node:fs';

const mode = process.env.FAKE_MODE ?? 'work';
const sid = process.env.FAKE_SESSION ?? 'sess-1';
// 同步写到管道上。stdout.write 要等事件循环，机器忙时第一行会晚过起步时限。
const out = (o) => {
  writeSync(1, `${typeof o === 'string' ? o : JSON.stringify(o)}\n`);
};
const init = () => out({ type: 'system', subtype: 'init', session_id: sid });
const text = (t) =>
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: t }] } });
const toolUse = (name) =>
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', name }] } });
const toolResult = () =>
  out({ type: 'user', session_id: sid, message: { content: [{ type: 'tool_result' }] } });
const hang = () => setInterval(() => {}, 1 << 30);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 只有要原文复述提示词的模式才读 stdin，而且放在 init 之后。
// 等 stdin 的 'end' 事件再吐会话号时，Windows 上这个事件一晚到，冲突就会被起步时限收成 no_progress。
// 同步读到 EOF：父进程已经 end 过的管道立刻返回，不跟事件循环抢。管道被设成非阻塞时会 EAGAIN，原地等，不把控制权交回去。
const pause = new Int32Array(new SharedArrayBuffer(4));
const readStdin = () => {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    try {
      const n = readSync(0, buf);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw err;
      Atomics.wait(pause, 0, 0, 20);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
};

switch (mode) {
  case 'work': {
    init();
    const prompt = readStdin();
    text(`收到：${prompt}`);
    toolUse('Bash');
    toolResult();
    out({ type: 'result', session_id: sid });
    break;
  }
  case 'session-mismatch':
    // 只报会话号就挂住，不读 stdin，也不吐实质事件。续会话对不上号要先被看见。
    init();
    hang();
    break;
  case 'stall-after-sync':
    out('Syncing config…');
    hang();
    break;
  case 'init-only':
    init();
    hang();
    break;
  case 'silent-after-progress':
    init();
    text('开始');
    hang();
    break;
  case 'long-tool':
    init();
    toolUse('Bash');
    await wait(Number(process.env.FAKE_TOOL_MS ?? 600));
    toolResult();
    out({ type: 'result', session_id: sid });
    break;
  case 'steady':
    init();
    for (;;) {
      text('还在干');
      await wait(50);
    }
  case 'ticks': {
    // 慢慢吐一串编号的行（故障用例：内核被杀时执行体还在写）：init、tick 1..N、result，共 N+2 行
    const n = Number(process.env.FAKE_TICKS ?? 40);
    const ms = Number(process.env.FAKE_TICK_MS ?? 50);
    init();
    for (let i = 1; i <= n; i++) {
      out(`tick ${i}`);
      await wait(ms);
    }
    out({ type: 'result', session_id: sid });
    break;
  }
  case 'leak-secret':
    init();
    text(`令牌是 ${process.env.FAKE_TOKEN}`);
    process.stderr.write(`出错了 Authorization: Bearer ${process.env.FAKE_TOKEN}\n`);
    break;
  case 'grandchild': {
    // 起一个脱离进程组的孙子（setsid），它继承会话标记；自己先退
    const g = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1<<30)'], {
      detached: true,
      stdio: 'ignore',
    });
    g.unref();
    init();
    text(`孙子 ${g.pid}`);
    break;
  }
  case 'detached-tree': {
    // 派生脱离的孙进程：两个直接的脱离子进程，其中一个自己再派生一个脱离的孙进程（三代）；
    // 每个进程号一行写进 FAKE_PIDS_FILE（测试据此核对叫停后全都不在），然后挂住等人叫停
    const pids = process.env.FAKE_PIDS_FILE;
    const hold = 'setInterval(()=>{}, 1<<30)';
    const note = (pid) => appendFileSync(pids, `${pid}\n`);
    const sub = (code) => {
      const c = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore', windowsHide: true });
      c.unref();
      note(c.pid);
      return c;
    };
    sub(hold);
    sub(
      `const g = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(hold)}], {detached:true,stdio:'ignore',windowsHide:true});` +
        `g.unref(); require('node:fs').appendFileSync(${JSON.stringify(pids)}, g.pid + '\\n');${hold}`,
    );
    note(process.pid);
    init();
    text('派生完了');
    hang();
    break;
  }
  case 'exit-leaving-orphan': {
    // 自己先退，留一个脱离的孙进程
    const c = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1<<30)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    c.unref();
    appendFileSync(process.env.FAKE_PIDS_FILE, `${c.pid}\n`);
    init();
    text('孙子留着');
    break;
  }
  default:
    process.exit(9);
}
