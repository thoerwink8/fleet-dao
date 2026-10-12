// 默认模型和思考档位只许写在 packages/db/routing.default.json（#1958）。
// 这里两件事：路由里的型号不许写命令行别名；effort.ts、worker-lib.mjs 不许再各写一份默认档位或默认型号。
// 认出来就报，不改文件。故意造出的失败用例在 routing-seed-single.test.ts。

/** 命令行别名。路由里要写目录上的完整型号（sonnet-5.5、claude-sonnet-5-5），不写这些。cursor 的上游串 auto 不在这里。 */
export const BARE_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'inherit', 'fable', 'grok'] as const;

/** 这些型号是别名。空数组 = 没有。同一个别名只报一次。 */
export function bareAliasProblems(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!(BARE_MODEL_ALIASES as readonly string[]).includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(`型号 ${id} 是别名，路由里要写完整型号`);
  }
  return out;
}

/**
 * 默认档位、默认型号又在代码里写死了一份。命中的每条说清是哪个文件、哪一种。
 * 默认值只从 routing.default.json 的 defaults 读。SESSION_EFFORTS 这种「认哪几档」的名单不算默认值，不在这里。
 */
const SEED_LITERALS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: 'DEFAULT_SESSION_EFFORT',
    pattern: /DEFAULT_SESSION_EFFORT\s*(?::\s*SessionEffort)?\s*=\s*['"](?:low|medium|high|xhigh|max)['"]/,
  },
  {
    name: 'DEFAULT_EFFORT',
    pattern: /(?<![A-Z_])DEFAULT_EFFORT\s*=\s*['"](?:low|medium|high|xhigh|max)['"]/,
  },
  { name: 'ROUTING_MODEL_OF', pattern: /ROUTING_MODEL_OF\s*=\s*\{/ },
  { name: 'CLAUDE_DEFAULT_MODEL', pattern: /CLAUDE_DEFAULT_MODEL\s*=\s*['"][^'"]+['"]/ },
];

export function seedLiteralProblems(files: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    for (const rule of SEED_LITERALS) {
      if (rule.pattern.test(file.text)) {
        out.push(`${file.path} 又写了一份默认值（${rule.name}）：默认模型和档位只在 routing.default.json`);
      }
    }
  }
  return out;
}
