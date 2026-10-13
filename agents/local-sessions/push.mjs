#!/usr/bin/env node
// 本机会话推送（#1991）：Windows 计划任务每 2 分钟跑一次，把心跳凑成一份推给法国。说明见同目录 lib.mjs 开头。
// 结果写进 ~/.fleet-dao/local-sessions/last-push.json；没推成退出码 1（看板那边超过 5 分钟没收到就写「没上报」）。
import { homedir } from 'node:os';
import { claudeDirOf, pushOnce } from './lib.mjs';

const home = homedir();
const result = await pushOnce({ home, now: new Date(), claudeDir: claudeDirOf(home) });
process.stdout.write(`${result.ok ? `推了 ${result.sessions ?? 0} 个会话` : `没推成：${result.why}`}\n`);
process.exit(result.ok ? 0 : 1);
