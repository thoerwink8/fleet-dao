// 外部看门狗一轮的判法（#292 第 1 片）。纯函数：不读时钟、不发请求。
// 香港只看公网驾驶舱首页回不回得来（nginx 活着）：任何 HTTP 状态码都算回得来，连不上才算挂。
// 法国看公网 /healthz：200 活着；503 是后端自己答的「有一项不好」（health.ts 整体不 ok 就回 503），也算活着，
// 交给健康页和引擎自己报。连不上、502、504 是隧道或后端不在。别的状态码拿不准，按挂报，不当成没挂。
// 法国的公网地址经过香港。香港这一轮连不上时，法国的探测结果说明不了法国，只报香港。
// 同一次挂着（同一台、同一次 downSince）每小时最多再推一次。恢复要写挂了多久。
// 上一轮状态读失败（unreadable）和存储里本来没有（none）不是一回事：读失败照挂处理并且一定推，不许静默。

const HOUR_MS = 60 * 60 * 1000;

const BEIJING = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface MachineState {
  status: 'up' | 'down' | 'unknown';
  /** status 为 down 时，这次挂从什么时候开始（epoch ms）。 */
  downSince: number | null;
  /** 连着几次探测判挂。不是 down 时为 0。 */
  consecutiveFailures: number;
  /** 最近一次因为这台挂着而推过的时刻。没推过是 null。 */
  lastPushedAt: number | null;
}

export interface WatchSnapshot {
  hk: MachineState;
  fr: MachineState;
}

/** 连不上是 'unreachable'；回得来是 HTTP 状态码。 */
export type ProbeStatus = number | 'unreachable';

export type Previous = { kind: 'known'; snapshot: WatchSnapshot } | { kind: 'none' } | { kind: 'unreadable' };

export interface JudgeInput {
  now: number;
  hk: ProbeStatus;
  fr: ProbeStatus;
  previous: Previous;
}

export interface JudgeResult {
  /** 这一轮要不要推。读不到上一轮时一定是 true。 */
  push: boolean;
  /** 推送正文。不推时是空串。 */
  text: string;
  /** 这一轮之后要存的状态。读失败时按这次见到的写，不把没读到写成一直好好的。 */
  next: WatchSnapshot;
}

function upState(): MachineState {
  return { status: 'up', downSince: null, consecutiveFailures: 0, lastPushedAt: null };
}

function unknownState(): MachineState {
  return { status: 'unknown', downSince: null, consecutiveFailures: 0, lastPushedAt: null };
}

function blank(): WatchSnapshot {
  return { hk: unknownState(), fr: unknownState() };
}

function isHttpStatus(status: ProbeStatus): status is number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;
}

/** 首页回了任何 HTTP 状态码都算香港活着。 */
function isHongKongUp(status: ProbeStatus): boolean {
  return isHttpStatus(status);
}

/** 只有 200 和 503 算法国活着。 */
function isFranceUp(status: ProbeStatus): boolean {
  return status === 200 || status === 503;
}

function formatBeijing(ms: number): string {
  return BEIJING.format(new Date(ms));
}

function formatHungFor(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '读不到';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} 分钟`;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}

function stepMachine(
  name: '香港' | '法国',
  up: boolean,
  prev: MachineState,
  now: number,
  lines: string[],
): MachineState {
  if (up) {
    if (prev.status === 'down') {
      const dur = prev.downSince === null ? '读不到' : formatHungFor(now - prev.downSince);
      lines.push(`${name}恢复了，挂了多久：${dur}`);
    }
    return upState();
  }
  const continuing = prev.status === 'down';
  const since = continuing && prev.downSince !== null ? prev.downSince : now;
  const failures = continuing ? prev.consecutiveFailures + 1 : 1;
  const last = continuing ? prev.lastPushedAt : null;
  const due = last === null || now - last >= HOUR_MS;
  if (due) {
    const verb = continuing && last !== null ? '仍挂着' : '挂了';
    lines.push(`${name}${verb}：从 ${formatBeijing(since)} 起，连着 ${failures} 次没通`);
  }
  return {
    status: 'down',
    downSince: since,
    consecutiveFailures: failures,
    lastPushedAt: due ? now : last,
  };
}

function judgeKnown(input: JudgeInput, prev: WatchSnapshot): JudgeResult {
  const lines: string[] = [];
  const hkUp = isHongKongUp(input.hk);
  const hk = stepMachine('香港', hkUp, prev.hk, input.now, lines);
  // 香港连不上时法国的结果是从同一条路上看到的，不更新、不写进推送。
  const fr = hkUp ? stepMachine('法国', isFranceUp(input.fr), prev.fr, input.now, lines) : prev.fr;
  const text = lines.join('\n');
  return { push: text !== '', text, next: { hk, fr } };
}

function judgeUnreadable(input: JudgeInput): JudgeResult {
  const base = judgeKnown(input, blank());
  const prefix = '读不到上一轮状态，照挂处理，不静默。';
  if (!isHongKongUp(input.hk)) {
    const body = base.text === '' ? '香港挂了' : base.text;
    return { push: true, text: `${prefix}${body}。法国不连带报。`, next: base.next };
  }
  if (base.text !== '') return { push: true, text: `${prefix}${base.text}`, next: base.next };
  return {
    push: true,
    text: `${prefix}香港回了 ${input.hk}。法国回了 ${input.fr}。`,
    next: base.next,
  };
}

export function judgeRound(input: JudgeInput): JudgeResult {
  if (input.previous.kind === 'unreadable') return judgeUnreadable(input);
  const prev = input.previous.kind === 'known' ? input.previous.snapshot : blank();
  return judgeKnown(input, prev);
}
