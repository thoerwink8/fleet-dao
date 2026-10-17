// 决定 0083：引导中继删了。不再读 diag 的 turn.steer，不再起 ui-cli，不再为 Mirasim 引导拒工具或挡收尾。
// 先回规则和原生后台重启提示保留，重复投递模块退役。
// 引擎无头会话设 FLEET_HEADLESS=1，项目级流程钩子直接退出。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runChild } from '../child.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const codeOf = (rel: string) => read(rel).replace(/^\s*\/\/.*$/gm, '');

const MAIN = fileURLToPath(new URL('../../hooks/main-thread.mjs', import.meta.url));
const STOP = fileURLToPath(new URL('../../hooks/stop.mjs', import.meta.url));
const START = fileURLToPath(new URL('../../hooks/session-start.mjs', import.meta.url));
const LOG = fileURLToPath(new URL('../../hooks/prompt-log.mjs', import.meta.url));
const BOOT = fileURLToPath(new URL('../../hooks/bootstrap.mjs', import.meta.url));

describe('引导中继已删（决定 0083）', () => {
  it('主对话钩子和收尾钩子不再取原文、不再拒这次调用去转引导', () => {
    for (const rel of ['../../hooks/main-thread.mjs', '../../hooks/stop.mjs']) {
      const code = codeOf(rel);
      expect(code, rel).not.toMatch(/turn\.steer/);
      expect(code, rel).not.toMatch(/ui-cli/);
      expect(code, rel).not.toMatch(/steerRelay/);
      expect(code, rel).not.toMatch(/takeSteers/);
    }
    for (const rel of [
      '../../hooks/main-thread.mjs',
      '../../hooks/session-start.mjs',
      '../../hooks/founder-inbox.mjs',
      '../../hooks/work-watch.mjs',
    ])
      expect(codeOf(rel)).not.toMatch(/from ['"][^'"]*(?:inbox-tick|inbox-watch|steer-shown)/);
  });

  it('【故意造出的失败】把取原文写回去：上一条查得出', () => {
    const back = `${codeOf('../../hooks/main-thread.mjs')}\nfunction takeSteers() { return 'ui-cli'; }\n`;
    expect(back).toMatch(/takeSteers/);
    expect(back).toMatch(/ui-cli/);
  });

  it('引擎无头会话（FLEET_HEADLESS=1）流程钩子和订阅加载器都直接退出、不说话', () => {
    const LOADER = fileURLToPath(new URL('../../hooks/plugin-loader.mjs', import.meta.url));
    for (const hook of [MAIN, STOP, START, LOG, BOOT, LOADER]) {
      const r = runChild(process.execPath, [hook], {
        input: '{}',
        env: { ...process.env, FLEET_HEADLESS: '1' },
      });
      expect(r.status, hook).toBe(0);
      expect(r.stdout, hook).toBe('');
    }
  });
});
