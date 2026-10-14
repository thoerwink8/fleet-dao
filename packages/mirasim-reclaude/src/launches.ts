// 单会话启动命令覆盖：Mirasim 的 setSessionLaunch 把某个会话的启动命令/参数写进
// ~/.mirasim/plugin-index/<工作区>.json 的 launches["claude:<会话>"]，盖过设置里的全局启动命令。
// 覆盖成裸 claude 的会话不经 reclaude，全局装好了也没用，所以 --check 和对账都要列出来。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isBareClaude, isManagedLaunch } from './migrate.ts';

/** launcher＝指向本工具启动器；bare＝裸 claude，绕过 reclaude；other＝别的命令；args-only＝只改参数，命令跟全局。 */
export type OverrideKind = 'launcher' | 'bare' | 'other' | 'args-only';
export interface LaunchOverride {
  sid: string;
  kind: OverrideKind;
  /** 只留文件名，不带目录和参数。 */
  command?: string;
}

const KIND_TEXT: Record<OverrideKind, string> = {
  launcher: '本工具启动器（经 reclaude 选路）',
  bare: '裸 claude（绕过 reclaude，这个会话全走平台额度）',
  other: '其他命令（本工具不管）',
  'args-only': '只改参数，命令跟全局',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 按 Mirasim 自己的读法：command/args 是去空白后非空的字符串才算，两样都没有的项 Mirasim 也忽略。 */
export function launchOverrides(home: string): LaunchOverride[] {
  const dir = join(home, '.mirasim', 'plugin-index');
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new Error(`Mirasim 路由索引目录读不到：${dir}`);
  }
  const out: LaunchOverride[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.endsWith('.queue.json') || name.endsWith('.deleted.json')) continue;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      throw new Error(`Mirasim 路由索引读不到或不是 JSON：${name}`);
    }
    if (!isObject(data)) throw new Error(`Mirasim 路由索引不是 JSON 对象：${name}`);
    const launches = data.launches;
    if (launches === undefined) continue;
    if (!isObject(launches)) throw new Error(`Mirasim 路由索引的 launches 格式不认识：${name}`);
    for (const [key, value] of Object.entries(launches)) {
      if (!key.startsWith('claude:') || !isObject(value)) continue;
      const command = typeof value.command === 'string' && value.command.trim() ? value.command : undefined;
      const args = typeof value.args === 'string' && value.args.trim() ? value.args : undefined;
      if (!command && !args) continue;
      const sid = key.slice('claude:'.length);
      if (!command) {
        out.push({ sid, kind: 'args-only' });
        continue;
      }
      const kind: OverrideKind = isManagedLaunch(command)
        ? 'launcher'
        : isBareClaude(command)
          ? 'bare'
          : 'other';
      out.push({ sid, kind, command: basename(command.replaceAll('\\', '/')) });
    }
  }
  return out;
}

/** 给人看的几行：会话 ID 前 8 位、分类、命令文件名；red[i] 为真的行要标红，bare 是标红条数。 */
export function overrideLines(list: LaunchOverride[]): { lines: string[]; red: boolean[]; bare: number } {
  if (!list.length) return { lines: ['会话单独启动命令：无'], red: [false], bare: 0 };
  const lines = [`会话单独启动命令 ${list.length} 条（盖过全局启动命令）：`];
  const red = [false];
  for (const o of list) {
    lines.push(`  ${o.sid.slice(0, 8)}  ${KIND_TEXT[o.kind]}${o.command ? `  ${o.command}` : ''}`);
    red.push(o.kind === 'bare');
  }
  return { lines, red, bare: list.filter((o) => o.kind === 'bare').length };
}

/** --check 的退出码：当前新版退 0，但有会话覆盖成裸 claude 时也算没接好，退 75。 */
export function checkExitCode(state: string, bare: number): number {
  return state === 'waiting' || bare > 0 ? 75 : 0;
}
