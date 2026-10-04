// 把进来的文字里的密钥值打码，结果打出去（agents-sync 和 redact.mjs 一起装进 ~/.fleet-dao/hooks/）。
// 用法：打印进程命令行、列环境变量、`ps aux` 这类会把密钥打出来的命令，输出接一条管道过这里：
//   ps -ef | node "$HOME/.fleet-dao/hooks/redact-secrets.mjs"
//   Get-CimInstance Win32_Process | Select-Object CommandLine | node "$HOME/.fleet-dao/hooks/redact-secrets.mjs"
//   ... | node redact-secrets.mjs | grep lark-mcp
// 也可以读文件：node redact-secrets.mjs <文件>…（读不了的文件明说、退出码 1，不打空）。
// 打码的规则在 redact.mjs：-s/--secret/--token/--password 的值、名字带 secret/token 的 JSON 字段。
//
// 退出码：0 全打码完了；1 有读不了的文件、或者标准输入读不成（编码坏掉）；2 用法不对。
// 认不出、读不了就是明确的失败，不拿空当当没事——管道里上游还接着，别让下游把「空」当成「没有密钥」。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from './redact.mjs';

/** 读标准输入的全部内容；读不成返回 { error }（不让 readFileSync(0) 的异常把退出码弄成 1 却什么都不说） */
export function readStdin(read = () => readFileSync(0, 'utf8')) {
  try {
    return { text: read() };
  } catch (err) {
    return { error: err?.code ?? err?.message ?? String(err) };
  }
}

/**
 * 命令行：io.out / io.err 各收一行，返回退出码。
 * args 里给文件名就读文件（每个文件一段）；没给就读标准输入。两样都没有也读标准输入（管道那头没有东西就是空）。
 */
export function main(argv, io, readStdinFn) {
  if (argv.includes('-h') || argv.includes('--help')) {
    io.err(
      '用法：node redact-secrets.mjs [文件…]——把 -s / --secret / --token / --password 的值、名字带 secret/token 的 JSON 字段换成 ***；不给文件就读标准输入（管道：ps aux | node redact-secrets.mjs）',
    );
    return 2;
  }
  if (argv.length === 0) {
    const got = readStdin(readStdinFn);
    if (got.error !== undefined) {
      io.err(`redact-secrets：读不了标准输入（${got.error}），没打码、也没打出去`);
      return 1;
    }
    io.out(redactText(got.text));
    return 0;
  }
  let failed = false;
  for (const file of argv) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      failed = true;
      io.err(`redact-secrets：读不了 ${file}（${err?.code ?? err}）`);
      continue;
    }
    io.out(redactText(text));
  }
  return failed ? 1 : 0;
}

/** 直接跑（node 文件、或者经 ssh 从标准输入喂进去的 node -）才执行；被测试 import 时不跑 */
function isMain() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  const entry = process.argv[1];
  if (entry === '-') return true;
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const out = (line) => process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
  process.exitCode = main(argv, { out, err: (line) => process.stderr.write(`${line}\n`) });
}
