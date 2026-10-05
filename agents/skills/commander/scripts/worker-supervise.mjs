// Claude 工人的外壳：worker.mjs start 起 Claude 工人时，后台起的不是 reclaude 本身、而是这个脚本，由它起 reclaude 并看着它。
// 为什么要它（2026-10-05 16:56，#1066）：reclaude 网关 502 了十几分钟，5 个 Claude 工人同时以
// 「API Error: 502 无法连接 reclaude 网关」退出，手上的活全靠指挥官重派，前后约 22 分钟。这类退出不是工人做错了什么，
// 等一会儿接着同一个会话跑就行。所以：reclaude 退出时看它最后的 result 事件（stream-json），是网关/网络类错误
// （API Error 5xx、连接类）就等一等、用 --resume <会话号> 接着跑；认不出的错误照旧当真退出，原样把退出码交出去。
// - 等多久：第 1 次 60 秒，往后翻倍、封顶 10 分钟（60、120、240、480、600），最多续 5 次；续了几次写进 meta.json 的 resumes，
//   status / watch 看得到；每次等和续都往日志（out.log）里写一句人话，status 的「最后一句输出」就是它。
// - 续跑：reclaude -p --resume <会话号> …（和起的时候同一套参数），从标准输入给一句「接着做」；2026-10-05 在本机用真 reclaude
//   核实过：-p 配 --resume 会话号、提示词走 stdin，会话号不变、记得之前的内容。会话还没起来（日志里一个会话号都没有）就挂了的，
//   没有任何动作发生过，用原来的提示词从头再起一次。
// - 只管 Claude：别家模型（grok、codex）的工人不经这里。
// - 工人被 stop（taskkill /T 杀进程树）时这个脚本连同 reclaude 一起死，不会自己续跑。
// 本文件顶层的 main 只在被当脚本跑时才执行（测试能直接 import 里面的函数）。
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { windowsCmdLine } from './windows-quote.mjs';

/** 第 n 次续跑前等多少秒（拉长）；数组长度就是最多续几次。 */
export const RESUME_DELAYS_SEC = [60, 120, 240, 480, 600];

/**
 * 网关/网络类错误的特征：Claude Code 把 API 失败写成 result 事件（is_error: true）里的一句「API Error: 502 …」。
 * 认 5xx 和连接类；4xx（鉴权、限额）、别的错误不认，照旧算真退出。
 */
export const NETWORK_ERROR_RE =
  /API Error:\s*5\d\d\b|无法连接|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|Connection error|Unable to connect|overloaded_error/i;

/** 续跑时从标准输入给的话。 */
export const RESUME_PROMPT =
  '外壳提示：刚才因为 reclaude 网关/网络出错中断了，现在已经恢复。请接着中断的地方继续做，做完的步骤不要重做；最后照原来的要求交活。';

/**
 * 一路读 stream-json 的输出（一行一个事件），记下要用的三样：会话号、最后一个 result 事件、最后一句 API 报错文字。
 * 一行行喂（可以任意切块），认不出的行忽略（普通文字、别的事件）。
 */
export class EventTracker {
  constructor() {
    this.pending = '';
    /** @type {string | null} */
    this.sessionId = null;
    /** @type {{ is_error?: unknown, result?: unknown } | null} */
    this.lastResult = null;
  }

  /** @param {string} chunk */
  feed(chunk) {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  /** 收尾：最后一行没有换行也要认。 */
  end() {
    if (this.pending) this.line(this.pending);
    this.pending = '';
  }

  /** @param {string} raw */
  line(raw) {
    const line = raw.trim();
    if (!line.startsWith('{')) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!ev || typeof ev !== 'object') return;
    if (typeof ev.session_id === 'string' && ev.session_id) this.sessionId = ev.session_id;
    if (ev.type === 'result') this.lastResult = ev;
  }
}

/**
 * 一次 reclaude 退出算哪一种：
 * - done：result 事件不是错误（正常做完了，退出码照它的）；
 * - network：最后的 result 事件 is_error 且文字是网关/网络类；或者根本没有 result 事件（进程被打断、没来得及出结论）、
 *   退出码非 0、标准错误里有这类特征；
 * - other：别的一切（认不出的照旧当真退出）。
 * @param {{ code: number | null, tracker: EventTracker, errTail: string }} x
 * @returns {{ kind: 'done' | 'network' | 'other', why: string }}
 */
export function classifyExit({ code, tracker, errTail }) {
  const r = tracker.lastResult;
  if (r) {
    if (r.is_error !== true) return { kind: 'done', why: '' };
    const text = typeof r.result === 'string' ? r.result : '';
    const why = firstLine(text);
    return NETWORK_ERROR_RE.test(text) ? { kind: 'network', why } : { kind: 'other', why };
  }
  if (code !== 0 && NETWORK_ERROR_RE.test(errTail)) return { kind: 'network', why: firstLine(errTail) };
  return { kind: 'other', why: '' };
}

/** @param {string} text */
function firstLine(text) {
  const row = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return (row ?? '').slice(0, 160);
}

