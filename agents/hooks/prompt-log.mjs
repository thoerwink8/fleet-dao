// 创始人每条消息一到，原样落盘一份（2026-10-04 他问「丢失我的回复，查到原因和解决了没有」）。
//
// 为什么要有它：这个环境里一轮结束会话进程就重开，而他的消息只在「两次工具调用之间的间隙」被送进来——
// 我前台等一条长命令（比如 520 秒）时，那条消息一直在途，会话一断就跟着断，我从头没见到过
// （2026-10-04 之前 06:08 那 9 条、更早那 9 条拍板都是这么丢的）。钩子在「消息提交那一刻」就跑，
// 不经过模型、不依赖那一轮活不活得下来，所以那份留痕跟会话的死活无关。
//
// 挂法：Claude Code 的 UserPromptSubmit 事件（不吃 matcher，永远是整条消息）。同步工具装在
// agents/config 那套里（packages/agents-sync 的 targets.ts），本机落到 ~/.claude/settings.json。
//
// 改这里之前必须知道：
// - **只落盘，绝不插话、绝不拦**：正常路径 exit 0 且一个字符都不往 stdout 打。绝不 exit 2、
//   绝不输出 decision:block、绝不打 additionalContext——UserPromptSubmit 上那几种都会把创始人
//   刚打的字从上下文里抹掉，「防丢的钩子自己制造丢失」是这条路径上最坏的故障。
// - 任何一步出错一律吞掉（exit 0、不出声）：这里是兜底，不是新的故障点。
// - 入参走 stdin 的 JSON，原文在 `prompt`（未经模型改写）；`prompt_id` 同一轮共用，用它去重。
// - 落盘路径是绝对路径（钩子的 cwd 是用户当前目录，别用相对路径）。
// - 一天一个文件：~/.fleet-dao/prompt-log/<YYYY-MM-DD>.jsonl，一行一条，只追加。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMachineOpening, isMachineSession, noteFounderPrompt, stateDir } from './unattended.mjs';

/** 落盘目录；测试给 FLEET_PROMPT_LOG_DIR 覆盖。 */
export function logDir(env = process.env, home = homedir()) {
  const o = env.FLEET_PROMPT_LOG_DIR;
  return typeof o === 'string' && o ? o : join(home, '.fleet-dao', 'prompt-log');
}

/** 北京时间的那一天，形如 2026-10-04（文件名用）。 */
export function dayOf(now) {
  const t = new Date(now + 8 * 60 * 60 * 1000); // 存的是 UTC 毫秒，拨到北京
  return t.toISOString().slice(0, 10);
}

/**
 * 从钩子入参里取出要落盘的那条。
 * 认不出（没有 prompt、不是对象、prompt 是空的）返回 null——不编一条空的进去。
 */
export function entryFrom(input, now = Date.now()) {
  if (!input || typeof input !== 'object') return null;
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || prompt === '') return null;
  return {
    at: new Date(now).toISOString(),
    sessionId: typeof input.session_id === 'string' ? input.session_id : null,
    promptId: typeof input.prompt_id === 'string' ? input.prompt_id : null,
    cwd: typeof input.cwd === 'string' ? input.cwd : null,
    prompt,
  };
}

/**
 * 落盘一条。返回 { ok: true, file, deduped } 或 { ok: false, why }。
 * 同一个 prompt_id 已经在这份文件里出现过就当重复、跳过（钩子被重放、开会话补捞都可能撞上）。
 */
export function appendEntry(entry, { dir = logDir(), now = Date.now() } = {}) {
  if (!entry) return { ok: false, why: '没有可落盘的内容' };
  let file;
  try {
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${dayOf(now)}.jsonl`);
    if (entry.promptId && alreadyLogged(file, entry.promptId)) {
      return { ok: true, file, deduped: true };
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return { ok: true, file, deduped: false };
  } catch (e) {
    return { ok: false, why: `写不进：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 这份文件里有没有这个 prompt_id。读不了当没有（宁可重复一条，也不丢）。 */
function alreadyLogged(file, promptId) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  return text.includes(`"promptId":${JSON.stringify(promptId)}`);
}

/** 钩子入口：stdin 读 JSON、落盘、exit 0 不出声。永远不抛。 */
export function run({ stdin = '', env = process.env, now = Date.now() } = {}) {
  let input = null;
  try {
    input = JSON.parse(stdin || '{}');
  } catch {
    return { ok: false, why: '入参不是 JSON' };
  }
  // 机器派的会话（工人、反方）的提示不是创始人的话：不落盘，免得开会话列「创始人最近的话」时把真话挤出去
  if (isMachineSession({ env, cwd: input?.cwd }) || isMachineOpening(input?.prompt))
    return { ok: true, skipped: true };
  // 顺手记一笔「他的话到了、还没送达」（只写一个状态文件，照旧不出声；为什么要记见 unattended.mjs「创始人的话到了」那段）
  noteFounderPrompt({ dir: stateDir(env), sessionId: input?.session_id, prompt: input?.prompt, now });
  return appendEntry(entryFrom(input, now), { dir: logDir(env), now });
}

// 被当脚本跑（钩子就是这么跑的）：读 stdin，做完就退，绝不出声、绝不非 0。
// 判「是不是被当脚本跑」要比路径：Windows 上 import.meta.url 是 file:///D:/…（三个斜杠）、盘符还带冒号，
// 自己拼 `file://${argv[1]}` 永远对不上——那样脚本一声不响地什么都不做，钩子装了等于没装
// （2026-10-04 就是这么被测试逮住的）。用 fileURLToPath 比，两边都归成同一种写法。
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  let text = '';
  try {
    text = readFileSync(0, 'utf8');
  } catch {
    text = '';
  }
  try {
    run({ stdin: text });
  } catch {
    // 落盘是兜底，任何意外都不许变成新的故障点。
  }
  process.exit(0);
}
