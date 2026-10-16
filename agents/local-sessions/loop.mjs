#!/usr/bin/env node
// 本机会话推送的循环（#1991 补：有的 Windows 电脑不让建计划任务，schtasks 和 Register-ScheduledTask 都报「拒绝访问」）。
// install.mjs 在 schtasks 建不成时退回这一条：启动文件夹里的 vbs 在登录时隐藏起 node loop.mjs，每 2 分钟调一次同目录的 push.mjs，
// 结果由 push.mjs 自己写进 last-push.json。
//
// 改这里之前必须知道：
// - 只认一个实例：锁文件 ~/.fleet-dao/local-sessions/loop.pid，里面的进程还活着就退出、不起第二个。
// - 一次没推成不退出（网断了下一轮再试）；push.mjs 起不来、超时也只是这一轮没推成。
// - 退出时只删自己写的那把锁。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnDetached } from './detach.mjs';
import { loopPidPath, PUSH_EVERY_MS } from './lib.mjs';

/** @param {number} pid */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 锁文件里写的进程号；没有、写坏了是 null。
 * @param {string} lock
 * @returns {number | null}
 */
export function readLoopPid(lock) {
  try {
    const n = Number(readFileSync(lock, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 抢锁：别的进程还活着就是没抢到（false）；没人持有或持有者已死就写上自己（true）。
 * @param {{ lock: string, pid: number, alive?: (pid: number) => boolean }} o
 */
export function acquireLock({ lock, pid, alive = isAlive }) {
  const old = existsSync(lock) ? readLoopPid(lock) : null;
  if (old !== null && old !== pid && alive(old)) return false;
  writeFileSync(lock, String(pid));
  return true;
}

/**
 * 循环死了没人拉起的补救（创始人电脑睡眠 / 重启 / 被杀后，启动文件夹的 vbs 只在登录时跑一次，锁文件还留着，看板一直写「上次收到的已经过期」）：
 * 心跳钩子每次触发顺手看一眼——锁文件在、里面的进程已不在，就隐藏着起一个新的循环（它自己抢锁，起重了也只留一个）。
 * 锁文件不在（从没装自启、或循环干净退出过）不管：计划任务那一路没有循环，干净退出的是人让它停的。
 * @param {{ home: string, alive?: (pid: number) => boolean, start: () => void }} o
 * @returns {'no-lock' | 'alive' | 'started'}
 */
export function reviveLoop({ home, alive = isAlive, start }) {
  const lock = loopPidPath(home);
  if (!existsSync(lock)) return 'no-lock';
  const pid = readLoopPid(lock);
  if (pid !== null && alive(pid)) return 'alive';
  start();
  return 'started';
}

/**
 * 真起一个脱离当前进程树的隐藏循环。心跳钩子是 Claude Code 起的，以前用 spawn({ detached: true })，Mirasim 重启会话时
 * taskkill /T 顺着父进程号把循环一起杀了（单 #2761：循环的起始时间正好等于会话 resume 的时刻）；改经 detach.mjs（Windows 走 WMI）。
 */
export function startLoopDetached() {
  const loop = join(dirname(fileURLToPath(import.meta.url)), 'loop.mjs');
  spawnDetached(process.execPath, [loop]);
}

function main() {
  const home = homedir();
  const lock = loopPidPath(home);
  const push = join(dirname(fileURLToPath(import.meta.url)), 'push.mjs');
  if (!acquireLock({ lock, pid: process.pid })) return;
  const release = () => {
    try {
      if (readFileSync(lock, 'utf8').trim() === String(process.pid)) rmSync(lock);
    } catch {
      // 锁已经没了就算了
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  const tick = () => {
    spawnSync(process.execPath, [push], { windowsHide: true, timeout: 90_000 });
  };
  tick();
  setInterval(tick, PUSH_EVERY_MS);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
