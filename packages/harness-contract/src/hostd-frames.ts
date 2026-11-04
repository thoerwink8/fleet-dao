// 宿主帮手 hostd 的 stdio 帧协议（#3871，讨论稿 3.5 第④条、6.4a）：内核和 hostd 之间一行一帧的 JSON（NDJSON）。
// 本文件是唯一的定义：Rust 一侧（crates/hostd/src/frames.rs）照它写；frames/ 目录里的 JSON Schema 和样例帧由它导出
// （`node packages/harness-contract/src/bin/export-frames.ts`），两边各读同一份样例帧对拍，对不上当场红。
// 所有帧都是严格对象：多一个字段、少一个字段都拒（版本由握手管，不靠「忽略不认识的字段」）。
// 加字段、改含义、删字段都升 HOSTD_PROTOCOL_VERSION；hostd 只认和自己相同的版本，不一样就拒用。
import { z } from 'zod';

/** 现在的协议版本。握手时内核报自己的版本，hostd 不等于这个值就回 version_mismatch 并退出。 */
export const HOSTD_PROTOCOL_VERSION = 1;

const ReqId = z.number().int().nonnegative();
const RunId = z.string().min(1).max(200);
const Count = z.number().int().nonnegative();
/** 输出流。`pty` 给终端面板（#3857）留的位：这一版 hostd 不产生，也不接 pty.* 请求（回 unsupported）。 */
const OutStream = z.enum(['stdout', 'stderr', 'pty']);
const ReadStream = z.enum(['stdout', 'stderr']);

/** 执行体怎么结束的：code 是退出码；被信号杀死时 code 为 null、signal 写信号名；hostd 看不到结局（看守进程先没了）时 signal 是 'lost'。 */
export const HostdExit = z.strictObject({
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
});
export type HostdExit = z.infer<typeof HostdExit>;

const req = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), id: ReqId, ...shape });

// —— 内核 → hostd ——

/** 握手：必须是连上后的第一帧。 */
export const HelloReq = req('hello', { protocol: Count, client: z.string().max(200) });
/** 起：脱离会话跑，输出写文件。env 是整份环境（hostd 不继承自己的）。 */
export const SpawnReq = req('spawn', {
  runId: RunId,
  command: z.array(z.string()).min(1),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
});
/**
 * 接回：从 after 之后的那一行开始推（after 是已经收下的行数，0 = 从头）；推完当前内容后继续跟，
 * 执行体退了并且两路都推完以后发一帧 exit，这个跟随就结束。同一个 runId 在一条连接上只能接一次。
 */
export const AttachReq = req('attach', {
  runId: RunId,
  after: z.strictObject({ stdout: Count, stderr: Count }),
});
/** 按行拉（不跟随）：从 after 之后最多 max 行。 */
export const ReadReq = req('read', {
  runId: RunId,
  stream: ReadStream,
  after: Count,
  max: z.number().int().positive(),
});
/** 写执行体的 stdin；end 为 true 时写完关掉。只有起它的那条连接能写，连接断了 stdin 就关了。 */
export const StdinReq = req('stdin', { runId: RunId, data: z.string(), end: z.boolean() });
export const StopReq = req('stop', { runId: RunId, mode: z.enum(['term', 'kill']) });
/** 收尸：执行体退了以后收掉会话里剩下的，等最多 graceMs。 */
export const ReapReq = req('reap', { runId: RunId, graceMs: Count });
export const StatusReq = req('status', { runId: RunId });
/** 删掉这个 runId 的输出文件和记录（只在执行体已经结束时；还活着回 run_alive）。 */
export const ForgetReq = req('forget', { runId: RunId });

// 终端（#3857）：这一版只占位，hostd 一律回 unsupported；形状先定下来，那一片做的时候不用改握手。
export const PtyOpenReq = req('pty.open', { runId: RunId, cols: Count, rows: Count });
/** data 是 base64（终端输入是字节，不是文本）。 */
export const PtyInputReq = req('pty.input', { runId: RunId, data: z.string() });
export const PtyResizeReq = req('pty.resize', { runId: RunId, cols: Count, rows: Count });
export const PtyCloseReq = req('pty.close', { runId: RunId });

// —— hostd → 内核 ——

