// 读取器共用的小工具：去掉 undefined、数字与时间收口、错误信息脱敏。

/** 去掉值为 undefined 的键：exactOptionalPropertyTypes 下可选字段不许显式写 undefined。 */
export function pruned<T extends object>(o: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** 有限数字（数字或数字串）；别的一律 undefined，不猜。 */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/**
 * 时间收成 ISO 串。上游给的有三种：unix 秒、unix 毫秒（数字或数字串）、ISO 串。
 * 小于 1e11 的数按秒算（1e11 秒是公元 5138 年，毫秒则是 1973 年，两边不会混）。
 */
export function toIso(v: unknown): string | undefined {
  const n = num(v);
  if (n !== undefined) {
    const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v.trim());
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 把可能带凭据或身份的片段抹掉，再截到末尾 max 个字符。
 * 错误信息里常夹着上游回包或命令输出——进日志和驾驶舱之前一律过这一道。
 */
export function redact(text: string, max = 300): string {
  const cleaned = String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <令牌>')
    // 邮箱只从一段字符的开头试：从中间起能配上的，从开头起也一定配得上（字符集一样），结果不变；
    // 不加这一条，几万字不断开的长串会被逐位重试，耗时按长度的平方涨（5 万字约 1 秒）。
    .replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<邮箱>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<令牌>')
    .replace(/\b(?:sk|rk|pk|xai|tvly)-[A-Za-z0-9_-]{8,}/gi, '<密钥>')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '<密钥>')
    .replace(/([?&](?:token|key|access_token|api_key)=)[^&\s"']+/gi, '$1<令牌>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<IP>')
    .replace(/\b[0-9a-f]{32}\b/gi, '<长串>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<长串>')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `…${cleaned.slice(-max)}` : cleaned;
}

/** 把 ~ 开头的路径展开到给定家目录。 */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home.replace(/[\\/]+$/, '')}/${path.slice(2)}`;
  return path;
}

/** 这些变量一旦进了 Claude Code 的环境，请求就会绕开 reclaude 的代理链、或换成别的凭据。 */
export function isForbiddenClaudeEnv(key: string): boolean {
  const k = key.toUpperCase();
  return k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN';
}
