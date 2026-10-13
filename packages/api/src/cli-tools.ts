// 法国页「命令行工具」的升级结果（#1971）：读 root 升级单元写下的 state.json。
// 不单独开接口：cli-versions.ts 把它挂到同一份 GET /france/cli-tools 的对应行上。
// 文件不在 = 还没升过。读不到、认不出回 unreadable，不拿空名单冒充查成了。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type FranceCliTools, FranceCliToolsSchema } from '@fleet-dao/shared';

const DEFAULT_DIR = '/var/lib/fleet-dao/cli-upgrade';
const OUTCOMES = new Set(['ok', 'current', 'skipped', 'failed', 'rolled-back', 'refused']);

function neverUpgraded(): FranceCliTools {
  return { state: 'ok', reason: null, checkedAt: null, why: null, tools: [] };
}

function unreadable(reason: string): FranceCliTools {
  return { state: 'unreadable', reason, checkedAt: null, why: null, tools: [] };
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 读一份升级结果。dir 不传就用 FLEET_CLI_UPGRADE_DIR，再没有就用法国上的默认目录。 */
export async function readFranceCliTools(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FranceCliTools> {
  const dir = env.FLEET_CLI_UPGRADE_DIR?.trim() || DEFAULT_DIR;
  const file = join(dir, 'state.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT') return neverUpgraded();
    return unreadable(`升级结果读不到：${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return unreadable('升级结果不是 JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return unreadable('升级结果认不出');
  const body = raw as Record<string, unknown>;
  const toolsRaw = body.tools;
  if (typeof toolsRaw !== 'object' || toolsRaw === null || Array.isArray(toolsRaw)) {
    return unreadable('升级结果的格式不对');
  }
  const tools: FranceCliTools['tools'] = [];
  for (const [id, value] of Object.entries(toolsRaw)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return unreadable(`升级结果里 ${id} 认不出`);
    }
    const tool = value as Record<string, unknown>;
    const outcome = textOf(tool.outcome);
    const name = textOf(tool.name)?.trim();
    tools.push({
      id,
      name: name && name !== '' ? name : id,
      version: textOf(tool.version),
      upgradedAt: textOf(tool.upgradedAt),
      channel: textOf(tool.channel),
      outcome:
        outcome !== null && OUTCOMES.has(outcome)
          ? (outcome as FranceCliTools['tools'][number]['outcome'])
          : null,
      detail: textOf(tool.detail) ?? '',
    });
  }
  const parsed = FranceCliToolsSchema.safeParse({
    state: 'ok',
    reason: null,
    checkedAt: body.checkedAt,
    why: body.why,
    tools,
  });
  if (!parsed.success) return unreadable('升级结果的格式不对');
  return parsed.data;
}
