// 法国上的管理命令入口（packages/api/bin/fleet-api）要和 fleet-api.service 带同一组环境文件：
// 只带 api.env 时 session-mint 读不到 session-secret.env 里的会话密钥（#1800 上线后第一次跑就碰上）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wrapper = readFileSync(new URL('../bin/fleet-api', import.meta.url), 'utf8');
const unit = readFileSync(new URL('../../../deploy/france/fleet-api.service', import.meta.url), 'utf8');

const envLines = (text: string) => [...text.matchAll(/^EnvironmentFile=.+$/gm)].map((m) => m[0]);

describe('fleet-api 入口脚本的环境文件', () => {
  it('清单取自同一版的 fleet-api.service，不在脚本里另写一份', () => {
    expect(wrapper).toContain('deploy/france/fleet-api.service');
    expect(wrapper).toContain("grep -E '^EnvironmentFile='");
    expect(wrapper).not.toMatch(/-p EnvironmentFile=\//);
  });

  it('服务单元里有会话密钥那一份，入口照搬就带得上', () => {
    const lines = envLines(unit);
    expect(lines).toContain('EnvironmentFile=/etc/fleet-dao/session-secret.env');
    expect(lines).toContain('EnvironmentFile=/etc/fleet-dao/api.env');
  });

  it('单元文件读不到、一条都没有就停，不拿半份环境去跑', () => {
    expect(wrapper).toMatch(/if \[\[ \$\{#env_args\[@\]\} -eq 0 \]\]; then[\s\S]*?exit 1/);
  });
});
