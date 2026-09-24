// 飞书网关（跑在香港）：收消息、卡片、菜单、推送。进程入口在 main.ts。
export { ACTING_HEADER, BackendError, createBackend } from './backend.ts';
export { ConfigError, loadConfig } from './config.ts';
export { createGateway, MENU_KEYS } from './gateway.ts';
export { createLark } from './lark.ts';
