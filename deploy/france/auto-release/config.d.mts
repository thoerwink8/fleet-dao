/** 生产配置的 systemd env parser；不将解析出的值装入进程环境。 */
export function parseEnv(text: string): {
  entries: { key: string; value: string; start: number; end: number }[];
  mentioned: string[];
};
