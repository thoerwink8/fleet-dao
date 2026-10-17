// 只读本会话原生重启通知，恢复上一会话未结束的后台任务；不参与消息投递。
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanSessionId } from './session-id.mjs';

const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));
/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} path */
function transcriptTail(path) {
  if (typeof path !== 'string' || path === '') return '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const INTERRUPTED_BACKGROUND_RE = /did(?:n['’]?t| not) finish before the previous session ended/i;
const MAX_BACKGROUND_TEXT = 1200;
/** 同一次重启的几条通知之间最多隔几行（中间会夹队列行） */
const RESTART_BATCH_GAP = 8;

/**
 * 这一行是不是 Claude Code 自己发的「上一会话没跑完」通知。
 * 真样本：{type:'user', origin:{kind:'task-notification'}, message:{content:'<task-notification>…<summary>… didn't finish before the previous session ended</summary>…'}}。
 * @param {unknown} value
 */
function restartNotice(value) {
  if (!isObj(value) || value.type !== 'user') return false;
  if (!isObj(value.origin) || value.origin.kind !== 'task-notification') return false;
  const text = textOf(isObj(value.message) ? value.message.content : undefined);
  const summary = text.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)?.[1] ?? '';
  return INTERRUPTED_BACKGROUND_RE.test(summary);
}

/** @param {unknown} v */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v.map((b) => (isObj(b) && b.type === 'text' ? String(b.text ?? '') : '')).join('');
}

/** @param {string} text */
function shortBackgroundText(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > MAX_BACKGROUND_TEXT ? `${clean.slice(0, MAX_BACKGROUND_TEXT)}……` : clean;
}

/**
 * 从 transcript 里找上一会话收场时仍在跑的后台任务。
 * Claude Code 的任务启动、启动回执和重启通知不是固定一种 JSON 形状，所以这里同时认
 * Agent/Task/Bash 的 tool_use、回执里的 agentId，以及通知里的 task-id；认不出编号时
 * 退回 tool_use id，至少给会话一个能定位原调用的编号。
 * @param {string} tail
 */
function interruptedBackgroundTasks(tail) {
  const lines = tail.split('\n');
  const parsed = lines.map((text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  });

  // 只认 Claude Code 自己发的重启通知：type=user、origin.kind=task-notification、summary 里带原话。
  // 钩子注入的上下文、助手的话、用户消息里引用这句，都不是通知。
  const restartLines = [];
  for (let i = 0; i < parsed.length; i++) if (restartNotice(parsed[i])) restartLines.push(i);
  if (restartLines.length === 0) return null;
  // 一次重启会连发好几条（每个任务一条，中间隔着队列行）；取最近一批：相邻两条隔得不远算同一批。
  let first = restartLines.length - 1;
  while (first > 0 && (restartLines[first] ?? 0) - (restartLines[first - 1] ?? 0) <= RESTART_BATCH_GAP)
    first--;
  const batch = restartLines.slice(first);
  const boundary = batch[0] ?? 0;
  const lastNotice = parsed[batch[batch.length - 1] ?? 0];

  /** @type {{ kind: 'agent' | 'command', id: string, ref: string, taskId?: string, description: string, line: number }[]} */
  const launched = [];
  const completed = new Set();
  const stoppedIds = new Set();
  /** 调用没成功（被钩子挡掉等）的 tool_use id */
  const failedCalls = new Set();
  /** @type {string[]} */
  const notificationTexts = [];

  /** @param {unknown} value @param {number} line */
  const inspect = (value, line) => {
    if (!isObj(value)) return;
    const content = isObj(value.message) ? value.message.content : undefined;
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (isObj(block) && block.type === 'tool_result' && block.is_error === true) {
        if (typeof block.tool_use_id === 'string') failedCalls.add(block.tool_use_id);
        continue;
      }
      // 通知之后派的不算上一会话留下的
      if (line >= boundary) continue;
      if (!isObj(block) || block.type !== 'tool_use' || !isObj(block.input)) continue;
      const name = String(block.name ?? '');
      const spec = block.input;
      if (spec.run_in_background !== true) continue;
      const ref = typeof block.id === 'string' && block.id ? block.id : `tool-${line + 1}`;
      if (name === 'Agent' || name === 'Task') {
        launched.push({
          kind: 'agent',
          id: ref,
          ref,
          description: shortBackgroundText(
            [String(spec.description ?? ''), textOf(spec.prompt)].filter((s) => s.trim() !== '').join('；') ||
              '（没有任务说明）',
          ),
          line,
        });
      } else if (name === 'Bash' || name === 'PowerShell' || name === 'Shell') {
        launched.push({
          kind: 'command',
          id: ref,
          ref,
          description: shortBackgroundText(
            String(spec.command ?? spec.script ?? '') || String(spec.description ?? '') || '（没有命令说明）',
          ),
          line,
        });
      }
    }
    // 任务通知（完成/停止）：只认 Claude Code 发的那种行
    if (isObj(value.origin) && value.origin.kind === 'task-notification') {
      const notification = textOf(content);
      const status = notification.match(/<status>\s*([^<]+?)\s*<\/status>/i)?.[1]?.toLowerCase();
      const taskId = notification.match(/<task-id>\s*([^<]+?)\s*<\/task-id>/i)?.[1]?.trim();
      if (restartNotice(value)) {
        if (batch.includes(line)) {
          notificationTexts.push(notification);
          if (taskId) stoppedIds.add(taskId);
        }
      } else if (
        taskId &&
        (status === 'completed' || status === 'succeeded' || status === 'failed' || status === 'error')
      ) {
        // 通知前后都算：通知前已收尾的不用补；用 SendMessage 续上后又收尾的也不用补
        completed.add(taskId);
      }
    }
  };

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line] ?? '';
    inspect(parsed[line], line);
    // 启动回执通常紧跟 Agent tool_use；把真实 agentId 绑回最近一个尚未编号的代理。
    if (line >= boundary) continue;
    const taskId = text.match(/(?:agentId|agent_id|taskId|task_id)\s*[:=]\s*["']?([A-Za-z0-9_.-]+)/i)?.[1];
    if (taskId) {
      const pending = [...launched].reverse().find((t) => !t.taskId && t.line <= line);
      if (pending) pending.taskId = taskId;
    }
  }

  // 通知列了编号就以它为准；没列编号时取通知前派出、没收到完成通知的后台启动项。
  // 没起来（调用被挡掉、工具结果是错误）的不算。
  const alive = launched.filter((t) => !failedCalls.has(t.ref));
  const finished = (/** @type {{ id: string, taskId?: string }} */ t) =>
    completed.has(t.id) || (t.taskId !== undefined && completed.has(t.taskId));
  const selected =
    stoppedIds.size > 0
      ? alive.filter((t) => (stoppedIds.has(t.id) || (t.taskId && stoppedIds.has(t.taskId))) && !finished(t))
      : alive.filter((t) => !finished(t));
  const unique = [];
  const seen = new Set();
  for (const task of selected) {
    const id = task.taskId ?? task.id;
    if (seen.has(`${task.kind}:${id}`)) continue;
    seen.add(`${task.kind}:${id}`);
    unique.push({ ...task, id });
  }
  if (stoppedIds.size > 0) {
    const notice = notificationTexts.join('\n');
    const summary =
      notice
        .match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)?.[1]
        ?.replace(/\s+/g, ' ')
        .trim() ?? '（通知里没有找到当时的任务说明）';
    const kind = /\b(?:Bash|PowerShell|Shell|command)\b/i.test(summary) ? 'command' : 'agent';
    for (const id of stoppedIds) {
      if (launched.some((task) => task.id === id || task.taskId === id)) continue;
      if (completed.has(id)) continue;
      unique.push({ kind, id, ref: id, description: shortBackgroundText(summary), line: 0 });
    }
  }
  // key 绑在那批重启通知上（最后一条的 uuid，没有就用行位置）；之后再派任务、记录变长都不改它。
  const noticeId =
    isObj(lastNotice) && typeof lastNotice.uuid === 'string' ? lastNotice.uuid : `line-${boundary}`;
  return { key: `restart:${noticeId}`, tasks: unique };
}

