// Mirasim 模型串该起哪个执行体（#1357）。
// 名册帧上的 agent 优先（docs/reference/quota.md：帧是 {type:'modelRoster', agent, entries}，执行体在帧上，不在条目里）。
// 帧上没有、或库里还没记下，就按上游串前缀。对不上的标「执行体未知」，调用方不派，也不落到某个默认执行体。

export const MIRASIM_EXECUTOR_UNKNOWN = '执行体未知';

const PREFIXES: readonly { prefix: string; agent: string }[] = [
  { prefix: 'claude-', agent: 'claude' },
  { prefix: 'gpt-', agent: 'codex' },
  { prefix: 'grok-', agent: 'grok' },
  { prefix: 'kimi-', agent: 'kimi' },
  { prefix: 'deepseek-', agent: 'dsh' },
];

export type MirasimExecutorResolution = { ok: true; agent: string } | { ok: false; reason: string };

/** 认不出时的那一句。选路的挡因、起会话前的报错都用这一句，好让探针和驾驶舱对得上。 */
export function mirasimExecutorUnknownReason(upstreamModel: string): string {
  return `执行体未知：Mirasim 认不出这个模型该起哪个执行体：${upstreamModel}（前缀对不上 claude-、gpt-、grok-、kimi-、deepseek-），不派，也不落到默认执行体`;
}

/**
 * 一个函数判完：名册上的执行体（非空、且不是「执行体未知」）优先，否则按上游串前缀。
 * 前缀区分大小写，只去首尾空白。空串、对不上的前缀都是认不出，不返回 claude。
 */
export function resolveMirasimExecutor(input: {
  rosterExecutor?: string | null | undefined;
  upstreamModel: string;
}): MirasimExecutorResolution {
  const fromRoster = input.rosterExecutor?.trim() ?? '';
  if (fromRoster && fromRoster !== MIRASIM_EXECUTOR_UNKNOWN) {
    return { ok: true, agent: fromRoster };
  }
  const key = input.upstreamModel.trim();
  for (const row of PREFIXES) {
    if (key.startsWith(row.prefix)) return { ok: true, agent: row.agent };
  }
  return { ok: false, reason: mirasimExecutorUnknownReason(key) };
}
