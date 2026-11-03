// 起新内核进程（#3811）：node packages/harness-dispatch/src/bin/kernel.ts，配置全从环境变量来（法国上是单元的 EnvironmentFile）。
// 装配档案（#3858）：FLEET2_PROFILE=france（默认，行为同 #3811 以来）| local（本机一条命令起用 pnpm fleet2 up）。
// 每行一条 JSON 打到 stdout（进 journal），影子静默打 {"alert":"shadow-silent",…}。收到 SIGTERM 先不领新活、等跑着的工人收尾再退。
import { ConfigError, PROFILES, type ProfileName } from '../profiles/config.ts';
import { assembleFrance } from '../profiles/france.ts';
import { runAssembly } from '../profiles/run.ts';

const profile = (process.env.FLEET2_PROFILE ?? 'france') as ProfileName;
try {
  if (!PROFILES.includes(profile)) throw new ConfigError(`FLEET2_PROFILE 只认 ${PROFILES.join('、')}`);
  // local 档案才载入 PGlite；法国进程不带它
  const assembly =
    profile === 'local'
      ? await (await import('../profiles/local.ts')).assembleLocal(process.env)
      : assembleFrance(process.env);
  await runAssembly(assembly, { signals: true });
} catch (err) {
  if (err instanceof ConfigError || (err instanceof Error && err.name === 'LocalDbBusyError')) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}
