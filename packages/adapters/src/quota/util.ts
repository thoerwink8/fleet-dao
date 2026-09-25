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

/** 邮箱「@」前面那一段能用的字符。 */
const EMAIL_LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
/** 在一段这种字符的开头起配（前一个字不是它）。 */
const EMAIL_AT_RUN_START = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 就在这一处起配（紧接着上一个邮箱、字符没断开）。 */
const EMAIL_RIGHT_HERE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/y;

/**
 * 抹邮箱。认出来的和整段跑一遍 /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g 一样（从最左边起配，配上一个就从它末尾接着找），
 * 但那样会在几万字不断开的长串里逐位重试，耗时按长度的平方涨（5 万字约 1 秒）。所以只在两种地方起配：
 * 一段字符的开头；紧接着上一个邮箱、字符没断开的地方（a@b.com_c@d.com 的第二个）。一段中间别处能配上的，
 * 从这段开头或紧接处起也一定配得上、而且更靠左，不用试。只在段开头试一遍不够：连写的第二个、第三个会漏。
 */
export function maskEmails(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    let m: RegExpExecArray | null = null;
    if (from > 0 && EMAIL_LOCAL_CHAR.test(text.charAt(from))) {
      EMAIL_RIGHT_HERE.lastIndex = from;
      m = EMAIL_RIGHT_HERE.exec(text);
    }
    if (!m) {
      EMAIL_AT_RUN_START.lastIndex = from;
      m = EMAIL_AT_RUN_START.exec(text);
    }
    if (!m) return out + text.slice(from);
    out += `${text.slice(from, m.index)}<邮箱>`;
    from = m.index + m[0].length;
  }
}

/**
 * 把可能带凭据或身份的片段抹掉，再截到末尾 max 个字符。
 * 错误信息里常夹着上游回包或命令输出——进日志和驾驶舱之前一律过这一道。
 */
export function redact(text: string, max = 300): string {
  const cleaned = maskEmails(String(text).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <令牌>'))
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
