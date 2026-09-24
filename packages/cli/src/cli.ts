// fleet 命令：解析参数 → 按 agent-api 约定校验 → 调后端 → 用白话打印结果。进程无关，测试直接调 runFleet。
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import {
  AgentRoutes,
  AskRequest,
  AskResponse,
  BlockedRequest,
  DoneRequest,
  HistoryRequest,
  HistoryResponse,
  PlanRequest,
  SayRequest,
  TaskResponse,
} from '@fleet-dao/shared';
import { z } from 'zod';
import { type BackendCall, CliError, callBackend, EXIT } from './client.ts';
import { COMMAND_HELP, MAIN_HELP } from './help.ts';

z.config(z.locales.zhCN());

/**
 * 等回答的 ask 最多等这么久：要长于后端等回答的上限（否则后端回 pending 之前这边先超时），
 * 又要短于会话里单条命令的超时（否则命令先被执行体杀掉，AI 只看到超时）。后一条有测试钉着。
 */
export const ASK_WAIT_MS = 6 * 60_000;

export interface CliIo {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** 测试用：缩短超时和重试间隔。 */
  timing?: { requestMs?: number; askMs?: number; retryDelaysMs?: readonly number[] };
}

type Step = z.infer<typeof PlanRequest>['steps'][number];
type Handler = (args: string[], ctx: Context) => Promise<void>;

interface Context {
  io: CliIo;
  call: (call: BackendCall) => Promise<unknown>;
}

export async function runFleet(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    await dispatch([...argv], io);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(`fleet：${err.message}\n`);
      return err.exitCode;
    }
    io.stderr(`fleet：意外出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return EXIT.backend;
  }
}

async function dispatch(argv: string[], io: CliIo): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help') {
    io.stdout(MAIN_HELP);
    return;
  }
  if (command === 'help') {
    const topic = rest[0];
    io.stdout((topic && COMMAND_HELP[topic]) || MAIN_HELP);
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new CliError(EXIT.usage, `没有「${command}」这个子命令。看 fleet --help`);
  if (rest.includes('-h') || rest.includes('--help')) {
    io.stdout(COMMAND_HELP[command] ?? MAIN_HELP);
    return;
  }
  await handler(rest, { io, call: connect(io) });
}

function connect(io: CliIo): (call: BackendCall) => Promise<unknown> {
  const api = io.env.FLEET_API?.trim();
  const token = io.env.FLEET_TOKEN?.trim();
  const hint = '这个命令要在 fleet 派的会话里用，引擎起会话时会给好';
  if (!api) throw new CliError(EXIT.usage, `缺环境变量 FLEET_API（后端地址）。${hint}`);
  if (!token) throw new CliError(EXIT.usage, `缺环境变量 FLEET_TOKEN（通行证）。${hint}`);
  if (!/^https?:\/\/[^\s/]+/.test(api)) throw new CliError(EXIT.usage, `FLEET_API 不是 http(s) 地址：${api}`);
  const timing = io.timing ?? {};
  return (call) =>
    callBackend(
      {
        baseUrl: api,
        token,
        fetch: io.fetch,
        sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        onRetry: (message) => io.stderr(`fleet：${message}\n`),
        ...(timing.retryDelaysMs ? { retryDelaysMs: timing.retryDelaysMs } : {}),
        ...(timing.requestMs ? { timeoutMs: timing.requestMs } : {}),
      },
      call,
    );
}

/** 各子命令用到的选项合在一起；每个子命令只声明自己那几个，多给的会被 strict 拦下。 */
interface Options {
  json?: boolean;
  option?: string[];
  'no-wait'?: boolean;
  limit?: string;
  tests?: string;
  needs?: string;
}

function parse(
  args: string[],
  options: ParseArgsOptionsConfig = {},
): { values: Options; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args,
      options: { json: { type: 'boolean' }, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { values: parsed.values as Options, positionals: parsed.positionals };
  } catch (err) {
    throw new CliError(EXIT.usage, `参数不对：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 按 agent-api 的约定校验；不合格就在本地挡下，不发请求。 */
function check<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map(
    (i) => `${i.path.length ? `${i.path.join('.')}：` : ''}${i.message}`,
  );
  throw new CliError(EXIT.usage, `参数不对：${issues.join('；')}`);
}

