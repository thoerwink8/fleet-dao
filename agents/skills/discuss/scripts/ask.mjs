#!/usr/bin/env node
// 讨论用的一问一答：同一段题面依次问几家，每家一个 cursor-agent 只读会话（空目录、不读仓），默认 5 分钟。
// 超时、退出码非 0、没有输出都照实记成「没答上」，不当成答了。这台机器没装 cursor-agent、没登录，一家都不问，直接说清。
//
//   node ask.mjs --text 题面.md --round <0|1|2…> [--models gpt[,kimi,glm,grok]] [--limit 秒] [--out 目录]
//   --round 0 是各自独立答；1 起是挑错，题面必须带【推演】段（walkthrough.mjs），缺了不发、退出码 2。
//   不给 --models 只问 GPT（「和 gpt 讨论就够了」）。结论落在 ~/.local/share/second-opinion/runs/。
//
// 退出码：0 至少一家答上；2 一家都没答上、参数不对，或这台机器缺 cursor-agent。
// cursor-agent 会在启动时改同一份 ~/.cursor/cli-config.json；多进程同时启动会撞 EPERM，
// 所以同一次询问里的几家必须串行。这样牺牲并发，换来多家都能拿到真实结果。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, readCursorModels, resolveModel } from './cursor-models.mjs';
import { stopProcessTree } from './cursor-process.mjs';
import { cursorAgentEnv, cursorAgentProblem, dataDir } from './tools.mjs';
import { missingWalkthrough } from './walkthrough.mjs';

export { MODELS };

const DEFAULT_LIMIT_SEC = 5 * 60;
const MAX_LIMIT_SEC = 15 * 60;

function args(argv) {
  const o = { models: 'gpt', limit: DEFAULT_LIMIT_SEC };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text') o.text = argv[++i];
    else if (a === '--round') o.round = argv[++i];
    else if (a === '--models') o.models = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else throw new Error(`不认识的参数 ${a}`);
  }
  return o;
}

// 断链修复（本机两次实测）：第一版让 cursor-agent 读工作目录里的题面文件，指望 cursorAgentEnv() 摘掉
// Git Bash 留下的 SHELL/MSYSTEM/TERM 就能让它的钩子猜成本机原生壳。实测发现不够：只要父进程链里有 Git Bash，
// 就算连 SHELL/MSYSTEM/TERM/SHLVL/_/EXEPATH/PWD/HOME 全摘、直接起 node.exe、甚至经 powershell.exe 起，Cursor
// 的钩子照样按 bash 跑它那段 PowerShell 转发脚本、把读文件的工具调用拦掉——从纯 PowerShell 会话起才正常。真正
// 不踩这个坑的办法是压根不用文件：不给位置参数，题面从 stdin 喂给它，模型不用调任何工具就能看到题面、直接作答
// （实测 6KB 中文题面走 stdin 正常作答）。cursorAgentEnv() 留着一起用（不影响，多一层保险）。
// 不管是哪种读不到的原因，都用同一招防蒙混：题面最前面塞一行随机核对码，要求原样抄进答案；输出里找不到这个
// 核对码就一律判没答上，不会再被「退出码 0、有输出」当成答了。
// 只处理本次讨论创建的子树。Windows 的 shell 子孙不受 child.kill() 管；
// POSIX 用独立进程组，超时时一起终止，不能留下占工作区/管道的执行体。
export function askOne(
  key,
  model,
  prompt,
  limitSec,
  dir,
  { spawnFn = spawn, stopTree = stopProcessTree } = {},
) {
  const started = Date.now();
  return new Promise((resolveP) => {
    const nonce = randomUUID().slice(0, 8);
    const child = spawnFn(
      'cursor-agent',
      ['-p', '--output-format', 'text', '--trust', '--mode', 'ask', '--workspace', dir, '--model', model],
      {
        cwd: dir,
        windowsHide: true,
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
        env: cursorAgentEnv(),
      },
    );
    child.stdin.on('error', () => {
      // 执行体提前退出时写 stdin 会 EPIPE，结果以退出码和 stdout 为准
    });
    child.stdin.end(
      `核对码：${nonce}\n（把上面这一行原样抄进你回答的第一行，证明你真的收到了这份题面；然后另起一行再答下面的题面，不要写别的过程话。）\n\n${prompt}`,
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    let settled = false;
    let timedOut = false;
    let startError;
    let closeTimer;
    const done = (ok, why, text = out.trim(), cleanupFailed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      resolveP({ key, model, ok, secs: (Date.now() - started) / 1000, text, why, cleanupFailed });
    };
    const unconfirmed = (why) => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      done(false, `超过 ${limitSec} 秒；进程树收尾没查成：${why}`, out.trim(), true);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        stopTree(child);
      } catch (e) {
        unconfirmed(e instanceof Error ? e.message : String(e));
        return;
      }
      // taskkill 成功也要等 close：close 才表示执行体退出且继承的输出管道已关闭。
      closeTimer = setTimeout(() => unconfirmed('终止后输出管道仍未关闭'), 2000);
    }, limitSec * 1000);
    child.on('error', (e) => {
      startError = e.message;
    });
    child.on('close', (code) => {
      if (timedOut) return done(false, `超过 ${limitSec} 秒，已终止进程树并关闭输出`);
      if (startError) return done(false, `起不来：${startError}`);
      if (code !== 0) return done(false, `退出码 ${code}：${(err || out).trim().slice(0, 200)}`);
      const trimmed = out.trim();
      if (!trimmed) return done(false, '退出码 0 但没有输出');
      if (!trimmed.includes(nonce))
        return done(false, `没读到题面（答案里没有题面里的核对码）：${trimmed.slice(0, 200)}`);
      // 读到了：把核对码那一行从记下的答案里去掉，只留真正的答案
      const stripped = trimmed
        .split(/\r?\n/)
        .filter((line) => !line.includes(nonce))
        .join('\n')
        .trim();
      done(true, undefined, stripped);
    });
  });
}

