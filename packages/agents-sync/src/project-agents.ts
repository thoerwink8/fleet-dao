// 项目级子代理定义只从 agents/subagents/ 来（#1958）。.claude/agents/fleet-*.md 是这一份的原样副本。
// haiku55 不进项目级：那里的会被引擎当成本仓子代理传给 --agents。

/** 两处对不上的地方。空数组 = 逐字一样。committed 没有就是项目级缺了这份。 */
export function projectAgentDrift(
  pairs: readonly { file: string; source: string; committed: string | undefined }[],
): string[] {
  const out: string[] = [];
  for (const pair of pairs) {
    if (!pair.file.startsWith('fleet-') || !pair.file.endsWith('.md')) continue;
    if (pair.committed === undefined) {
      out.push(`${pair.file}：.claude/agents/ 里没有，该由 agents/subagents/ 原样生成`);
      continue;
    }
    if (pair.committed !== pair.source) {
      out.push(`${pair.file}：.claude/agents/ 和 agents/subagents/ 不一致`);
    }
  }
  return out;
}
