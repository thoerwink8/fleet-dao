// 证据：按题目声明的字段收原文，原样喂给模型（不裁剪——缺信息比多信息伤得重，旧系统实测）。
// 库里只记摘要：长度、哈希、开头（私聊字段不留开头），加上调用方给的能复原原文的引用（issue 号 + updated_at 之类）。
import { createHash } from 'node:crypto';
import type { EvidenceField, QuestionDef } from './questions.ts';

export type EvidenceInput = Readonly<Record<string, string | undefined>>;

export interface FieldDigest {
  chars: number;
  /** sha256 前 16 位。 */
  sha: string;
  /** 开头 HEAD_CHARS 个字；私聊字段没有。 */
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
      ...(f.private ? {} : { head: text.slice(0, HEAD_CHARS) }),
    };
  }
  return out;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 创始人按北京时间过日子（UTC+8，没有夏令时）。 */
const OFFSET = 8 * HOUR;

/** 「今天」从北京时间 0 点算起。 */
export function dayStart(now: Date): Date {
  const local = now.getTime() + OFFSET;
  return new Date(local - (((local % DAY) + DAY) % DAY) - OFFSET);
}
