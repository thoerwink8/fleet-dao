// 创始人每条消息一到，原样落盘一份。
//
// 为什么要有它：这个环境里一轮结束会话进程就重开，而他的消息只在「两次工具调用之间的间隙」被送进来——
// 我前台等一条长命令（比如 520 秒）时，那条消息一直在途，会话一断就跟着断，我从头没见到过
// 钩子在「消息提交那一刻」就跑，
// 不经过模型、不依赖那一轮活不活得下来，所以那份留痕跟会话的死活无关。
//
// 挂法：Claude Code 的 UserPromptSubmit 事件（不吃 matcher，永远是整条消息）。登记在 fleet-dao 仓的
// .claude/settings.json，不装进用户级设置。超时按秒（Claude Code 的 hook timeout 单位是秒），项目设置里写 30。
//
// 改这里之前必须知道：
// - **只落盘，绝不插话、绝不拦**：正常路径 exit 0 且一个字符都不往 stdout 打。绝不 exit 2、
//   绝不输出 decision:block、绝不打 additionalContext——UserPromptSubmit 上那几种都会把创始人
//   刚打的字从上下文里抹掉，「防丢的钩子自己制造丢失」是这条路径上最坏的故障。
// - 任何一步出错均 exit 0；身份未知仅 stderr 说明，不输出创始人正文：这里是兜底，不是新的故障点。
// - 入参走 stdin 的 JSON，原文在 `prompt`（未经模型改写）；`prompt_id` 同一轮共用，用它去重。
// - 落盘路径是绝对路径（钩子的 cwd 是用户当前目录，别用相对路径）。
// - 一天一个文件：~/.fleet-dao/prompt-log/<YYYY-MM-DD>.jsonl，一行一条，只追加。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from './is-main.mjs';
import { isMachineOpening, unattendedAuthority } from './unattended.mjs';

/** 落盘目录；测试给 FLEET_PROMPT_LOG_DIR 覆盖。 */
export function logDir(env = process.env, home = homedir()) {
  const o = env.FLEET_PROMPT_LOG_DIR;
  return typeof o === 'string' && o ? o : join(home, '.fleet-dao', 'prompt-log');
}

/**
 * 北京时间的那一天，形如 2026-10-04（文件名用）。
 * @param {number} now
 */
export function dayOf(now) {
  const t = new Date(now + 8 * 60 * 60 * 1000); // 存的是 UTC 毫秒，拨到北京
  return t.toISOString().slice(0, 10);
}

/**
 * 从钩子入参里取出要落盘的那条。
 * 认不出（没有 prompt、不是对象、prompt 是空的）返回 null——不编一条空的进去。
 * @param {unknown} input
 * @param {number} [now]
 */
export function entryFrom(input, now = Date.now()) {
  if (!input || typeof input !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (input);
  const prompt = o.prompt;
  if (typeof prompt !== 'string' || prompt === '') return null;
  return {
    at: new Date(now).toISOString(),
    sessionId: typeof o.session_id === 'string' ? o.session_id : null,
    promptId: typeof o.prompt_id === 'string' ? o.prompt_id : null,
    cwd: typeof o.cwd === 'string' ? o.cwd : null,
    prompt,
  };
}

/**
 * 落盘一条。返回 { ok: true, file, deduped } 或 { ok: false, why }。
 * 同一个 prompt_id 已经在这份文件里出现过就当重复、跳过（钩子被重放、开会话补捞都可能撞上）。
 * @param {ReturnType<typeof entryFrom>} entry
 * @param {{ dir?: string, now?: number }} [opts]
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

/**
 * 这份文件里有没有这个 prompt_id。读不了当没有（宁可重复一条，也不丢）。
 * @param {string} file
 * @param {string} promptId
 */
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
  const authority = unattendedAuthority({
    env,
    cwd: input?.cwd,
    hookId: input?.session_id,
    agentId: input?.agent_id,
  });
  if (authority.kind === 'unknown')
    return {
      ok: false,
      code: 'IDENTITY_UNKNOWN',
      why: `会话来源未知（${authority.code}），不记成创始人历史`,
    };
  if (authority.kind === 'machine' || isMachineOpening(input?.prompt)) return { ok: true, skipped: true };
  return appendEntry(entryFrom(input, now), { dir: logDir(env), now });
}

// 被当脚本跑：读 stdin，做完就退，stdout 永远空、退出码永远0。
const isMain = isMainModule(import.meta);

if (isMain) {
  if (process.env.FLEET_HEADLESS === '1') process.exit(0);
  let text = '';
  try {
    text = readFileSync(0, 'utf8');
  } catch {
    text = '';
  }
  try {
    const result = run({ stdin: text });
    if ('code' in result && result.code === 'IDENTITY_UNKNOWN') process.stderr.write(`${result.why}\n`);
  } catch {
    // 落盘是兜底，任何意外都不许变成新的故障点。
  }
  process.exit(0);
}
