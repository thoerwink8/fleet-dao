// 证据：按题目声明的字段收原文，原样喂给模型（不裁剪——缺信息比多信息伤得重，旧系统实测）。
// 库里只记摘要：长度、哈希、开头（私聊字段不留开头），加上调用方给的能复原原文的引用（issue 号 + updated_at 之类）。
// 开头先脱敏再截：驾驶舱看得到这一列，证据原文里可能夹着令牌、邮箱、IP。
import { createHash } from 'node:crypto';
import { redact } from '@fleet-dao/adapters';
import type { EvidenceField, QuestionDef } from './questions.ts';

export type EvidenceInput = Readonly<Record<string, string | undefined>>;

export interface FieldDigest {
  chars: number;
  /** 原文 sha256 的前 16 位。 */
  sha: string;
  /** 脱敏后的开头 HEAD_CHARS 个字（空白并成一个空格）；私聊字段没有。 */
  head?: string;
}

const HEAD_CHARS = 200;

/** 这几道题一起问时要喂的字段（按第一次出现的顺序，去重）。 */
export function fieldsOf(questions: readonly QuestionDef[]): EvidenceField[] {
  const seen = new Map<string, EvidenceField>();
  for (const q of questions) for (const f of q.evidence) if (!seen.has(f.key)) seen.set(f.key, f);
  return [...seen.values()];
}

/** 证据里有没有哪道题都不认识的字段：多半是调用方写错了键，喂进去也没人看。 */
export function unknownKeys(questions: readonly QuestionDef[], evidence: EvidenceInput): string[] {
  const known = new Set(fieldsOf(questions).map((f) => f.key));
  return Object.keys(evidence).filter((k) => !known.has(k));
}

/** 这道题必填但没给（或全是空白）的字段。 */
export function missingKeys(q: QuestionDef, evidence: EvidenceInput): string[] {
  return q.evidence.filter((f) => f.required && !evidence[f.key]?.trim()).map((f) => f.key);
}

export function digestEvidence(fields: readonly EvidenceField[], evidence: EvidenceInput) {
  const out: Record<string, FieldDigest> = {};
  for (const f of fields) {
    const text = evidence[f.key];
    if (text === undefined) continue;
    out[f.key] = {
      chars: text.length,
      sha: createHash('sha256').update(text).digest('hex').slice(0, 16),
      // 整段脱敏之后再截：先截会把跨过截断处的令牌截成半截，半截认不出、就原样漏进库。
      ...(f.private ? {} : { head: redact(text, Number.POSITIVE_INFINITY).slice(0, HEAD_CHARS) }),
    };
  }
  return out;
}

const DAY = 24 * 3_600_000;

/**
 * 每日上限的「今天」从 UTC 0 点算起：和额度读取器里 Jev 那个池的窗口一致（deploy/examples/quota.example.json，
 * anchor 00:00Z、24 小时），驾驶舱额度页上的「今天花了多少」和这里停不停调用的是同一个数。
 */
export function dayStart(now: Date): Date {
  const t = now.getTime();
  return new Date(t - (((t % DAY) + DAY) % DAY));
}
