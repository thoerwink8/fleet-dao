// 假执行体：按 FAKE_MODE 吐 Claude Code stream-json 那样的行。测试里不起真的执行体。
import { spawn } from 'node:child_process';

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

let stdin = '';
process.stdin.on('data', (c) => {
  stdin += c;
});
await new Promise((r) => process.stdin.on('end', r));

switch (mode) {
  case 'work':
    init();
    text(`收到：${stdin}`);
    toolUse('Bash');
    toolResult();
    out({ type: 'result', session_id: sid });
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
  default:
    process.exit(9);
}
