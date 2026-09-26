// 改帅位本机进度页的数据：node p.mjs <项目> <命令> [参数…]；不带参数看用法。逻辑都在 progress-lib.mjs。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { runProgressCli } from './progress-lib.mjs';

process.exitCode = runProgressCli(process.argv.slice(2), {
  home: homedir(),
  now: () => new Date(),
  readText: (file) => readFileSync(file, 'utf8'),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
