// 装配档案的公共件（#3858）：配置读取、日志、档案接口。档案只管"装什么"，起停和信号在 bin/kernel.ts。
import type { KernelOptions } from '../kernel.ts';

/** 配置不对：入口打印消息、退出码 2，不起。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type Env = Record<string, string | undefined>;

export const need = (env: Env, k: string): string => {
  const v = env[k];
  if (!v) throw new ConfigError(`没给 ${k}，不起`);
  return v;
};

/** 读端口；allowZero 时 0 表示让系统挑一个空闲的（本机装法的页面口，测试用）。 */
export const port = (env: Env, k: string, def: number, allowZero = false): number => {
  const n = Number(env[k] ?? def);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 65_535) {
    throw new ConfigError(`${k} 不是端口：${env[k]}`);
  }
  return n;
};

export const log = (o: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

export type ProfileName = 'france' | 'local';
export const PROFILES: readonly ProfileName[] = ['france', 'local'];

/** 一个装配档案装好的东西：内核选项、起好之后要做的事、收尾。 */
export interface Assembly {
  profile: ProfileName;
  kernel: KernelOptions;
  /** 内核起来（接口层口已定）之后调；本机档案在这里起驾驶舱的单口服务。 */
  afterStart?(apiPort: number): Promise<void>;
  /** 内核停了之后调：关库、关口。 */
  close(): Promise<void>;
  /** 起好的那行日志要带的字段。 */
  startedFields(apiPort: number): Record<string, unknown>;
}
