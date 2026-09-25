// 这个包抛的错误。形状和引擎的 PortError 对齐（code、retryable、details），引擎的活动层原样转过 Temporal 边界即可。
// 改这里之前：code 是给程序分流用的，别改名；message 与 details 都会原样进 Temporal 历史、落库，
// 所以两者在构造时统一打码（details 逐层打，GitHub 回显的原文就放在 details 里）。

export interface GitHubErrorOptions {
  retryable?: boolean;
  details?: unknown;
  status?: number;
  /** 写请求断在回执上：GitHub 那边可能已经写成了。重试前必须先按标记或分支回查，不能盲写。 */
  maybeLanded?: boolean;
  cause?: unknown;
}

export class GitHubError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;
  readonly status: number | undefined;
  readonly maybeLanded: boolean;
  constructor(code: string, message: string, options: GitHubErrorOptions = {}) {
    super(redact(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GitHubError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = redactDeep(options.details);
    this.status = options.status;
    this.maybeLanded = options.maybeLanded ?? false;
  }
}

export function isGitHubError(err: unknown, code?: string): err is GitHubError {
  return err instanceof GitHubError && (code === undefined || err.code === code);
}

// —— 凭据打码：令牌只活在内存和子进程环境里；任何要进日志、报错、返回值的文字都先过这里。——

const live = new Set<string>();

/** 换到手的令牌、签出的 JWT 登记在这里，redact 会按原值打码（兜住 git 报错里原样回显之类的意外）。 */
export function registerSecret(value: string): void {
  if (value.length >= 8) live.add(value);
}

export function forgetSecret(value: string): void {
  live.delete(value);
}

const PATTERNS: RegExp[] = [
  // GitHub 各类令牌（安装令牌 ghs_，个人 ghp_/github_pat_……）。官方预告长度会变，只认前缀。
  /\b(?:ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9_]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  // JWT（App 身份）：三段 base64url。
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // git 的 Authorization: basic base64(x-access-token:<令牌>)
  /\beC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/=]+/g,
  /(authorization\s*:\s*(?:bearer|basic|token)\s+)\S+/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const secret of live) {
    if (out.includes(secret)) out = out.split(secret).join('<redacted>');
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (_match, prefix) =>
      typeof prefix === 'string' ? `${prefix}<redacted>` : '<redacted>',
    );
  }
  return out;
}

/** 逐层打码：对象、数组里的每个字符串都过 redact；错误对象只留打过码的名字和信息。 */
export function redactDeep(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  if (seen.has(value)) return '[循环引用]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen));
  if (value instanceof Error) return redact(`${value.name}: ${value.message}`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, seen);
  return out;
}
