// 各家 AI 实际读没读到规矩（#3111，决定 0107 第 6 条）：pnpm agents:probe，在 agents:sync 之后手动跑。
// 和已有的检查分工：
// - agents-sync 写完照查一遍（sync.ts 的 verify）：只管文件写对了位置、读回和仓里一致，不管 CLI 读不读它；
// - 开会话钩子的「规矩同步」段：只管这台检出跟没跟上主线；
// - agent-eval：只测 Claude 子代理的活干得好不好。
// 这里补的是最后一段：真起一次每家 CLI 的无头会话，问它三件事。判法不信它自报，叫它原样抄只有读到了才抄得出的东西：
// 通用段里「只有两件事停下来问我」下第 1 条的开头、仓根 AGENTS.md 第一行标题、仓的验证命令。
// 花各家额度，所以只在显式跑 pnpm agents:probe 时跑，不挂进每次同步、不节流（一次就是每家一问）。只用已有订阅。
// 结果每家一行：过、没读到什么、没装、没查成（超时、起不来、退出码不是 0、没核过无头写法），没查成不当成过。
import { spawn } from 'node:child_process';
import { type DetectInput, findBin } from './detect.ts';
import { AGENTS, type AgentId } from './targets.ts';

/** 一家最多等多久：冷启动加一问一答，三分钟够；到点杀掉记没查成 */
export const PROBE_TIMEOUT_MS = 180_000;

/** 读到了才抄得出的三样（改通用段、改仓根 AGENTS.md 时跟着核一遍；测试钉着它们真在原件里） */
export const EXPECT = {
  /** agents/shared-rules.md 通用段「只有两件事停下来问我」第 1 条的开头 */
  rules: '要掏新钱',
  /** fleet-dao 仓根 AGENTS.md 第一行标题 */
  agentsMd: 'fleet-dao 协作约定',
  /** fleet-dao 的验证命令 */
  check: 'pnpm check',
} as const;

export const PROBE_PROMPT = [
  '这是一次自检，只回答，不要调用任何工具、不要读写文件、不要跑命令。只凭你这次会话开头已经加载进来的指令回答，没加载的就写「没有」，不要猜。',
  '按下面格式回三行，每行一个冒号：',
  'RULES：你的全局指令里有没有一个小标题叫「只有两件事停下来问我」？有就原样抄出它下面第 1 条的开头四个字；没有写「没有」。',
  'AGENTS：当前工作目录仓根的 AGENTS.md 如果已经加载进来，原样抄出它第一行的标题文字（去掉 # 号）；没加载写「没有」。',
  'CHECK：照你加载的指令，这个仓改完代码用哪条命令做验证？只写命令；指令里没写就写「没有」。',
].join('\n');

/** 每家怎么起一次无头会话。只收核过 --help 或引擎适配器里已在用的写法；其余写 null，结果记「没核过无头写法，没查」。 */
export const HEADLESS: Record<
  AgentId,
  ((prompt: string) => { args: string[]; env?: Record<string, string> }) | null
> = {
  // Claude 一律经 reclaude 起（通用段）；-p 打印一次回答就退
  claude: (p) => ({ args: ['-p', p, '--output-format', 'text'] }),
  // codex exec：非交互，默认只读沙箱
  codex: (p) => ({ args: ['exec', p] }),
  // grok -p 单轮；三个环境变量同 packages/adapters/src/grok/run.ts 的 GROK_UNATTENDED_ENV（测试钉着一致）：
  // 不信任目录时它不加载 AGENTS.md，探出来就是假的「没读到」
  grok: (p) => ({
    args: ['-p', p],
    env: { GROK_DISABLE_AUTOUPDATER: '1', GROK_FOLDER_TRUST: '0', GROK_ASK_USER_QUESTION: '0' },
  }),
  // dsh headless "<任务>"：答一次就退（dsh --help 的例子）
  dsh: (p) => ({ args: ['headless', p] }),
  devin: null,
  pi: null,
  kimi: null,
  agy: null,
  gemini: null,
};

/** Claude 按通用段经 reclaude 起；其余用找到的那个可执行文件 */
const COMMAND_OF: Partial<Record<AgentId, string>> = { claude: 'reclaude' };

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}
export type Runner = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<RunResult>;

export type ProbeStatus = 'pass' | 'missing' | 'not-installed' | 'unchecked';
export interface ProbeLine {
  id: AgentId;
  name: string;
  status: ProbeStatus;
  text: string;
}

