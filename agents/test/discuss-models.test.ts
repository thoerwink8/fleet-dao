import { type SpawnOptions, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

interface Models {
  parseModels(text: string): string[];
  resolveModel(family: string, ids: string[]): string | null;
  readCursorModels(deps: { spawnFn: typeof spawn; timeoutMs?: number }): Promise<string[]>;
}
const models = (await import(
  pathToFileURL(fileURLToPath(new URL('../skills/discuss/scripts/cursor-models.mjs', import.meta.url))).href
)) as Models;

it('只读机器 id，兼容 CRLF/ANSI/重复项，显示标签不能改变厂商', () => {
  const ids = models.parseModels(
    '\x1b[32mAvailable models\x1b[0m\r\nauto - GPT\r\ncomposer-2.5 - GPT\r\ngrok-current-low - GPT\r\ngrok-current-low - Duplicate\r\ngpt-evil;command - GPT\r\n',
  );
  expect(ids).toEqual(['auto', 'composer-2.5', 'grok-current-low']);
  expect(models.resolveModel('gpt', ids)).toBeNull();
  expect(models.resolveModel('grok', ids)).toBe('grok-current-low');
});

it('偏好必须在真实列表中；缺失时只选同族，未知族与auto不可作为family', () => {
  expect(models.resolveModel('gpt', ['gpt-current-high', 'gpt-5.6-luna-high'])).toBe('gpt-5.6-luna-high');
  expect(models.resolveModel('gpt', ['grok-current-high', 'gpt-current-high'])).toBe('gpt-current-high');
  expect(models.resolveModel('gpt', ['auto', 'composer-2.5', 'grok-current-high'])).toBeNull();
  expect(() => models.resolveModel('auto', ['auto'])).toThrow('不认识');
  expect(() => models.resolveModel('__proto__', ['gpt-current-high'])).toThrow('不认识');
  expect(() => models.parseModels('Available models\n')).toThrow('没有可识别');
});

const fake = (code: string) =>
  ((_file: string, args: string[], options: SpawnOptions) => {
    expect(args).toEqual(['models']);
    return spawn(process.execPath, ['-e', code], { ...options, shell: false });
  }) as typeof spawn;

it('真实子进程读能力列表，非零不能使用stdout冒充查成', async () => {
  const text = JSON.stringify('Available models\ngpt-current-high - GPT\n');
  expect(await models.readCursorModels({ spawnFn: fake(`process.stdout.write(${text})`) })).toEqual([
    'gpt-current-high',
  ]);
  await expect(
    models.readCursorModels({ spawnFn: fake(`process.stdout.write(${text});process.exitCode=7`) }),
  ).rejects.toThrow('退出码 7');
});

it('能力查询超时先停执行体并关闭输出才报失败，不回退到缓存', async () => {
  let child: ReturnType<typeof spawn> | undefined;
  let closed = false;
  const spawnFn = ((_file: string, _args: string[], options: SpawnOptions) => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, shell: false });
    child.once('close', () => {
      closed = true;
    });
    return child;
  }) as typeof spawn;
  try {
    await expect(models.readCursorModels({ spawnFn, timeoutMs: 300 })).rejects.toThrow(
      '已终止进程树并关闭输出',
    );
    expect(closed).toBe(true);
  } finally {
    if (child?.pid && !closed) child.kill('SIGKILL');
  }
});
