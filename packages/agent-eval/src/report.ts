// 报告：场景 × 三档的表（过几道 / 共几道、平均用时、平均 token），下面每道题的提示词和产出原文折叠起来。
import { MODEL_KEYS, type ModelKey } from './launcher.ts';
import type { CaseResult } from './runner.ts';
import { SKIPPED_SCENARIOS } from './types.ts';

function fence(text: string): string {
  let ticks = 3;
  for (const m of text.matchAll(/`+/g)) ticks = Math.max(ticks, m[0].length + 1);
  const f = '`'.repeat(ticks);
  return `${f}text\n${text}\n${f}`;
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

function markOf(r: CaseResult): string {
  return r.status === 'pass'
    ? '过'
    : r.status === 'fail'
      ? '没过'
      : r.status === 'model-mismatch'
        ? '模型对不上'
        : '没跑成';
}

function cell(rs: CaseResult[]): string {
  if (rs.length === 0) return '—';
  const ran = rs.filter((r) => r.status === 'pass' || r.status === 'fail');
  const mismatch = rs.filter((r) => r.status === 'model-mismatch').length;
  const notRun = rs.filter((r) => r.status === 'not-run').length;
  const parts: string[] = [];
  if (ran.length > 0) {
    const pass = ran.filter((r) => r.status === 'pass').length;
    const avgMs = ran.reduce((s, r) => s + r.durationMs, 0) / ran.length;
    const avgTok = ran.reduce((s, r) => s + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0) / ran.length;
    parts.push(
      `过 ${pass} / 跑 ${ran.length} 遍`,
      `均 ${fmtSeconds(avgMs)}`,
      `均 ${fmtTokens(avgTok)} token`,
    );
  }
  if (notRun > 0) parts.push(`${notRun} 道没跑成`);
  if (mismatch > 0) parts.push(`${mismatch} 道模型对不上`);
  parts.push(rs.every((r) => r.status === 'pass') ? '全过' : '没全过');
  return parts.join('；');
}

export function renderReport(
  results: readonly CaseResult[],
  meta: { startedAt: string; models: readonly ModelKey[] },
): string {
  const out: string[] = [];
  out.push('# 子代理能力探查报告', '');
  out.push(`开始时间：${meta.startedAt}；模型：${meta.models.join('、')}；共 ${results.length} 条结果。`, '');
  out.push(
    '格式：过 x / 跑 y 遍（题数 × 每题跑几遍，不含没跑成的）；均用时；均 token（输入含缓存，加输出）。没跑成的不算过也不算没过。',
    '',
    '定档按方案第四节：通过率 ≥ 80% 的最便宜那一档；题少于 3 道时要全过。多跑几遍时「全过」指每一遍都过：有一遍没过、没跑成或模型对不上，这一格就写「没全过」。',
    '',
  );
  out.push(`| 场景 | ${MODEL_KEYS.join(' | ')} |`, `|---|${MODEL_KEYS.map(() => '---').join('|')}|`);
  const scenarios = [...new Set(results.map((r) => r.scenario))];
  for (const s of scenarios) {
    const row = MODEL_KEYS.map((m) => cell(results.filter((r) => r.scenario === s && r.model === m)));
    out.push(`| ${s} | ${row.join(' | ')} |`);
  }
  out.push('');
  out.push('| 题 | 第几遍 | 点名的模型 | 实际模型 | 结果 | 用时 |', '|---|---|---|---|---|---|');
  for (const r of results) {
    out.push(
      `| ${r.caseId} | ${r.attempt} | ${r.modelId} | ${r.observedModel ?? '没读到'} | ${markOf(r)} | ${fmtSeconds(r.durationMs)} |`,
    );
  }
  out.push('');
  const mism = results.filter((r) => r.status === 'model-mismatch');
  if (mism.length > 0) {
    out.push('## 模型对不上（不算过也不算没过）', '');
    for (const r of mism) out.push(`- ${r.caseId} · ${r.model}：${r.reason}`);
    out.push('');
  }
  for (const k of SKIPPED_SCENARIOS) out.push(`- ${k.scenario}（${k.agent}）：${k.reason}`);
  out.push('', '## 每道题', '');
  for (const r of results) {
    const mark = markOf(r);
    out.push(`<details><summary>${r.caseId} · ${r.model} · 第 ${r.attempt} 遍 · ${mark}</summary>`, '');
    out.push(`- 子代理：${r.agent}；模型：${r.modelId}`);
    if (r.streamFile) out.push(`- 原始会话流：${r.streamFile}`);
    for (const f of r.judgeStreamFiles) out.push(`- 裁判会话流：${f}`);
    out.push(`- 理由：${r.reason.replace(/\n/g, ' ')}`);
    if (r.score !== undefined) out.push(`- 打分：${r.score}`);
    out.push(
      `- 实际模型：${r.observedModel ?? '没读到'}（init 帧 ${r.initModel ?? '无'}，assistant 帧 ${r.assistantModel ?? '无'}）
- 用时：${fmtSeconds(r.durationMs)}；输入 token：${r.inputTokens ?? '—'}；输出 token：${r.outputTokens ?? '—'}；回合：${r.numTurns ?? '—'}`,
    );
    out.push(
      '',
      '提示词：',
      '',
      fence(r.prompt),
      '',
      `产出${r.outputTruncated ? '（已截断）' : ''}：`,
      '',
      fence(r.output || '（空）'),
      '',
    );
    out.push('</details>', '');
  }
  return `${out.join('\n')}\n`;
}
