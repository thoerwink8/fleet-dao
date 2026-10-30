// 假工人：像 Claude Code 一样从参数认会话号、读 MCP 配置、读 stdin 里的提示词，再按开关改工作目录里的文件。
// FAKE_OUT_DIR   每次启动写一个 run-<pid>.json（工作目录、提示词、令牌），测试据此数“起了几个工人”、查提示词和令牌
// FAKE_WRITE     "路径:内容;路径:内容"，相对工作目录写文件
// FAKE_MODE      work（默认，正常收尾）| work-hang（干完活不退，等被停）| silent（只吐 init，触发起步无进展）| exit1（干完活退出码 1）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

const outDir = process.env.FAKE_OUT_DIR;
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  const header = mcp.mcpServers.fleet.headers['X-Fleet-Session-Token'];
  writeFileSync(
    join(outDir, `run-${process.pid}.json`),
    JSON.stringify({ cwd: process.cwd(), prompt: stdin, workerAuth: header, args: argv }),
  );
}

const mode = process.env.FAKE_MODE ?? 'work';
out({ type: 'system', subtype: 'init', session_id: sid });
if (mode === 'silent') {
  setInterval(() => {}, 1 << 30);
} else {
  for (const spec of (process.env.FAKE_WRITE ?? '').split(';').filter(Boolean)) {
    const at = spec.indexOf(':');
    const file = join(process.cwd(), spec.slice(0, at));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${spec.slice(at + 1)}\n`);
  }
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: '改好了' }] } });
  if (mode === 'work-hang') setInterval(() => {}, 1 << 30);
  else {
    out({ type: 'result', session_id: sid });
    if (mode === 'exit1') process.exit(1);
  }
}
