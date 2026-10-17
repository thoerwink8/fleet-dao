import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

const ROOT = join(import.meta.dirname, '..');
const lib = await import(pathToFileURL(join(ROOT, 'hooks', 'background-launch.mjs')).href);
const made: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'background-launch-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function finished(path: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = lib.backgroundState(path);
    const pointer = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number };
    if (state.kind !== 'running' && !lib.processAlive(pointer.pid)) return state;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('测试后台没有在上限内结束');
}

describe('钩子后台的真实环境和运行证据', () => {
  it('调用方被杀整棵树后，共用 worker 和任务仍活着；清理只结束自建测试进程', async () => {
    const home = temp();
    const statePath = join(home, 'run.json');
    const output = join(home, 'task.json');
    const parentScript = join(home, 'parent.mjs');
    const code =
      'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,arg:process.argv[2]}));setInterval(()=>{},10000)';
    writeFileSync(
      parentScript,
      `import {launchBackground,backgroundEnv} from ${JSON.stringify(pathToFileURL(join(ROOT, 'hooks', 'background-launch.mjs')).href)}; const r=launchBackground({args:${JSON.stringify(['-e', code, output, 'keep me'])},cwd:${JSON.stringify(home)},env:backgroundEnv(${JSON.stringify(home)}),statePath:${JSON.stringify(statePath)},timeoutMs:30000}); if(!r.ok) throw new Error(r.why);setInterval(()=>{},10000);`,
    );
    const win = process.platform === 'win32';
    const parent = spawn(process.execPath, [parentScript], {
      stdio: 'ignore',
      windowsHide: true,
      detached: !win,
    });
    let workerPid: number | undefined;
    let taskPid: number | undefined;
    try {
      const deadline = Date.now() + 20_000;
      while (!existsSync(output) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
      expect(existsSync(output)).toBe(true);
      workerPid = (JSON.parse(readFileSync(statePath, 'utf8')) as { pid: number }).pid;
      const task = JSON.parse(readFileSync(output, 'utf8')) as { pid: number; arg: string };
      taskPid = task.pid;
      if (!parent.pid) throw new Error('测试父进程没起成');
      if (win) expect(runChild('taskkill', ['/PID', String(parent.pid), '/T', '/F']).status).toBe(0);
      else process.kill(-parent.pid, 'SIGKILL');
      expect(lib.processAlive(workerPid)).toBe(true);
      expect(lib.processAlive(taskPid)).toBe(true);
      expect(task.arg).toBe('keep me');
    } finally {
      if (taskPid && lib.processAlive(taskPid)) process.kill(taskPid);
      if (existsSync(statePath)) await finished(statePath);
      for (const pid of [workerPid, parent.pid]) if (pid && lib.processAlive(pid)) process.kill(pid);
    }
  }, 45_000);

  it('WMI / setsid 显式传 home、状态目录和备用代理，密钥不传不落盘', async () => {
    const home = temp();
    mkdirSync(join(home, '.fleet-dao'));
    writeFileSync(join(home, '.fleet-dao', 'fallback-proxy'), 'http://127.0.0.1:9876\n');
    const env = lib.backgroundEnv(home, {
      env: {
        ...process.env,
        GH_TOKEN: 'test-secret-never-copy',
        FLEET_UNATTENDED_DIR: join(home, 'unattended'),
      },
      stateHome: join(home, 'fleet-state'),
    });
    const output = join(home, 'env.json');
    const statePath = join(home, 'run.json');
    const args = [
      '-e',
      'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,state:process.env.FLEET_DAO_HOME,dir:process.env.FLEET_UNATTENDED_DIR,proxy:process.env.HTTPS_PROXY,token:process.env.GH_TOKEN}))',
      output,
      'a b',
      'q"x',
      'tail\\',
      '',
    ];
    const started = lib.launchBackground({ args, cwd: home, env, statePath, timeoutMs: 20_000 });
    expect(started.ok, started.why).toBe(true);
    const completed = await finished(statePath);
    expect(completed.kind, completed.why).toBe('done');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
      args: ['a b', 'q"x', 'tail\\', ''],
      home,
      state: join(home, 'fleet-state'),
      dir: join(home, 'unattended'),
      proxy: 'http://127.0.0.1:9876',
    });
    expect(readFileSync(statePath, 'utf8')).not.toContain('test-secret');
    expect(env).not.toHaveProperty('GH_TOKEN');
  }, 45_000);

  it('早退和超时都留下失败回执；超时结束本任务子进程', async () => {
    for (const timeout of [false, true]) {
      const home = temp();
      const childPid = join(home, 'child.pid');
      const statePath = join(home, 'run.json');
      const code = timeout
        ? 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},10000)'
        : 'process.exit(7)';
      const started = lib.launchBackground({
        args: ['-e', code, childPid],
        cwd: home,
        env: lib.backgroundEnv(home),
        statePath,
        timeoutMs: 1000,
      });
      expect(started.ok, started.why).toBe(true);
      const state = await finished(statePath);
      expect(state.kind).toBe('failed');
      expect(state.why).toMatch(timeout ? /超过 1000 毫秒/ : /退出码 7/);
      if (timeout) expect(lib.processAlive(Number(readFileSync(childPid, 'utf8')))).toBe(false);
    }
  }, 60_000);

  it.skipIf(process.platform !== 'win32')(
    'PATH 不含系统命令时超时仍结束自建父子树',
    async () => {
      const home = temp();
      const statePath = join(home, 'run.json');
      const output = join(home, 'pids.json');
      const emptyBin = join(home, 'empty-bin');
      mkdirSync(emptyBin);
      const limitedEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'),
      );
      limitedEnv.PATH = emptyBin;
      const env = lib.backgroundEnv(home, { env: limitedEnv });
      const code =
        'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},10000)"],{stdio:"ignore",windowsHide:true});require("node:fs").writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},10000)';
      const started = lib.launchBackground({
        args: ['-e', code, output],
        cwd: home,
        env,
        statePath,
        timeoutMs: 1500,
      });
      expect(started.ok, started.why).toBe(true);
      try {
        const state = await finished(statePath);
        expect(state.kind).toBe('failed');
        expect(state.why).toMatch(/超过 1500 毫秒，已结束本任务子树/);
        const pids = JSON.parse(readFileSync(output, 'utf8')) as number[];
        expect(pids).toHaveLength(2);
        for (const pid of pids) expect(lib.processAlive(pid), `测试子树进程 ${pid} 仍活着`).toBe(false);
      } finally {
        if (existsSync(output))
          for (const pid of JSON.parse(readFileSync(output, 'utf8')) as number[])
            if (lib.processAlive(pid)) process.kill(pid);
        if (started.pid && lib.processAlive(started.pid)) process.kill(started.pid);
      }
    },
    45_000,
  );

  it('启动失败不写已起记录；死 PID 与无回执超时不能算在跑', () => {
    const home = temp();
    const statePath = join(home, 'run.json');
    const result = lib.launchBackground({
      args: [],
      cwd: home,
      env: {},
      statePath,
      timeoutMs: 1000,
      spawnFn: () => ({ ok: false, why: 'WMI denied' }),
    });
    expect(result).toEqual({ ok: false, why: 'WMI denied' });
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).not.toHaveProperty('startedAt');
    const receipt = join(home, 'absent.json');
    writeFileSync(statePath, JSON.stringify({ startedAt: 100, pid: 123, timeoutMs: 1000, receipt }));
    expect(lib.backgroundState(statePath, { now: 200, alive: () => false }).why).toMatch(/早退/);
    expect(lib.backgroundState(statePath, { now: 40_000, alive: () => true }).why).toMatch(/超时/);
  });

  it('安装副本用随钩子分发的原语，不依赖 local-sessions/bin', async () => {
    const dir = temp();
    const hooks = join(dir, 'hooks');
    cpSync(join(ROOT, 'hooks'), hooks, { recursive: true });
    cpSync(join(ROOT, 'local-sessions', 'detach.mjs'), join(hooks, '_detach.mjs'));
    expect(existsSync(join(dir, 'local-sessions'))).toBe(false);
    const script = `const lib = await import(${JSON.stringify(pathToFileURL(join(hooks, 'background-launch.mjs')).href)}); console.log(lib.launchBackground({args:['-e','process.exit(0)'],cwd:${JSON.stringify(dir)},env:lib.backgroundEnv(${JSON.stringify(dir)}),statePath:${JSON.stringify(join(dir, 'run.json'))},timeoutMs:10000}).ok)`;
    const r = runChild(process.execPath, ['--input-type=module', '-e', script]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('true');
    const state = await finished(join(dir, 'run.json'));
    expect(state.kind, state.why).toBe('done');
  }, 30_000);
});

import { spawn } from 'node:child_process';
