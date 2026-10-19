// pnpm temporal:cli：把 deploy/france.sh 固定版本的 Temporal 命令行装进受管缓存（~/.cache/fleet-temporal-cli/<版本>/），
// 下载有整体期限、有界重试、校验和、原子落盘；已有且版本对就什么都不做。--check 只核不装。
//   pnpm temporal:cli [--check]
// 退出码：0 已就绪；1 没准备好（缺失/版本不符/卡住/下载或校验失败）；2 用法错或读不到固定版本。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHome, installCli, managedCliPath, parsePin, resolveCli } from '../temporal-cli.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const argv = process.argv.slice(2);
if (argv.some((a) => a !== '--check')) {
  console.error('用法：pnpm temporal:cli [--check]');
  process.exit(2);
}
let pin: ReturnType<typeof parsePin>;
try {
  pin = parsePin(readFileSync(join(root, 'deploy/france.sh'), 'utf8'));
} catch (e) {
  console.error(`读不到 deploy/france.sh：${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
if (typeof pin === 'string') {
  console.error(pin);
  process.exit(2);
}
const home = defaultHome();
const done = (r: Awaited<ReturnType<typeof installCli>>) => {
  if (r.ok) {
    console.log(`Temporal 命令行就绪：${r.path}（${r.version}）`);
    console.log('测试入口（pnpm check / test:changed）会自动认这个位置；直接 npx vitest 也会认受管缓存。');
    return 0;
  }
  console.error(r.message);
  return 1;
};
if (argv.includes('--check')) {
  process.exitCode = done(
    resolveCli({
      env: { ...process.env, FLEET_TEST_TEMPORAL_CLI: process.env.FLEET_TEST_TEMPORAL_CLI },
      version: pin.version,
      platform: process.platform,
      home,
    }),
  );
  console.log(`（受管缓存位置 ${managedCliPath(pin.version, process.platform, home)}）`);
} else {
  process.exitCode = done(await installCli({ pin, platform: process.platform, arch: process.arch, home }));
}
