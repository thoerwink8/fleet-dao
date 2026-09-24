// 额度读取的命令行入口：node packages/adapters/src/quota/cli.ts [--json] [--config <文件>] [--pool <池>]…
// 退出码：0 全部读到；1 有池没读成（表里写了原因）；2 配置不对或参数不对。
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadQuotaConfig, QuotaConfigError, quotaConfigPath } from './config.ts';
import type { QuotaDeps } from './context.ts';
import { formatQuotaTable } from './format.ts';
import { productionQuotaIo } from './io.ts';
import { readAllQuotas } from './read-all.ts';

const HELP = `用法：node packages/adapters/src/quota/cli.ts [选项]

读每个账号池、每个时间窗的额度，打印一张表。

  --json            打印完整结果（JSON），给程序读
  --config <文件>   配置文件；默认取环境变量 FLEET_QUOTA_CONFIG，再没有就是 /etc/fleet-dao/quota.json
  --pool <池>       只读这个池（可以给多次）
  --tz <时区>       清零时间按这个时区显示，例如 Asia/Shanghai；默认本机时区
  -h, --help        显示本说明

退出码：0 全部读到；1 有池没读成；2 配置或参数不对。`;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
}

/** 生产环境的外部能力只在命令行这里接上；库函数 readAllQuotas 不自己拿真的。 */
export async function runQuotaCli(
  argv: string[],
  io: CliIo,
  deps: QuotaDeps = productionQuotaIo(),
): Promise<number> {
  let json = false;
  let configPath: string | undefined;
  let timeZone: string | undefined;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 后面要跟一个值`);
      return v;
    };
    try {
      if (a === '--json') json = true;
      else if (a === '--config') configPath = value();
      else if (a === '--pool') only.push(value());
      else if (a === '--tz') timeZone = value();
      else if (a === '-h' || a === '--help') {
        io.out(HELP);
        return 0;
      } else throw new Error(`不认识的参数 ${a}`);
    } catch (e) {
      io.err(`${(e as Error).message}\n\n${HELP}`);
      return 2;
    }
  }

  const path = configPath ?? quotaConfigPath(io.env);
  let config: Awaited<ReturnType<typeof loadQuotaConfig>>;
  try {
    config = await loadQuotaConfig(path);
  } catch (e) {
    io.err(e instanceof QuotaConfigError ? e.message : `读配置出错：${String(e)}`);
    return 2;
  }
  if (only.length) {
    const missing = only.filter((id) => !config.pools.some((p) => p.poolId === id));
    if (missing.length) {
      io.err(`配置里没有这些池：${missing.join('、')}`);
      return 2;
    }
    config = { ...config, pools: config.pools.filter((p) => only.includes(p.poolId)) };
  }

  const report = await readAllQuotas(config, deps);
  if (json) io.out(JSON.stringify(report, null, 2));
  else io.out(formatQuotaTable(report, timeZone ? { timeZone } : {}));
  return report.results.every((r) => r.ok) ? 0 : 1;
}

function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  const code = await runQuotaCli(process.argv.slice(2), {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    env: process.env,
  });
  process.exitCode = code;
}
