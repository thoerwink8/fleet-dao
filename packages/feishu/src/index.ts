// 飞书网关（跑在香港）：进群说明、飞书用量上报、自己的看守。不收群聊私聊的话（#2047 F1）。进程入口在 main.ts。
export { BackendError, createBackend } from './backend.ts';
export { ConfigError, loadConfig } from './config.ts';
export { createGateway } from './gateway.ts';
export { createLark } from './lark.ts';
