import { spawn } from 'node:child_process';
import { stopProcessTree } from './cursor-process.mjs';
import { cursorAgentEnv } from './tools.mjs';

// 这些只是偏好；每次执行必须先与当前账号的真实列表求交。
export const MODELS = {
  gpt: 'gpt-5.6-luna-high',
  kimi: 'kimi-k3-low',
  glm: 'glm-5.2-high',
  grok: 'grok-4.7-low-fast',
};
const FAMILIES = {
  gpt: /^(?:cursor-)?gpt-/,
  kimi: /^kimi-/,
  glm: /^glm-/,
  grok: /^(?:cursor-)?grok-/,
};

export function parseModels(text) {
  // 只认机器 id，显示名不能把 auto/composer/其他厂商伪装成 GPT。
  const plain = text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
  if (!/^Available models\s*$/m.test(plain)) throw new Error('Cursor 型号列表格式认不出');
  const ids = [...plain.matchAll(/^([a-z][a-z0-9.-]*) - .+$/gm)].map((m) => m[1]);
  if (!ids.length) throw new Error('Cursor 型号列表没有可识别的 id');
  return [...new Set(ids)];
}

export function resolveModel(family, available) {
  if (!Object.hasOwn(FAMILIES, family)) throw new Error(`不认识的模型 ${family}`);
  const candidates = available.filter((id) => FAMILIES[family].test(id));
  return candidates.includes(MODELS[family]) ? MODELS[family] : (candidates[0] ?? null);
}

/** 现读当前 Cursor 账号；不缓存，不跨渠道拼名单。查询超时也必须收完整个子树。 */
export function readCursorModels({ spawnFn = spawn, stopTree = stopProcessTree, timeoutMs = 10_000 } = {}) {
  return new Promise((done, reject) => {
    const child = spawnFn('cursor-agent', ['models'], {
      windowsHide: true,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
      env: cursorAgentEnv(),
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
    let stdout = '',
      stderr = '',
      startError,
      closeTimer;
    let timedOut = false,
      settled = false;
    const finish = (error, models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      if (error) reject(error);
      else done(models);
    };
    const unconfirmed = (reason) => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(new Error(`Cursor 型号列表查询超时；进程树收尾没查成：${reason}`));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        stopTree(child);
      } catch (e) {
        unconfirmed(e instanceof Error ? e.message : String(e));
        return;
      }
      closeTimer = setTimeout(() => unconfirmed('终止后输出管道仍未关闭'), 2000);
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (e) => {
      startError = e.message;
    });
    child.on('close', (code) => {
      if (timedOut) return finish(new Error('Cursor 型号列表查询超时，已终止进程树并关闭输出'));
      if (startError) return finish(new Error(`Cursor 型号列表起不来：${startError}`));
      if (code !== 0)
        return finish(new Error(`Cursor 型号列表读取失败（退出码 ${code}）：${stderr.trim().slice(0, 200)}`));
      try {
        finish(null, parseModels(stdout));
      } catch (e) {
        finish(e);
      }
    });
  });
}
