// 假执行体：按 FAKE_MODE 吐 Claude Code stream-json 那样的行。测试里不起真的执行体。
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const mode = process.env.FAKE_MODE ?? 'work';
const sid = process.env.FAKE_SESSION ?? 'sess-1';
const out = (o) => process.stdout.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`);
const init = () => out({ type: 'system', subtype: 'init', session_id: sid });
const text = (t) =>
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: t }] } });
const toolUse = (name) =>
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', name }] } });
const toolResult = () =>
  out({ type: 'user', session_id: sid, message: { content: [{ type: 'tool_result' }] } });
const hang = () => setInterval(() => {}, 1 << 30);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 开口先写，不等 stdin 结束。并行全套里「等 stdin 再开口」会拖过起步时限，
// 会话号对不上被收成 no_progress，只吐一行的用例也会停在「还没有输出」。
if (mode === 'stall-after-sync') out('Syncing config…');
else init();

let stdin = '';
process.stdin.on('data', (c) => {
  stdin += c;
});
await new Promise((r) => process.stdin.on('end', r));

switch (mode) {
  case 'work':
    text(`收到：${stdin}`);
    toolUse('Bash');
    toolResult();
    out({ type: 'result', session_id: sid });
    break;
  case 'stall-after-sync':
    hang();
    break;
  case 'init-only':
    hang();
    break;
  case 'silent-after-progress':
    text('开始');
    hang();
    break;
  case 'long-tool':
    toolUse('Bash');
    await wait(Number(process.env.FAKE_TOOL_MS ?? 600));
    toolResult();
    out({ type: 'result', session_id: sid });
    break;
  case 'steady':
    for (;;) {
      text('还在干');
      await wait(50);
    }
  case 'ticks': {
    // 慢慢吐一串编号的行（故障用例：内核被杀时执行体还在写）：init、tick 1..N、result，共 N+2 行
    const n = Number(process.env.FAKE_TICKS ?? 40);
    const ms = Number(process.env.FAKE_TICK_MS ?? 50);
    for (let i = 1; i <= n; i++) {
      out(`tick ${i}`);
      await wait(ms);
    }
    out({ type: 'result', session_id: sid });
    break;
  }
  case 'leak-secret':
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
    text('孙子留着');
    break;
  }
  default:
    process.exit(9);
}
