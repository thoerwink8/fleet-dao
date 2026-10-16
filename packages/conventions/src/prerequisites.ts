// 单正文里「前置：」那一行的解析（单 #2783）：有先后依赖的单靠它压住——本机队列（work-queue.ts，#2775）和引擎拉单
// （packages/engine/src/jobs/intake.ts）都调这一份，不各写一套。
//
// 认哪些写法（test/prerequisites.test.ts 逐条钉着）：
// - 一行以「前置：」或「前置:」开头（行首可以有空白），正文里这样的行有几行都算；列表项（- 前置：）、引用（> 前置：）、
//   行中间提到的、「前置条件：」都不认；``` 或 ~~~ 围起来的代码块里的是举例，不认。
// - 这一行里的 #N 是前置单（按出现先后、去重）；后面跟说明文字、括号里的话不影响。
// - 这一行里的 YYYY-MM-DD（真有的那天）是日期前置：北京时间到那天之前算「等到 <日期>」，那天 0 点起不再等；写了几个取最晚的。
// 认不出的写法一律按「没有前置」算，不抛——前置是压住的手段，认不出就放行是已有的行为，别让一行写歪的字把整条命令弄坏。
// 前置单开没开着不在这里判：本机队列用 gh 问，引擎拉单用开着的单列表加批量读，各自读不到时按「等前置」算（都记没查成）。

export interface Prerequisites {
  /** 「前置：」那几行里提到的单号（按出现先后、去重） */
  issues: number[];
  /** 日期前置里最晚的一天（YYYY-MM-DD，北京时间那天 0 点起放行）；没写是 null */
  until: string | null;
}

const PREREQUISITE_LINE = /^\s*前置[：:]/;
const FENCE = /^\s*(```|~~~)/;
const DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;

/** 真有这一天（2026-02-30、2026-13-45 不算） */
function isRealDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 解析一张单正文里的「前置：」行。认不出的写法按没有前置算，不抛。 */
export function parsePrerequisites(body: string): Prerequisites {
  const issues: number[] = [];
  let until: string | null = null;
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = FENCE.exec(line)?.[1];
    if (f !== undefined) {
      if (fence === null) fence = f;
      else if (fence === f) fence = null;
      continue;
    }
    if (fence !== null || !PREREQUISITE_LINE.test(line)) continue;
    for (const m of line.matchAll(/#(\d+)/g)) {
      const n = Number(m[1]);
      if (Number.isSafeInteger(n) && n > 0 && !issues.includes(n)) issues.push(n);
    }
    for (const m of line.matchAll(DATE)) {
      if (!isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) continue;
      const day = `${m[1]}-${m[2]}-${m[3]}`;
      if (until === null || day > until) until = day;
    }
  }
  return { issues, until };
}

/** 北京时间（UTC+8）此刻是哪一天，YYYY-MM-DD */
export function beijingDate(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 日期前置还要等到哪天；没写日期、或北京时间已经到了那天，是 null */
export function waitingUntil(pre: Prerequisites, now: Date): string | null {
  return pre.until !== null && beijingDate(now) < pre.until ? pre.until : null;
}
