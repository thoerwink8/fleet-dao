// 这台装了哪几家：按可执行文件在不在 PATH 里判（家目录的 .local/bin 也算：reclaude、claude 的原生安装都放那儿）。
// 不看配置目录在不在：法国的会话用户装了 codex、pi，家里却还没有 ~/.codex、~/.pi，照样要写。
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS, type AgentId, type Platform } from './targets.ts';

export interface DetectInput {
  /** 进程环境；只用 PATH 和 PATHEXT */
  env: Readonly<Record<string, string | undefined>>;
  platform: Platform;
  home: string;
}

function isExecutable(file: string, platform: Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform === 'linux') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 找到了返回那个文件的路径 */
export function findBin(name: string, input: DetectInput): string | undefined {
  const sep = input.platform === 'win32' ? ';' : ':';
  const dirs = [
    ...(input.env.PATH ?? '').split(sep).filter((d) => d !== ''),
    join(input.home, '.local', 'bin'),
  ];
  const exts =
    input.platform === 'win32'
      ? ['', ...(input.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir, name + ext);
      if (isExecutable(file, input.platform)) return file;
    }
  }
  return undefined;
}

export function installedAgents(input: DetectInput): Set<AgentId> {
  const found = new Set<AgentId>();
  for (const [id, agent] of Object.entries(AGENTS) as [AgentId, (typeof AGENTS)[AgentId]][]) {
    if (agent.bins.some((b) => findBin(b, input) !== undefined)) found.add(id);
  }
  return found;
}
