// 渠道配置加载（#3854 第 1 片）：四种配错各抛一种错；合法最小配置原样返回渠道、模型、壳。
import { describe, expect, it } from 'vitest';
import { type ChannelConfig, loadChannelConfig } from '../src/profiles/channels.ts';
import { ConfigError } from '../src/profiles/config.ts';

function base(): ChannelConfig {
  return {
    channels: [
      {
        name: 'gateway-a',
        protocol: 'anthropic',
        models: ['glm-5.3'],
        secretEnv: 'GATEWAY_A_TOKEN',
      },
    ],
    channel: 'gateway-a',
    model: 'glm-5.3',
    shell: 'claude-code',
  };
}

describe('渠道配置加载', () => {
  it('渠道名不存在时抛错，信息写明这一种', () => {
    const config = { ...base(), channel: 'no-such' };
    expect(() => loadChannelConfig(config)).toThrow(new ConfigError('渠道名不存在：no-such'));
  });

  it('模型不在该渠道清单时抛错，信息写明这一种', () => {
    const config = { ...base(), model: 'not-listed' };
    expect(() => loadChannelConfig(config)).toThrow(new ConfigError('模型不在该渠道清单：not-listed'));
  });

  it('协议和壳不配时抛错，信息写明这一种', () => {
    const config = base();
    config.channels = [
      {
        name: 'gateway-a',
        protocol: 'openai',
        models: ['glm-5.3'],
        secretEnv: 'GATEWAY_A_TOKEN',
      },
    ];
    expect(() => loadChannelConfig(config)).toThrow(new ConfigError('协议和壳不配：openai 与 claude-code'));
  });

  it('密钥环境变量名缺时抛错，信息写明这一种', () => {
    const config = base();
    config.channels = [{ name: 'gateway-a', protocol: 'anthropic', models: ['glm-5.3'] }];
    expect(() => loadChannelConfig(config)).toThrow(new ConfigError('密钥环境变量名缺：gateway-a'));
  });

  it('合法的最小配置不抛错，渠道名、模型名和壳与配置原文一致', () => {
    const config: ChannelConfig = {
      channels: [
        {
          name: 'gateway-a',
          protocol: 'anthropic',
          models: ['glm-5.3'],
          secretEnv: 'GATEWAY_A_TOKEN',
        },
      ],
      channel: 'gateway-a',
      model: 'glm-5.3',
      shell: 'claude-code',
    };
    const loaded = loadChannelConfig(config);
    expect(loaded.channel).toBe(config.channel);
    expect(loaded.model).toBe(config.model);
    expect(loaded.shell).toBe(config.shell);
  });
});
