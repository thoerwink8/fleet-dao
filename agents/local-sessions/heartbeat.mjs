#!/usr/bin/env node
// 本机会话心跳的钩子（#1991）：Claude Code 每次 SessionStart / PreToolUse / Stop / SubagentStop / SessionEnd 跑一次，
// 把这个会话的元信息写进 ~/.fleet-dao/local-sessions/sessions/。说明和隐私边界见同目录 lib.mjs 开头。
// 不拦、不打印、不联网：出什么错都 exit 0，绝不挡住会话。
import { homedir } from 'node:os';
import { writeHeartbeat } from './lib.mjs';

/** @returns {Promise<string>} */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const input = JSON.parse(await readStdin());
  if (typeof input === 'object' && input !== null)
    writeHeartbeat(input, { home: homedir(), now: new Date() });
} catch {
  // 心跳写不成只少一次心跳，不影响会话
}
process.exit(0);
