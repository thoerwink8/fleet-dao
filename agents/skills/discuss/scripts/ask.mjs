#!/usr/bin/env node
// 讨论用的一问一答：同一段题面并行问几家，每家一个 cursor-agent 只读会话（空目录、不读仓），硬上限 30 秒。
// 超时、退出码非 0、没有输出都照实记成「没答上」，不当成答了。这台机器没装 cursor-agent、没登录，一家都不问，直接说清。
//
//   node ask.mjs --text 题面.md --round <0|1|2…> [--models gpt[,kimi,glm,grok]] [--limit 30] [--out 目录]
//   --round 0 是各自独立答；1 起是挑错，题面必须带【推演】段（walkthrough.mjs），缺了不发、退出码 2。
//   不给 --models 只问 GPT（创始人 2026-09-26：「和 gpt 讨论就够了」）。结论落在 ~/.local/share/second-opinion/runs/。
//
// 退出码：0 至少一家答上；2 一家都没答上、参数不对，或这台机器缺 cursor-agent。
// 并发上限：同一时刻最多 MAX_PAR 个 cursor-agent（design 第九节起步值 3；2026-09-26 五家齐跑 + 工人把进程数顶满、宿主崩过）。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cursorAgentProblem, dataDir } from './tools.mjs';
import { missingWalkthrough } from './walkthrough.mjs';

export const MODELS = {
  gpt: 'gpt-5.6-luna-high',
  kimi: 'kimi-k3-low',
  glm: 'glm-5.2-high',
  grok: 'grok-4.7-low-fast',
};
const MAX_PAR = 3;

function args(argv) {
  const o = { models: 'gpt', limit: 30 };
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

function askOne(key, model, prompt, limitSec, dir) {
  const started = Date.now();
  return new Promise((resolveP) => {
    const file = join(dir, `q-${key}.md`);
    writeFileSync(file, prompt);
    const child = spawn(
      'cursor-agent',
      [
        '-p',
        '--output-format',
        'text',
        '--trust',
        '--mode',
        'ask',
        '--workspace',
        dir,
        '--model',
        model,
        `读 ${file.split(/[\\/]/).pop()}，照里面的要求作答，只回答案本身。`,
      ],
      { cwd: dir, windowsHide: true, shell: process.platform === 'win32' },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    const done = (ok, why) => {
      clearTimeout(timer);
      resolveP({ key, model, ok, secs: (Date.now() - started) / 1000, text: out.trim(), why });
    };
    const timer = setTimeout(() => {
      child.kill();
      done(false, `超过 ${limitSec} 秒，停掉了`);
    }, limitSec * 1000);
    child.on('error', (e) => done(false, `起不来：${e.message}`));
    child.on('close', (code) => {
      if (code !== 0) return done(false, `退出码 ${code}：${(err || out).trim().slice(0, 200)}`);
      if (!out.trim()) return done(false, '退出码 0 但没有输出');
      done(true);
    });
  });
}

async function main() {
  const o = args(process.argv.slice(2));
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
    if (!MODELS[k]) throw new Error(`不认识的模型 ${k}（${Object.keys(MODELS).join(' / ')}）`);
  // 每家都走本机的 cursor-agent：没装、没登录就一家都不问（不然每家都报同一个错，还得等超时）
  const problem = cursorAgentProblem();
  if (problem) throw new Error(problem);
  // 题面放进自己建的临时目录（也是 cursor-agent 的工作区）：问完、中途出错都删掉，不在 /tmp 里越攒越多
  const dir = mkdtempSync(join(tmpdir(), 'ask-'));
  try {
    const results = [];
    const queue = [...keys];
    await Promise.all(
      Array.from({ length: Math.min(MAX_PAR, queue.length) }, async () => {
        while (queue.length) {
          const k = queue.shift();
          results.push(await askOne(k, MODELS[k], prompt, o.limit, dir));
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
    removeDir(dir);
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

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  main().catch((e) => {
    console.error(`没问成：${e.message}`);
    process.exitCode = 2;
  });
}