export const WelcomeRes = z.strictObject({
  type: z.literal('welcome'),
  id: ReqId,
  protocol: Count,
  hostd: z.string(),
  os: z.string(),
  arch: z.string(),
  /** 这个 hostd 会做的事；没有 'pty' 就是不支持终端。 */
  capabilities: z.array(z.string()),
});
export const SpawnedRes = z.strictObject({ type: z.literal('spawned'), id: ReqId, runId: RunId, pid: Count });
export const AttachedRes = z.strictObject({
  type: z.literal('attached'),
  id: ReqId,
  runId: RunId,
  /** 看守进程还在吗；查不了是 null。 */
  alive: z.boolean().nullable(),
  exit: HostdExit.nullable(),
});
export const LinesRes = z.strictObject({
  type: z.literal('lines'),
  id: ReqId,
  runId: RunId,
  stream: ReadStream,
  /** 第一行的行号是 after + 1。 */
  after: Count,
  lines: z.array(z.string()),
  /** 执行体已经结束并且这一路读到头了。 */
  eof: z.boolean(),
});
export const StateRes = z.strictObject({
  type: z.literal('state'),
  id: ReqId,
  runId: RunId,
  /** 有没有这个 runId 的记录。 */
  known: z.boolean(),
  alive: z.boolean().nullable(),
  pid: Count.nullable(),
  exit: HostdExit.nullable(),
});
export const OkRes = z.strictObject({ type: z.literal('ok'), id: ReqId });
export const ReapedRes = z.strictObject({
  type: z.literal('reaped'),
  id: ReqId,
  runId: RunId,
  found: Count,
  /** 收完还剩几个；null = 没查成（不当成收干净了）。 */
  leftovers: Count.nullable(),
});
export const ErrorRes = z.strictObject({
  type: z.literal('error'),
  /** 对应的请求；请求本身都读不出来时是 null。 */
  id: ReqId.nullable(),
  code: z.string(),
  message: z.string(),
});

// —— hostd → 内核，不对应请求的推送 ——

/** 一行输出。line 从 1 起，每一路（stdout、stderr）各数各的；内核收下一行就记下 (runId, stream, line)，重连从那里接。 */
export const OutEvent = z.strictObject({
  type: z.literal('out'),
  runId: RunId,
  stream: OutStream,
  line: z.number().int().positive(),
  text: z.string(),
});
export const ExitEvent = z.strictObject({
  type: z.literal('exit'),
  runId: RunId,
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
});

export const HostdFrame = z.discriminatedUnion('type', [
  HelloReq,
  SpawnReq,
  AttachReq,
  ReadReq,
  StdinReq,
  StopReq,
  ReapReq,
  StatusReq,
  ForgetReq,
  PtyOpenReq,
  PtyInputReq,
  PtyResizeReq,
  PtyCloseReq,
  WelcomeRes,
  SpawnedRes,
  AttachedRes,
  LinesRes,
  StateRes,
  OkRes,
  ReapedRes,
  ErrorRes,
  OutEvent,
  ExitEvent,
]);
export type HostdFrame = z.infer<typeof HostdFrame>;

/** 认一行外来的帧：不是 JSON、版本之外的形状不对都拒，原因写明。 */
export function parseHostdFrame(line: string): { ok: true; frame: HostdFrame } | { ok: false; why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, why: '不是 JSON' };
  }
  const r = HostdFrame.safeParse(raw);
  return r.success
    ? { ok: true, frame: r.data }
    : { ok: false, why: r.error.issues.map((i) => i.message).join('；') };
}

