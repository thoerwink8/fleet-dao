// Mirasim 名册：先握手再按执行体逐个问 getModelRoster。服务端单线程，一个堵住就等到它自己的时限。
// 任何一个执行体没读成，整渠失败、不交读到一半的名单：半份名单会被差集说成「这些模型渠道已经不认了」。
import { errMessage } from '@fleet-dao/shared/util';
import type { MirasimFrame, MirasimWire } from '../mirasim/wire.ts';
import { type QuotaErrorCode, QuotaReadError } from '../quota/types.ts';
import { isRecord, redact } from '../quota/util.ts';
import { type RosterParse, uniqueModels } from './parse.ts';

const TOTAL_MS = 120_000;
const PER_AGENT_MS = 20_000;

export async function modelsFromMirasimWire(
  connect: () => Promise<MirasimWire>,
  opts: { timeoutMs?: number; perAgentMs?: number } = {},
): Promise<RosterParse> {
  const deadline = Date.now() + (opts.timeoutMs ?? TOTAL_MS);
  const perAgent = opts.perAgentMs ?? PER_AGENT_MS;
  let wire: MirasimWire | undefined;
  try {
    wire = await connectWithin(connect, deadline);
    wire.send({ type: 'clientHello' });
    wire.send({ type: 'getState' });
    const stateFrame = await waitFor(wire, (frame) => frame.type === 'state', deadline);
    if (stateFrame.kind === 'timeout') return fail('timeout', '连上了但没在时限内收到 state 帧');
    if (stateFrame.kind === 'closed') return fail('unreachable', '连上之后连接断了');
    if (stateFrame.kind === 'error') return fail('upstream', redact(stateFrame.message));
    const state = isRecord(stateFrame.frame.state) ? stateFrame.frame.state : undefined;
    if (!state || !Array.isArray(state.agentsAvailable)) {
      const keys = state ? Object.keys(state).join('、') || '没有字段' : '没有 state';
      return fail('bad_response', `state 帧里没有 agentsAvailable（有：${keys}）`);
    }
    const agents: string[] = [];
    for (const agent of state.agentsAvailable) {
      if (typeof agent !== 'string' || !agent.trim()) {
        return fail('bad_response', 'state.agentsAvailable 里有空的或不是字符串的执行体');
      }
      agents.push(agent.trim());
    }
    if (agents.length === 0) return fail('bad_response', 'state.agentsAvailable 是空的，列不到模型');
    const ids: string[] = [];
    for (const agent of agents) {
      if (Date.now() >= deadline) return fail('timeout', '读模型名册超过总时限，不拿读到一半的名单');
      const agentDeadline = Math.min(deadline, Date.now() + perAgent);
      wire.send({ type: 'getModelRoster', agent });
      const frame = await waitFor(
        wire,
        (item) => item.type === 'modelRoster' && item.agent === agent,
        agentDeadline,
      );
      if (frame.kind === 'timeout')
        return fail('timeout', `执行体 ${agent} 的模型名册超时，不拿读到一半的名单`);
      if (frame.kind === 'closed') return fail('unreachable', `读 ${agent} 的名册时连接断了`);
      if (frame.kind === 'error') return fail('upstream', `${agent}：${redact(frame.message)}`);
      const parsed = idsFromRoster(agent, frame.frame.entries);
      if (!parsed.ok) return parsed;
      ids.push(...parsed.models);
    }
    const models = uniqueModels(ids);
    if (models.length === 0) return fail('bad_response', '每个执行体的名册都是空的，不当成一个模型都没有');
    return { ok: true, models };
  } catch (err) {
    return connectFailure(err);
  } finally {
    wire?.close();
  }
}

function idsFromRoster(agent: string, entries: unknown): RosterParse {
  if (!Array.isArray(entries)) return fail('bad_response', `${agent} 的 modelRoster 没有 entries 数组`);
  const models: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    const id = entry.id.trim();
    if (id) models.push(id);
  }
  if (entries.length > 0 && models.length === 0) {
    return fail('bad_response', `${agent} 的名册有条目但没有模型 id`);
  }
  return { ok: true, models };
}

async function connectWithin(connect: () => Promise<MirasimWire>, deadline: number): Promise<MirasimWire> {
  const left = deadline - Date.now();
  if (left <= 0) throw new QuotaReadError('timeout', '读模型名册超过总时限');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      connect(),
      new Promise<MirasimWire>((_resolve, reject) => {
        timer = setTimeout(() => reject(new QuotaReadError('timeout', '连 Mirasim 超时')), left);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Waited =
  | { kind: 'frame'; frame: MirasimFrame }
  | { kind: 'timeout' }
  | { kind: 'closed' }
  | { kind: 'error'; message: string };

async function waitFor(
  wire: MirasimWire,
  pred: (frame: MirasimFrame) => boolean,
  deadline: number,
): Promise<Waited> {
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { kind: 'timeout' };
    const frame = await wire.next(left);
    if (frame === 'timeout') return { kind: 'timeout' };
    if (frame === 'closed') return { kind: 'closed' };
    if (frame.type === 'error') {
      const message =
        typeof frame.message === 'string'
          ? frame.message
          : typeof frame.error === 'string'
            ? frame.error
            : 'Mirasim 回了错误帧';
      return { kind: 'error', message };
    }
    if (pred(frame)) return { kind: 'frame', frame };
  }
}

function fail(code: QuotaErrorCode, message: string): RosterParse {
  return { ok: false, code, message };
}

function connectFailure(err: unknown): RosterParse {
  if (err instanceof QuotaReadError) return { ok: false, code: err.code, message: err.message };
  const message = errMessage(err);
  if (/令牌|ENOENT|EACCES|no such file|没有这个/i.test(message)) {
    return { ok: false, code: 'no_credentials', message: redact(message) };
  }
  if (/timeout|超时/i.test(message)) return { ok: false, code: 'timeout', message: redact(message) };
  return { ok: false, code: 'unreachable', message: redact(message) || '连不上 Mirasim' };
}
