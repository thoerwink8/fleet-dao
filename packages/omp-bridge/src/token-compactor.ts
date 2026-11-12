// 省 Token 三板斧（Token Compactor）：
// 1. 工具大输出智能折叠（foldToolOutput）：跑测试/构建全绿时压成 1 行摘要，失败时只摘报错栈与前后文，省 70%+ 上下文；
// 2. 跨轮次历史工具结果无损脱水（dehydrateHistoryTurns）：3 轮以前的長文件读取自动替成行号引用胶囊；
// 3. 节省的 Token 账本统计（供驾驶舱实时显示省了多少 Token）。

export interface FoldResult {
  foldedText: string;
  originalChars: number;
  foldedChars: number;
  savedTokensEstimate: number;
  wasFolded: boolean;
}

/**
 * 智能折叠 bash / test / build 等大输出：
 * - 如果退出码为 0 且输出超过 600 字符：识别 vitest / tsc / biome / cargo 汇总行，浓缩为 1~3 行；
 * - 如果退出码非 0 且输出超过 2000 字符：只保留包含 FAIL / Error / error TS / ✕ 的关键报错段落及末尾 25 行。
 */
export function foldToolOutput(toolName: string, rawOutput: string, exitCode = 0): FoldResult {
  const originalChars = rawOutput.length;
  const estimateSaved = (after: number) => Math.max(0, Math.round((originalChars - after) / 3.8));

  if (originalChars <= 600) {
    return {
      foldedText: rawOutput,
      originalChars,
      foldedChars: originalChars,
      savedTokensEstimate: 0,
      wasFolded: false,
    };
  }

  const lines = rawOutput.split(/\r?\n/);

  if (
    exitCode === 0 &&
    (toolName === 'bash' || toolName === 'test' || toolName === 'edit' || toolName === 'write')
  ) {
    const summaryLines = lines.filter((l) =>
      /(Test Files|Tests\s+\d+ passed|Checked \d+ files|Finished .* target|✓ .* passed|Done in )/i.test(l),
    );
    const body =
      summaryLines.length > 0
        ? `[输出已折叠 · 退出码 0（原长 ${lines.length} 行 / ${originalChars} 字）]\n${summaryLines.slice(-4).join('\n')}`
        : `[输出已折叠 · 退出码 0（原长 ${lines.length} 行）]\n${lines.slice(-5).join('\n')}`;
    return {
      foldedText: body,
      originalChars,
      foldedChars: body.length,
      savedTokensEstimate: estimateSaved(body.length),
      wasFolded: true,
    };
  }

  if (originalChars > 2000) {
    const errorHits: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? '';
      if (/(FAIL|Error:|AssertionError|error TS\d+|error\[E\d+\]|× |✕ )/.test(l)) {
        const chunk = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 10)).join('\n');
        errorHits.push(chunk);
        i += 9;
        if (errorHits.length >= 6) break;
      }
    }
    const tail = lines.slice(-20).join('\n');
    const body = [
      `[长输出已摘录核心错误 · 退出码 ${exitCode}（原长 ${lines.length} 行 / ${originalChars} 字）]`,
      ...(errorHits.length > 0 ? ['--- 关键报错段落 ---', ...errorHits] : []),
      '--- 输出末尾 ---',
      tail,
    ].join('\n');
    return {
      foldedText: body,
      originalChars,
      foldedChars: body.length,
      savedTokensEstimate: estimateSaved(body.length),
      wasFolded: true,
    };
  }

  return {
    foldedText: rawOutput,
    originalChars,
    foldedChars: originalChars,
    savedTokensEstimate: 0,
    wasFolded: false,
  };
}

export interface HistoryTurnMessage {
  turnIndex: number;
  role: 'user' | 'assistant' | 'toolResult';
  toolName?: string;
  targetFile?: string;
  content: string;
}

/**
 * 跨轮次无损脱水：距离当前轮次超过 keepRecentTurns（默认 3 轮）的大段 read 工具原文，
 * 压成一行胶囊 `[历史已读快照: <file> (共 N 字)，如需最新内容请重新按行号读取]`。
 */
export function dehydrateHistoryTurns(
  messages: readonly HistoryTurnMessage[],
  currentTurn: number,
  keepRecentTurns = 3,
): { messages: HistoryTurnMessage[]; savedTokens: number } {
  let savedTokens = 0;
  const out = messages.map((m) => {
    if (
      m.role === 'toolResult' &&
      m.toolName === 'read' &&
      currentTurn - m.turnIndex > keepRecentTurns &&
      m.content.length > 500
    ) {
      const stub = `[历史已读脱水快照: ${m.targetFile ?? '文件'}（原长 ${m.content.length} 字，已在第 ${m.turnIndex} 轮分析过）]`;
      savedTokens += Math.max(0, Math.round((m.content.length - stub.length) / 3.8));
      return { ...m, content: stub };
    }
    return m;
  });
  return { messages: out, savedTokens };
}