/** 后端回的数据不合约定：算后端出错。 */
function expectShape<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new CliError(EXIT.backend, `后端回的${what}格式不对：${result.error.issues[0]?.message ?? ''}`);
}

function printJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value ?? { ok: true }, null, 2)}\n`);
}

const MARK: Record<Step['state'], string> = { done: '[x]', in_progress: '[>]', pending: '[ ]' };

function stepLine(step: Step): string {
  return `  ${MARK[step.state]} ${step.title}`;
}

/** 「[x] 标题」「[>] 标题」「[ ] 标题」或不标（算没做）；前面带 markdown 的「- 」也认。 */
export function parseStep(text: string): Step {
  const m = /^\s*(?:[-*]\s+)?\[([ xX>])\]\s*(.*)$/s.exec(text);
  if (!m) return { title: text.trim(), state: 'pending' };
  const state = m[1] === '>' ? 'in_progress' : m[1] === ' ' ? 'pending' : 'done';
  return { title: (m[2] ?? '').trim(), state };
}

function joined(positionals: string[], what: string): string {
  const text = positionals.join(' ').trim();
  if (!text) throw new CliError(EXIT.usage, `缺${what}。看 fleet --help`);
  return text;
}

const COMMANDS: Record<string, Handler> = {
  async task(args, { io, call }) {
    const { values, positionals } = parse(args);
    if (positionals.length) throw new CliError(EXIT.usage, 'task 不带参数');
    const task = expectShape(
      TaskResponse,
      await call({ method: 'GET', path: AgentRoutes.task.path }),
      '任务',
    );
    if (values.json) return printJson(io, task);
    const lines = [
      `任务 ${task.taskId}${task.subtaskId ? ` · 子任务 ${task.subtaskId}` : ''}`,
      `仓库：${task.repo} · 分支：${task.branch}`,
      ...(task.specDir ? [`需求文档：${task.specDir}`] : []),
      '',
      '需求：',
      ...task.request.split('\n').map((l) => `  ${l}`),
      '',
      '做完标准：',
      ...(task.acceptance.length ? task.acceptance.map((a, i) => `  ${i + 1}. ${a}`) : ['  （没写）']),
      '',
      '要改的地方：',
      ...(task.touches.length ? task.touches.map((t) => `  - ${t}`) : ['  （没写）']),
      '',
      '步骤：',
      ...(task.plan.length ? task.plan.map(stepLine) : ['  （还没列，用 fleet plan 列出来）']),
    ];
    io.stdout(`${lines.join('\n')}\n`);
  },

  async plan(args, { io, call }) {
    const { values, positionals } = parse(args);
    if (positionals.length === 0) {
      const task = expectShape(
        TaskResponse,
        await call({ method: 'GET', path: AgentRoutes.task.path }),
        '任务',
      );
      if (values.json) return printJson(io, { steps: task.plan });
      io.stdout(
        task.plan.length
          ? `${task.plan.map(stepLine).join('\n')}\n`
          : '还没列步骤。用法见 fleet plan --help\n',
      );
      return;
    }
    const body = check(PlanRequest, { steps: positionals.map(parseStep) });
    const res = await call({ method: 'POST', path: AgentRoutes.plan.path, body });
    if (values.json) return printJson(io, res);
    const done = body.steps.filter((s) => s.state === 'done').length;
    const doing = body.steps.find((s) => s.state === 'in_progress');
    io.stdout(`步骤已更新：${done}/${body.steps.length} 做完${doing ? ` · 正在：${doing.title}` : ''}\n`);
  },

  async say(args, { io, call }) {
    const { values, positionals } = parse(args);
    const body = check(SayRequest, { text: joined(positionals, '要说的话') });
    const res = await call({ method: 'POST', path: AgentRoutes.say.path, body });
    if (values.json) return printJson(io, res);
    io.stdout('已记录。\n');
  },

  async ask(args, { io, call }) {
    const { values, positionals } = parse(args, {
      option: { type: 'string', short: 'o', multiple: true },
      'no-wait': { type: 'boolean' },
    });
    const options = values.option;
    const blocking = !values['no-wait'];
    const body = check(AskRequest, {
      question: joined(positionals, '问题'),
      ...(options?.length ? { options } : {}),
      blocking,
    });
    const raw = await call({
      method: 'POST',
      path: AgentRoutes.ask.path,
      body,
      ...(blocking ? { timeoutMs: io.timing?.askMs ?? ASK_WAIT_MS, retryOnTimeout: false } : {}),
    });
    const res = expectShape(AskResponse, raw, '回答');
    if (values.json) return printJson(io, res);
    if (res.status === 'answered') {
      io.stdout(`回答：${res.answer ?? ''}\n`);
    } else if (blocking) {
      io.stdout(`还没人回答（问题编号 ${res.askId}）。先按你写明的假设继续，交活时在总结里注明。\n`);
    } else {
      io.stdout(`已发出（问题编号 ${res.askId}），不等回答。\n`);
    }
  },

  async history(args, { io, call }) {
    const { values, positionals } = parse(args, { limit: { type: 'string', short: 'n' } });
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    const body = check(HistoryRequest, {
      query: joined(positionals, '关键词'),
      ...(limit === undefined ? {} : { limit }),
    });
    const res = expectShape(
      HistoryResponse,
      await call({ method: 'POST', path: AgentRoutes.history.path, body }),
      '历史记录',
    );
    if (values.json) return printJson(io, res);
    if (res.items.length === 0) {
      io.stdout('没找到相关的历史需求。\n');
      return;
    }
    const lines = [`找到 ${res.items.length} 条：`];
    for (const item of res.items) {
      const meta = [item.specDir, item.mergedAt ? `合并于 ${item.mergedAt.slice(0, 10)}` : undefined].filter(
        Boolean,
      );
      lines.push(`- ${item.taskId} ${item.title}${meta.length ? ` · ${meta.join(' · ')}` : ''}`);
      if (item.resultSummary) lines.push(`  结果：${item.resultSummary}`);
    }
    io.stdout(`${lines.join('\n')}\n`);
  },

  // 会话只在本地提交，推分支、开 PR 由引擎在会话外做，所以这里不带 PR 编号
  async done(args, { io, call }) {
    const { values, positionals } = parse(args, { tests: { type: 'string' } });
    const tests = values.tests;
    if (tests !== 'passed' && tests !== 'failed') {
      throw new CliError(EXIT.usage, '要写明测试结果：--tests passed 或 --tests failed（如实写）');
    }
    const body = check(DoneRequest, {
      summary: joined(positionals, '交活总结'),
      testsPassed: tests === 'passed',
    });
    const res = await call({ method: 'POST', path: AgentRoutes.done.path, body });
    if (values.json) return printJson(io, res);
    // 后端核实过才回 2xx；核实不过回 4xx，在上面已经按拒收退出
    const message = (res as { message?: unknown } | undefined)?.message;
    io.stdout(`${typeof message === 'string' ? message : '已交活，后端核实通过。'}\n`);
  },

  async blocked(args, { io, call }) {
    const { values, positionals } = parse(args, { needs: { type: 'string' } });
    if (values.needs === undefined) {
      throw new CliError(EXIT.usage, '要写明需要什么：--needs human|info|access|other');
    }
    const body = check(BlockedRequest, { reason: joined(positionals, '卡住的原因'), needs: values.needs });
    const res = await call({ method: 'POST', path: AgentRoutes.blocked.path, body });
    if (values.json) return printJson(io, res);
    const needs = { human: '人拍板', info: '补信息', access: '权限或账号', other: '其他' }[body.needs];
    io.stdout(`已报卡住（需要：${needs}）。\n`);
  },
};
