export interface Config {
  retries: number;
  limits: { cpu: number; memMb: number };
  tags: string[];
}

/** 出厂默认值：常量，只读。 */
export const DEFAULTS: Config = {
  retries: 3,
  limits: { cpu: 2, memMb: 512 },
  tags: ['base'],
};