/** 回答 → 缺了哪几样（空 = 三样都读到了）。按内容判：抄对了才算，不看它自己说「读到了」。 */
export function judgeAnswer(answer: string): string[] {
  const text = answer.replace(/\r/g, '');
  const field = (key: string) =>
    new RegExp(`^\\s*\\**${key}\\**\\s*[：:]\\s*(.*)$`, 'im').exec(text)?.[1]?.trim() ?? '';
  const missing: string[] = [];
  if (!field('RULES').includes(EXPECT.rules)) missing.push('全局说明里的通用段');
  if (!field('AGENTS').includes(EXPECT.agentsMd)) missing.push('仓根 AGENTS.md');
  if (!field('CHECK').includes(EXPECT.check)) missing.push(`验证命令 ${EXPECT.check}`);
  return missing;
}

/** 报错里的 key（各家 401 会回半截打码的 key，前后缀也不往报告里印） */
export function redactKeys(text: string): string {
  return text.replace(/\b(?:sk|xai|ghp|gho|ghs|AIza)[-_A-Za-z0-9*]{8,}/g, '***');
}

/** 一家的结果 → 一行 */
export function judgeRun(id: AgentId, r: RunResult): ProbeLine {
  const name = AGENTS[id].name;
  const why = r.spawnError
    ? `起不来（${r.spawnError}）`
    : r.timedOut
      ? `超时（${PROBE_TIMEOUT_MS / 1000} 秒没答完）`
      : r.exitCode !== 0
        ? `退出码 ${r.exitCode}：${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ').slice(0, 200)}`
        : null;
  if (why) return { id, name, status: 'unchecked', text: `没查成：${redactKeys(why)}` };
  const missing = judgeAnswer(r.stdout);
  if (missing.length === 0)
    return { id, name, status: 'pass', text: '过：读到了通用段、仓根 AGENTS.md，说得出 pnpm check' };
  return { id, name, status: 'missing', text: `没读到：${missing.join('、')}` };
}

export interface ProbeDeps {
  detect: DetectInput;
  cwd: string;
  run: Runner;
  env: Record<string, string>;
  only?: readonly AgentId[];
}

/** 每家问一次（一家一家来，免得几家同时冷启动把机器压垮） */
export async function probeAll(deps: ProbeDeps): Promise<ProbeLine[]> {
  const out: ProbeLine[] = [];
  for (const id of Object.keys(AGENTS) as AgentId[]) {
    if (deps.only && !deps.only.includes(id)) continue;
    const agent: {
      name: string;
      bins: readonly string[];
      homeDirs?: readonly { win32: string; linux: string }[];
    } = AGENTS[id];
    const bin = agent.bins.map((b) => findBin(b, deps.detect, agent.homeDirs ?? [])).find(Boolean);
    if (!bin) {
      out.push({ id, name: agent.name, status: 'not-installed', text: '没装，没查' });
      continue;
    }
    const how = HEADLESS[id];
    if (!how) {
      out.push({ id, name: agent.name, status: 'unchecked', text: '没查成：没核过它的无头写法' });
      continue;
    }
    const { args, env } = how(PROBE_PROMPT);
    const command = COMMAND_OF[id] ? (findBin(COMMAND_OF[id], deps.detect) ?? bin) : bin;
    const r = await deps.run(command, args, {
      cwd: deps.cwd,
      env: { ...deps.env, ...(env ?? {}) },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    out.push(judgeRun(id, r));
  }
  return out;
}

/** 全过 0；有没读到的 1；只有没查成的（不含没装）2 */
export function probeExitCode(lines: readonly ProbeLine[]): number {
  if (lines.some((l) => l.status === 'missing')) return 1;
  if (lines.some((l) => l.status === 'unchecked')) return 2;
  return 0;
}

export function formatProbe(lines: readonly ProbeLine[]): string {
  const mark: Record<ProbeStatus, string> = {
    pass: '过',
    missing: '缺',
    'not-installed': '—',
    unchecked: '?',
  };
  return [
    '各家读没读到规矩（pnpm agents:probe）：',
    ...lines.map((l) => `  ${mark[l.status]} ${l.name}：${l.text}`),
  ].join('\n');
}

/** 真起子进程：stdin 关掉（有的 CLI 见 stdin 开着会等输入），到点 SIGKILL */
export const realRunner: Runner = (command, args, opts) =>
  new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += String(c);
    });
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ exitCode: null, stdout, stderr, timedOut: false, spawnError: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ exitCode: code, stdout, stderr, timedOut });
    });
  });
