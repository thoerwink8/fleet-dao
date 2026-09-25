// 结论：每一项落一行，行首的符号和装机脚本（deploy/lib/common.sh）一样，france.sh 按符号把它接进自己的账：
// ✓ 一致、↻ 这次改了、✗ 漂移 / 缺失 / 没做成、… 没查成、· 没装（跳过）或没东西可做。
// 退出码：有 ✗ 为 1；没有 ✗ 但有 … 为 2；其余 0（「没装」不影响退出码，但照样逐项列出，不算进「一致」）。

export type Kind = 'ok' | 'changed' | 'drift' | 'missing' | 'failed' | 'unknown' | 'skip';

export interface Line {
  kind: Kind;
  /** 这一项是谁（~/.codex/AGENTS.md、~/.claude/skills/grill-me）；同一项的读回不重复报 */
  key: string;
  text: string;
}

const GLYPH: Record<Kind, string> = {
  ok: '✓',
  changed: '↻',
  drift: '✗',
  missing: '✗',
  failed: '✗',
  unknown: '…',
  skip: '·',
};

export function line(kind: Kind, key: string, text: string): Line {
  return { kind, key, text: `${key}：${text}` };
}

export function isBad(l: Line): boolean {
  return l.kind === 'drift' || l.kind === 'missing' || l.kind === 'failed';
}

export function render(lines: readonly Line[]): string {
  return lines.map((l) => `  ${GLYPH[l.kind]} ${l.text}\n`).join('');
}

export function exitCode(lines: readonly Line[]): 0 | 1 | 2 {
  if (lines.some(isBad)) return 1;
  if (lines.some((l) => l.kind === 'unknown')) return 2;
  return 0;
}

export function summary(lines: readonly Line[]): string {
  const n = (k: Kind): number => lines.filter((l) => l.kind === k).length;
  const parts = [
    `改动 ${n('changed')}`,
    `一致 ${n('ok')}`,
    `漂移 ${n('drift')}`,
    `缺失 ${n('missing')}`,
    `没做成 ${n('failed')}`,
    `没查成 ${n('unknown')}`,
    `没装或没东西（跳过）${n('skip')}`,
  ];
  return `结论：${parts.join('，')}；退出码 ${exitCode(lines)}\n`;
}