/**
 * 重启后 Claude Code 会发一条「上一会话没跑完」的任务通知。
 * 把它变成能直接接手的上下文；同一次重启只提醒一次（key 绑在那条通知上）。
 * @param {string} tail
 * @param {Record<string, unknown>} state
 */
function interruptedBackgroundContext(tail, state) {
  const found = interruptedBackgroundTasks(tail);
  if (!found || found.key === state.backgroundRestartKey) return null;
  const agents = found.tasks.filter((t) => t.kind === 'agent');
  const commands = found.tasks.filter((t) => t.kind === 'command');
  // 通知里列的任务都已收尾（含用 SendMessage 续上后收尾的）：没有要补的
  if (agents.length === 0 && commands.length === 0) return null;
  const lines = ['上一会话结束时没跑完、被停掉的后台任务（Claude Code 重启通知里列出的）：'];
  if (agents.length > 0) {
    lines.push(...agents.map((t) => `子代理编号 ${t.id}：任务说明：${t.description}`));
    lines.push('请逐个用 SendMessage 按子代理编号续上；不要把已经有的任务凭空再派一遍。');
  }
  if (commands.length > 0) {
    lines.push(...commands.map((t) => `后台命令 ${t.id}：${t.description}`));
    lines.push('这些后台命令要不要重跑，由本会话判断。');
  }
  return { key: found.key, text: lines.join('\n') };
}

/**
 * 兼容已有 tick 状态，只保留重启通知键；旧的投递账不读取。
 * @param {unknown} input
 * @param {{home?:string,env?:Record<string,string|undefined>,now?:number}} [opts]
 * @returns {Promise<string|null>}
 */
export async function backgroundRecoveryContext(input, { home = homedir(), env = process.env } = {}) {
  if (!isObj(input) || 'hookEventName' in input || ('toolName' in input && !('tool_name' in input)))
    return null;
  if (typeof input.agent_id === 'string' && input.agent_id.trim() !== '') return null;
  const sid = cleanSessionId(input.session_id);
  if (sid === null) return null;
  const dir = env.FLEET_INBOX_SEEN_DIR || join(home, '.fleet-dao', 'inbox-seen');
  const file = join(dir, 'tick-' + sid + '.json');
  try {
    let state = {};
    let stateProblem = '';
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObj(parsed)) throw new Error('状态不是对象');
      state = parsed;
    } catch (e) {
      if (!(isObj(e) && e.code === 'ENOENT'))
        stateProblem = '后台任务恢复没查成：状态 ' + file + ' 读不了（' + why(e) + '）';
    }
    const restart = interruptedBackgroundContext(transcriptTail(input.transcript_path), state);
    if (!restart) return stateProblem || null;
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      writeFileSync(tmp, JSON.stringify({ backgroundRestartKey: restart.key }), 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      return [restart.text, stateProblem, '后台任务恢复提示未记住：' + why(e)].filter(Boolean).join('\n');
    }
    return [restart.text, stateProblem].filter(Boolean).join('\n');
  } catch (e) {
    return '后台任务恢复没查成：' + why(e);
  }
}