/** 样例帧：每种帧至少一条，导出到 frames/samples/，Rust 和 TS 两边读同一份对拍。键就是文件名。 */
export const HOSTD_FRAME_SAMPLES: Record<string, HostdFrame> = {
  'hello-req': { type: 'hello', id: 1, protocol: HOSTD_PROTOCOL_VERSION, client: 'fleet-kernel/0.0.0' },
  'spawn-req': {
    type: 'spawn',
    id: 2,
    runId: 'issue-3871-a1',
    command: ['/usr/bin/node', 'worker.mjs', '--flag'],
    cwd: '/work/tree',
    env: { PATH: '/usr/bin', FLEET_RUN_ID: 'issue-3871-a1' },
  },
  'attach-req': { type: 'attach', id: 3, runId: 'issue-3871-a1', after: { stdout: 17, stderr: 0 } },
  'read-req': { type: 'read', id: 4, runId: 'issue-3871-a1', stream: 'stdout', after: 17, max: 500 },
  'stdin-req': { type: 'stdin', id: 5, runId: 'issue-3871-a1', data: '派的活\n', end: true },
  'stop-req': { type: 'stop', id: 6, runId: 'issue-3871-a1', mode: 'term' },
  'reap-req': { type: 'reap', id: 7, runId: 'issue-3871-a1', graceMs: 500 },
  'status-req': { type: 'status', id: 8, runId: 'issue-3871-a1' },
  'forget-req': { type: 'forget', id: 9, runId: 'issue-3871-a1' },
  'pty-open-req': { type: 'pty.open', id: 10, runId: 'term-1', cols: 120, rows: 30 },
  'pty-input-req': { type: 'pty.input', id: 11, runId: 'term-1', data: 'bHMK' },
  'pty-resize-req': { type: 'pty.resize', id: 12, runId: 'term-1', cols: 80, rows: 24 },
  'pty-close-req': { type: 'pty.close', id: 13, runId: 'term-1' },
  'welcome-res': {
    type: 'welcome',
    id: 1,
    protocol: HOSTD_PROTOCOL_VERSION,
    hostd: '0.1.0',
    os: 'linux',
    arch: 'x86_64',
    capabilities: ['spawn', 'attach', 'read', 'stdin', 'stop', 'reap', 'status', 'forget'],
  },
  'spawned-res': { type: 'spawned', id: 2, runId: 'issue-3871-a1', pid: 4242 },
  'attached-res': { type: 'attached', id: 3, runId: 'issue-3871-a1', alive: true, exit: null },
  'attached-exited-res': {
    type: 'attached',
    id: 3,
    runId: 'issue-3871-a1',
    alive: false,
    exit: { code: 0, signal: null },
  },
  'lines-res': {
    type: 'lines',
    id: 4,
    runId: 'issue-3871-a1',
    stream: 'stdout',
    after: 17,
    lines: ['{"type":"assistant"}', '第二行'],
    eof: false,
  },
  'state-res': {
    type: 'state',
    id: 8,
    runId: 'issue-3871-a1',
    known: true,
    alive: null,
    pid: 4242,
    exit: { code: null, signal: 'SIGKILL' },
  },
  'ok-res': { type: 'ok', id: 5 },
  'reaped-res': { type: 'reaped', id: 7, runId: 'issue-3871-a1', found: 2, leftovers: 0 },
  'reaped-unknown-res': { type: 'reaped', id: 7, runId: 'issue-3871-a1', found: 0, leftovers: null },
  'error-res': { type: 'error', id: 2, code: 'run_exists', message: 'run issue-3871-a1 already exists' },
  'error-unreadable-res': { type: 'error', id: null, code: 'bad_frame', message: 'not valid JSON' },
  'out-event': { type: 'out', runId: 'issue-3871-a1', stream: 'stdout', line: 18, text: '一行输出' },
  'exit-event': { type: 'exit', runId: 'issue-3871-a1', code: 0, signal: null },
};

/** 必须被两边都拒的帧：键是文件名，值是原始文本（不一定是合法 JSON 对象）。 */
export const HOSTD_INVALID_SAMPLES: Record<string, string> = {
  'not-json': 'this is not json',
  'unknown-type': '{"type":"teleport","id":1}',
  'missing-field': '{"type":"spawn","id":1,"runId":"r","cwd":"/","env":{}}',
  'extra-field': '{"type":"ok","id":1,"surprise":true}',
  'bad-enum': '{"type":"stop","id":1,"runId":"r","mode":"nuke"}',
  'negative-line': '{"type":"out","runId":"r","stream":"stdout","line":0,"text":""}',
  'empty-command': '{"type":"spawn","id":1,"runId":"r","command":[],"cwd":"/","env":{}}',
  'read-pty-stream': '{"type":"read","id":1,"runId":"r","stream":"pty","after":0,"max":10}',
};
