// 渠道配置在加载时校验（#3854 第 1 片）。配错抛 ConfigError，调用方拿不到可用结果，工人不起。
// 壳和协议只认成对的：claude-code 配 anthropic，grok 配 grok-cli。openai 现有壳都不配。
// 不读密钥的值，只要求渠道上写了环境变量名。兜底链、按环节选路不在这一片。
import type { WorkerShell } from '@fleet-dao/harness-workers';
import { ConfigError } from './config.ts';

/** 渠道协议。openai 留在表里，但现有壳没有与之成对的。 */
export type ChannelProtocol = 'anthropic' | 'openai' | 'grok-cli';

export interface ChannelEntry {
  name: string;
  protocol: ChannelProtocol;
  /** 这个渠道能用的模型，名字按配置原文比对。 */
  models: readonly string[];
  /** 密钥环境变量的名字。不写值。空着当没给。 */
  secretEnv?: string;
}

/** 一次加载要核的最小配置：渠道表，加上点名的渠道、模型和壳。 */
export interface ChannelConfig {
  channels: readonly ChannelEntry[];
  channel: string;
  model: string;
  shell: string;
}

export interface LoadedChannel {
  channel: string;
  model: string;
  shell: WorkerShell;
}

function shellMatchesProtocol(shell: string, protocol: ChannelProtocol): shell is WorkerShell {
  return (
    (shell === 'claude-code' && protocol === 'anthropic') || (shell === 'grok' && protocol === 'grok-cli')
  );
}

/** 加载一份最小渠道配置。四种配错各抛 ConfigError，错误信息里写明是哪一种。 */
export function loadChannelConfig(config: ChannelConfig): LoadedChannel {
  const entry = config.channels.find((c) => c.name === config.channel);
  if (!entry) throw new ConfigError(`渠道名不存在：${config.channel}`);
  if (!entry.models.includes(config.model)) {
    throw new ConfigError(`模型不在该渠道清单：${config.model}`);
  }
  if (!shellMatchesProtocol(config.shell, entry.protocol)) {
    throw new ConfigError(`协议和壳不配：${entry.protocol} 与 ${config.shell}`);
  }
  const secretEnv = typeof entry.secretEnv === 'string' ? entry.secretEnv.trim() : '';
  if (secretEnv === '') throw new ConfigError(`密钥环境变量名缺：${entry.name}`);
  return { channel: entry.name, model: config.model, shell: config.shell };
}