/**
 * 看着 reclaude 跑：网关/网络类错误退出就等一等、用同一个会话续，最多续 delays.length 次；其余原样把退出码交出去。
 * io：{ runChild(extraArgs, stdinText) → Promise<{ code, tracker, errTail }>, sleep(ms), say(line), recordResume({ resumes, sessionId, why }) }。
 * @param {{ promptText: string, delays?: number[], io: { runChild: (extraArgs: string[], stdinText: string) => Promise<{ code: number | null, tracker: EventTracker, errTail: string }>, sleep: (ms: number) => Promise<void>, say: (line: string) => void, recordResume: (r: { resumes: number, sessionId: string | null, why: string }) => void } }} o
 * @returns {Promise<number>} 退出码
 */
export async function superviseLoop({ promptText, delays = RESUME_DELAYS_SEC, io }) {
  /** @type {string[]} */
  let extraArgs = [];
  let stdinText = promptText;
  /** @type {string | null} */
  let sessionId = null;
  for (let resumes = 0; ; resumes++) {
    const { code, tracker, errTail } = await io.runChild(extraArgs, stdinText);
    sessionId = tracker.sessionId ?? sessionId;
    const c = classifyExit({ code, tracker, errTail });
    if (c.kind !== 'network') return code ?? 1;
    if (resumes >= delays.length) {
      io.say(`【外壳】网关/网络错误（${c.why}），已经续跑 ${resumes} 次还是不行，不再续了`);
      return code ?? 1;
    }
    const wait = delays[resumes] ?? 0;
    io.say(
      `【外壳】网关/网络错误（${c.why}），${wait} 秒后第 ${resumes + 1}/${delays.length} 次${sessionId ? `用会话 ${sessionId} 接着跑` : '重新起（会话还没起来）'}`,
    );
    await io.sleep(wait * 1000);
    io.recordResume({ resumes: resumes + 1, sessionId, why: c.why });
    if (sessionId) {
      extraArgs = ['--resume', sessionId];
      stdinText = RESUME_PROMPT;
    } else {
      extraArgs = [];
      stdinText = promptText;
    }
  }
}

/**
 * 把续跑次数记进 meta.json（先写临时文件再改名，status 不会读到写了一半的）。读不了、写不了都明说，不让工人因此挂掉。
 * @param {string} metaFile
 * @param {{ resumes: number, sessionId: string | null, why: string }} r
 * @param {(line: string) => void} say
 * @param {() => Date} [now]
 */
export function recordResumeInMeta(metaFile, r, say, now = () => new Date()) {
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    const next = {
      ...meta,
      resumes: r.resumes,
      lastResumeAt: now().toISOString(),
      lastResumeWhy: r.why,
      sessionId: r.sessionId,
    };
    const tmp = `${metaFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, metaFile);
  } catch (e) {
    say(
      `【外壳】续跑次数没记进 ${metaFile}（${e instanceof Error ? e.message : String(e)}）；status 看不到这次续跑`,
    );
  }
}

/** @param {string[]} argv */
function parseArgv(argv) {
  const at = argv.indexOf('--');
  if (at < 0)
    throw new Error(
      '缺 `--`：用法 worker-supervise.mjs --meta <meta.json> --prompt <提示词文件> [--delays-sec 60,120] -- <命令> <参数…>',
    );
  const opts = new Map();
  for (let i = 0; i < at; i += 2) opts.set(argv[i], argv[i + 1]);
  const command = argv[at + 1];
  const metaFile = opts.get('--meta');
  const promptFile = opts.get('--prompt');
  if (!command || !metaFile || !promptFile) throw new Error('要带 --meta、--prompt，`--` 后面要有命令');
  const delaysArg = opts.get('--delays-sec');
  const delays = delaysArg ? delaysArg.split(',').map(Number) : RESUME_DELAYS_SEC;
  if (delays.some((n) => !Number.isFinite(n) || n < 0)) throw new Error(`--delays-sec 认不出：${delaysArg}`);
  return { command, args: argv.slice(at + 2), metaFile, promptFile, delays };
}

/** 真起 reclaude：输出一路原样转给自己的 stdout/stderr（日志文件），同时喂给 tracker。 */
function realRunChild(command, args) {
  return (extraArgs, stdinText) =>
    new Promise((resolve) => {
      const all = [...args, ...extraArgs];
      const child =
        process.platform === 'win32'
          ? spawn('cmd.exe', ['/d', '/s', '/c', windowsCmdLine(command, all)], {
              windowsHide: true,
              windowsVerbatimArguments: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            })
          : spawn(command, all, { stdio: ['pipe', 'pipe', 'pipe'] });
      const tracker = new EventTracker();
      let errTail = '';
      child.stdout.setEncoding('utf8').on('data', (d) => {
        process.stdout.write(d);
        tracker.feed(d);
      });
      child.stderr.setEncoding('utf8').on('data', (d) => {
        process.stderr.write(d);
        errTail = (errTail + d).slice(-4000);
      });
      child.stdin.on('error', () => {
        // 进程提前退出时写 stdin 会 EPIPE，结果以退出码和输出为准
      });
      child.stdin.end(stdinText);
      child.on('error', (e) => {
        errTail += `\n起不来：${e.message}`;
      });
      child.on('close', (code) => {
        tracker.end();
        resolve({ code, tracker, errTail });
      });
    });
}

async function main() {
  const { command, args, metaFile, promptFile, delays } = parseArgv(process.argv.slice(2));
  const say = (line) => process.stdout.write(`${line}\n`);
  process.exitCode = await superviseLoop({
    promptText: readFileSync(promptFile, 'utf8'),
    delays,
    io: {
      runChild: realRunChild(command, args),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      say,
      recordResume: (r) => recordResumeInMeta(metaFile, r, say),
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
