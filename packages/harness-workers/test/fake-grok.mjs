// 假 Grok 命令行：从参数认会话号（-s / -r）和提示词文件，查 GROK_HOME 下的 config.toml 挂了内核的 MCP，
// 把 FAKE_REPLAY 指的 streaming-json 样例逐行吐出（__SID__ 换成会话号、__TOKEN__ 换成 config.toml 里的令牌）。
// 查不对就退出 3 并把原因打到 stderr。测试里不起真的 grok。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const after = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fail = (why) => {
  process.stderr.write(`${why}\n`);
  process.exit(3);
};
const sid = after('-s') ?? after('-r');
const promptFile = after('--prompt-file');
if (!sid) fail('没给会话号');
if (!promptFile || !existsSync(promptFile)) fail('提示词文件不在');
if (readFileSync(promptFile, 'utf8') === '') fail('提示词是空的');
const home = process.env.GROK_HOME;
if (!home) fail('没给 GROK_HOME');
if (!process.env.GROK_AUTH_PATH) fail('没给 GROK_AUTH_PATH');
if (process.env.GROK_DISABLE_AUTOUPDATER !== '1') fail('没关自动升级');
const toml = readFileSync(join(home, 'config.toml'), 'utf8');
const token = /"X-Fleet-Session-Token" = "([^"]+)"/.exec(toml)?.[1];
if (!token) fail('config.toml 里没有内核 MCP 的令牌');
const text = readFileSync(process.env.FAKE_REPLAY, 'utf8')
  .split('__SID__')
  .join(sid)
  .split('__TOKEN__')
  .join(token);
for (const l of text.split('\n')) if (l !== '') process.stdout.write(`${l}\n`);
