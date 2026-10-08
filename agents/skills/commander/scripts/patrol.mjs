// 法国只读巡查，命令行（决定 0034，#1372）：node patrol.mjs [--baseline <文件>] | --selftest
// 判法全在 patrol-lib.mjs；这里只接 ssh、本机时钟和基线文件。最后一行是 VERDICT，退出码 0 OK、1 ALERT、2 BROKEN。
// 用 exitCode 不用 process.exit：输出接到管道上时，exit 可能把没写完的截掉。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DEFAULT_BASELINE, fetchFrance, runPatrol, selftest } from './patrol-lib.mjs';

const USAGE = `用法：node patrol.mjs [--baseline <文件>]   一次 ssh 只读收齐法国盘面，判不变量，和基线比出变化
      node patrol.mjs --selftest              拿一份固定的假输出验 ALERT、BROKEN 的判法还灵（不连 ssh）
基线默认 ${DEFAULT_BASELINE}（相对当前目录，指挥官在主检出根目录跑），只由这个脚本写；BROKEN 的那次不写。
最后一行：VERDICT: OK | VERDICT: ALERT <条数> | VERDICT: BROKEN；退出码 0 | 1 | 2。
登法国的 ssh 名字：环境变量 FLEET_FRANCE_SSH，或 ~/.fleet-dao/france-ssh 的第一行。`;

/** @param {string[]} argv */
async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (argv.includes('--selftest')) {
    const r = selftest(new Date());
    console.log(r.lines.join('\n'));
    return r.ok ? 0 : 2;
  }
  const i = argv.indexOf('--baseline');
  const given = i >= 0 ? argv[i + 1] : DEFAULT_BASELINE;
  if (!given || given.startsWith('--')) {
    console.error(`--baseline 后面要跟文件路径\n${USAGE}`);
    return 2;
  }
  const file = resolve(given);
  const r = await runPatrol({
    fetchRaw: () =>
      fetchFrance({ home: homedir(), env: process.env, readText: (f) => readFileSync(f, 'utf8') }),
    now: () => new Date(),
    loadBaseline: () => {
      try {
        return readFileSync(file, 'utf8');
      } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return null;
        throw e;
      }
    },
    saveBaseline: (text) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
  });
  console.log(r.lines.join('\n'));
  return r.code;
}

process.exitCode = await main(process.argv.slice(2));
