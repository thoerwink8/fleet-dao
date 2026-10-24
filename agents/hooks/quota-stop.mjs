#!/usr/bin/env node
// StopFailure 钩子（决定 0120 第 5 条，#3687）：回合因接口报错结束时，往 ~/.fleet-dao/state/quota-stops.jsonl 追加一行
// （会话号、报错类别、原文），给「清零那一刻给原会话发继续」用。现在只记不续：拼车用满时 reclaude 回什么原文还没抓到，
// 判法要按抓到的原文定。
// 改这里之前必须知道：
// - 永远退出 0、不往标准输出写：StopFailure 的输出本来就不被理会，这里出错也不能挡会话。
// - 原文截短再记，抹掉像 Key 的串；不记对话内容。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cut = (/** @type {unknown} */ v, /** @type {number} */ n) =>
  typeof v === 'string' ? v.replace(/rck_[A-Za-z0-9_-]+/g, 'rck_<抹掉>').slice(0, n) : undefined;

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const row = {
    at: new Date().toISOString(),
    session_id: input.session_id,
    cwd: input.cwd,
    transcript_path: input.transcript_path,
    error: input.error,
    error_details: cut(input.error_details, 1000),
    last_assistant_message: cut(input.last_assistant_message, 500),
  };
  const dir = join(homedir(), '.fleet-dao', 'state');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'quota-stops.jsonl'), `${JSON.stringify(row)}\n`);
} catch {
  // 记不下也不挡会话。
}
