// 假 Claude Code：从参数里认会话号（--session-id / --resume）回在 init 里，读 --mcp-config 指的文件；测试里不起真的执行体。
// FAKE_MODE=work 正常一轮；other-session 回一个对不上的会话号；hang 只吐 init 不动。
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const after = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sid = after('--session-id') ?? after('--resume');
const mcp = JSON.parse(readFileSync(after('--mcp-config'), 'utf8'));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let stdin = '';
process.stdin.on('data', (c) => {
  stdin += c;
});
await new Promise((r) => process.stdin.on('end', r));

const mode = process.env.FAKE_MODE ?? 'work';
// replay / replay-hang：把 FAKE_REPLAY 指的 stream-json 样例逐行吐出（__SID__ 换成会话号、__TOKEN__ 换成 FAKE_PLANT）；
// replay-hang 吐完不退，等测试叫停（验证被杀时攒着的过程也写进库）。
if (mode === 'replay' || mode === 'replay-hang') {
  const text = readFileSync(process.env.FAKE_REPLAY, 'utf8')
    .split('__SID__')
    .join(sid)
    .split('__TOKEN__')
    .join(process.env.FAKE_PLANT ?? '');
  for (const l of text.split('\n')) if (l !== '') process.stdout.write(`${l}\n`);
  if (mode === 'replay') process.exit(0);
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
out({
  type: 'system',
  subtype: 'init',
  session_id: mode === 'other-session' ? '00000000-0000-4000-8000-000000000000' : sid,
});
if (mode === 'hang') setInterval(() => {}, 1 << 30);
else {
  const servers = Object.keys(mcp.mcpServers).join(',');
  out({
    type: 'assistant',
    session_id: sid,
    message: { content: [{ type: 'text', text: `收到「${stdin}」，MCP：${servers}` }] },
  });
  out({ type: 'result', session_id: sid });
}