async function main() {
  const o = args(process.argv.slice(2));
  if (!Number.isFinite(o.limit) || o.limit <= 0 || o.limit > MAX_LIMIT_SEC)
    throw new Error(`--limit 必须大于 0 且不超过 ${MAX_LIMIT_SEC} 秒`);
  if (!o.text) throw new Error('要 --text 题面文件');
  const prompt = readFileSync(o.text, 'utf8');
  if (!prompt.trim()) throw new Error(`${o.text} 是空的`);
  if (!/^\d+$/.test(o.round ?? '')) throw new Error('要 --round：0 是各自独立答，1 起是挑错');
  if (Number(o.round) >= 1) {
    const why = missingWalkthrough(prompt);
    if (why) throw new Error(why);
  }
  const keys = o.models
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const k of keys)
    if (!Object.hasOwn(MODELS, k)) throw new Error(`不认识的模型 ${k}（${Object.keys(MODELS).join(' / ')}）`);
  // 每家都走本机的 cursor-agent：没装、没登录就一家都不问（不然每家都报同一个错，还得等超时）
  const problem = cursorAgentProblem();
  if (problem) throw new Error(problem);
  const available = await readCursorModels();
  // 题面放进自己建的临时目录（也是 cursor-agent 的工作区）：问完、中途出错都删掉，不在 /tmp 里越攒越多
  const dir = mkdtempSync(join(tmpdir(), 'ask-'));
  let cleanupFailed = false;
  try {
    const results = [];
    const queue = [...keys];
    await Promise.all(
      Array.from({ length: Math.min(1, queue.length) }, async () => {
        while (queue.length) {
          const k = queue.shift();
          const model = resolveModel(k, available);
          if (!model) {
            results.push({
              key: k,
              model: '无可用型号',
              ok: false,
              secs: 0,
              why: `当前 Cursor 账号无可用 ${k} 型号，未调用其他厂商或 auto`,
            });
            continue;
          }
          const result = await askOne(k, model, prompt, o.limit, dir);
          cleanupFailed ||= result.cleanupFailed;
          results.push(result);
        }
      }),
    );
    results.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
    const md = results
      .map(
        (r) =>
          `## ${r.key}（${r.model}，${r.secs.toFixed(1)} 秒）\n\n${r.ok ? r.text : `没答上：${r.why}`}\n`,
      )
      .join('\n');
    const outDir = o.out ?? join(dataDir(), 'runs');
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `ask-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`);
    writeFileSync(outFile, md);
    console.log(md);
    console.error(outFile);
    process.exitCode = results.some((r) => r.ok) ? 0 : 2;
  } finally {
    if (cleanupFailed) console.error(`执行体收尾没查成，保留临时工作区：${dir}`);
    else removeDir(dir);
  }
}

/**
 * 删自己建的临时目录。删不掉（Windows 上被还没退干净的 cursor-agent 占着之类）不改退出码——答案已经落了盘——
 * 但照实说没删掉、是哪个目录，不当成删好了。rm 换成别的只为造「删不掉」测试。
 */
export function removeDir(dir, rm = rmSync) {
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    console.error(`临时目录没删掉：${dir}：${e instanceof Error ? e.message : String(e)}`);
  }
}

// 入口判定：Node 自带的 import.meta.main 不受软链接影响；旧 Node 退回比真实路径（只比字面路径，经软链接跑时会一声不响什么都不做）
function isMain() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => {
    const r = realpathSync(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(entry) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  main().catch((e) => {
    console.error(`没问成：${e.message}`);
    process.exitCode = 2;
  });
}
