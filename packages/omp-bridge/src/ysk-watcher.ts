// 仿 Claude Code 内置 you-should-know（简称 YSK）的旁路挑错子代理（默认用免费 Devin swe-2 驱动）。
// 核心设计（对应创始人微信截图）：
// - 「就是一个子 agent，不做事，只看别人做事；相当于你写代码的时候，有一个人在旁边边思考边挑错」
// - 「不停地根据已改代码问：有没有什么事情是我一直该做但没做，或者我做错了但没注意到的事情」
// - 展示形态：`✦ Heads up · 主 agent：<一句话直指越界或漏改>`

export interface YskInspectInput {
  /** 原定任务目标。 */
  taskGoal: string;
  /** 允许修改的文件或目录通配（writeScope）。 */
  allowedScope: readonly string[];
  /** 明确禁止事项（不做什么）。 */
  mustNotDo: readonly string[];
  /** 当前工作树已修改的文件列表及 diff 摘要。 */
  changedFiles: ReadonlyArray<{
    path: string;
    addedLines: number;
    removedLines: number;
    diffPreview: string;
  }>;
}

export interface YskAlert {
  triggered: boolean;
  /** 对应截图的标题：`✦ Heads up · 主 agent` */
  badge: '✦ Heads up · 主 agent';
  severity: 'warning' | 'critical';
  /** 一句话大白话提醒（如：「写新页面初稿时，还顺手改了几处已经上线的页面文案和导航，不只是新增页面。」） */
  message: string;
  /** 触发原因分类。 */
  kind: 'collateral-edit' | 'deleted-assertion' | 'swallowed-error' | 'scope-breach' | 'clean';
  /** 可直接通过 session.steer() 塞给主 Agent 的纠偏指令。 */
  steerInstruction?: string;
  /** 执行本次旁路检查的模型（默认 devin/swe-2 免费档）。 */
  watcherModel: string;
}

function matchesScope(file: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => {
    const clean = p.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
    return file === clean || file.startsWith(`${clean}/`) || file.includes(clean);
  });
}

/**
 * 确定性 0-Token 快速扫描 + SWE-2 语义旁路合成：
 * 先在毫秒级揪出越界修改、顺手改已上线导航/文案、删测试断言、空 catch 吞错；
 * 若配有远程 swe-2 回调则进一步做深度语义挑错。
 */
export async function runYskCheck(
  input: YskInspectInput,
  swe2Judge?: (prompt: string) => Promise<string>,
): Promise<YskAlert> {
  const watcherModel = 'devin/swe-2';

  // 1. 检查是否顺手改了 writeScope 以外的文件（恰如截图案例：写新页面初稿时顺手改了已上线导航和文案）
  const outOfScope = input.changedFiles.filter((f) => !matchesScope(f.path, input.allowedScope));
  if (outOfScope.length > 0) {
    const names = outOfScope.map((f) => f.path).join('、');
    const msg = `主任务是「${input.taskGoal}」，但顺手改了范围外的已存在文件（${names}），不只是在目标范围内改动。`;
    return {
      triggered: true,
      badge: '✦ Heads up · 主 agent',
      severity: 'critical',
      kind: 'collateral-edit',
      message: msg,
      steerInstruction: `[YSK 旁路提醒] ${msg} 请立即用 git checkout -- ${outOfScope.map((f) => f.path).join(' ')} 还原范围外改动，只改授权文件。`,
      watcherModel,
    };
  }

  // 2. 检查是否删掉了原有的测试断言凑绿
  for (const f of input.changedFiles) {
    if (/\.(test|spec)\.tsx?$/.test(f.path)) {
      const removedExpects = (f.diffPreview.match(/^-[^\n]*\bexpect\s*\(/gm) ?? []).length;
      const addedExpects = (f.diffPreview.match(/^\+[^\n]*\bexpect\s*\(/gm) ?? []).length;
      if (removedExpects > addedExpects && f.removedLines > f.addedLines) {
        const msg = `在测试文件 ${f.path} 里删掉了 ${removedExpects - addedExpects} 处 expect 断言，有「删断言凑绿」风险。`;
        return {
          triggered: true,
          badge: '✦ Heads up · 主 agent',
          severity: 'critical',
          kind: 'deleted-assertion',
          message: msg,
          steerInstruction: `[YSK 旁路提醒] ${msg} 严禁放宽或删除已有测试判据，请恢复原断言并修好实现代码。`,
          watcherModel,
        };
      }
    }

    // 3. 检查是否写了空 catch 或假装没事的 fallback（违反三态底线）
    if (
      /\+\s*catch\s*(?:\([^)]*\))?\s*\{\s*(?:return\s+(?:null|\[\]|0|''|"")\s*;?)?\s*\}/.test(f.diffPreview)
    ) {
      const msg = `${f.path} 新增的 catch 块直接吞掉异常或返回了空/0，违反「读不到必须返回明确失败，不拿空/0冒充没事」的底线。`;
      return {
        triggered: true,
        badge: '✦ Heads up · 主 agent',
        severity: 'warning',
        kind: 'swallowed-error',
        message: msg,
        steerInstruction: `[YSK 旁路提醒] ${msg} 请明确向上抛出或返回带原因的失败态。`,
        watcherModel,
      };
    }
  }

  // 4. 若接入了免费 swe-2 语义检查器，异步问一句「有没有一直该做但没做、或做错了没注意到的事」
  if (swe2Judge && input.changedFiles.length > 0) {
    const prompt = [
      '你是 Claude Code 风格的 you-should-know (YSK) 旁路挑错员。只看别人做事，不改代码。',
      `【原定目标】：${input.taskGoal}`,
      `【禁止事项】：${input.mustNotDo.join('；') || '无'}`,
      '【当前已改代码摘要】：',
      ...input.changedFiles.map(
        (f) => `File: ${f.path} (+${f.addedLines}/-${f.removedLines})\n${f.diffPreview.slice(0, 800)}`,
      ),
      '请回答：有没有什么事情是主 agent 一直该做但漏做的，或者顺手改坏、越界但没注意到的？如果没有问题只输出 OK；如果有问题，用一句话（不超过55个字）直接指出坏消息。',
    ].join('\n');

    const reply = (await swe2Judge(prompt)).trim();
    if (reply && reply.toUpperCase() !== 'OK' && !reply.startsWith('没有')) {
      return {
        triggered: true,
        badge: '✦ Heads up · 主 agent',
        severity: 'warning',
        kind: 'collateral-edit',
        message: reply,
        steerInstruction: `[YSK 旁路提醒] ${reply}`,
        watcherModel,
      };
    }
  }

  return {
    triggered: false,
    badge: '✦ Heads up · 主 agent',
    severity: 'warning',
    kind: 'clean',
    message: '未发现越界或漏改',
    watcherModel,
  };
}
