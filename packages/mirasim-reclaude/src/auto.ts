import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeLock } from './lock.ts';
import { atomicJson, type MigrationOptions, type MigrationResult, migrate } from './migrate.ts';

interface WorkerRecord {
  schema: 1;
  pid: number;
  state: string;
  nonce?: string;
  updatedAt?: string;
}

export function workerFile(home: string): string {
  return join(home, '.fleet-dao', 'mirasim-reclaude', 'worker.json');
}

export function readWorker(home: string): WorkerRecord | undefined {
  const file = workerFile(home);
  if (!existsSync(file)) return undefined;
  let data: WorkerRecord;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('迁移后台记录读取失败');
  }
  if (data.schema !== 1 || !Number.isInteger(data.pid) || data.pid < 1 || typeof data.state !== 'string')
    throw new Error('迁移后台记录格式错误');
  return data;
}

export function workerAlive(record: WorkerRecord | undefined): boolean {
  if (!record || !['starting', 'waiting'].includes(record.state)) return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error('已有迁移进程的状态无法确认');
  }
}

function psString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}
function windowsArg(text: string): string {
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function spawnWorker(o: MigrationOptions): number {
  const cli = fileURLToPath(new URL('../bin/migrate', import.meta.url));
  const args = [cli, '--worker', '--managed-only', '--wait-idle', '--home', o.home, '--repo', o.repo];
  if (process.platform === 'win32') {
    const root = join(o.home, '.fleet-dao', 'mirasim-reclaude');
    const result = join(root, `spawn-${randomUUID()}.txt`);
    const line = args.map(windowsArg).join(' ');
    // 不序列化环境变量；子进程继承用户环境，PID 经文件返回避免孙进程继承输出管道。
    const script = `$migrationProcess = Start-Process -FilePath ${psString(process.execPath)} -ArgumentList ${psString(line)} -WindowStyle Hidden -PassThru -RedirectStandardOutput ${psString(join(root, 'worker.log'))} -RedirectStandardError ${psString(join(root, 'worker.err'))}; Set-Content -LiteralPath ${psString(result)} -Value ([string]$migrationProcess.Id) -Encoding ASCII`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000,
    });
    const pid = Number(readFileSync(result, 'utf8').trim());
    if (!Number.isInteger(pid) || pid < 1) throw new Error('后台迁移未返回确认的进程编号');
    return pid;
  }
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  if (!child.pid) throw new Error('后台迁移启动失败');
  child.unref();
  return child.pid;
}

export async function automaticMigration(o: MigrationOptions): Promise<MigrationResult> {
  if (o.platform === 'linux') return migrate({ ...o, auto: true, check: true });
  const release = takeLock(o.home, 'worker');
  if (!release)
    return {
      state: 'waiting',
      command: '',
      recordFile: workerFile(o.home),
      detail: '自动迁移正在安排中，不重复启动',
    };
  try {
    return await schedule(o);
  } finally {
    release();
  }
}

async function schedule(o: MigrationOptions): Promise<MigrationResult> {
  const existing = readWorker(o.home);
  if (workerAlive(existing))
    return {
      state: 'waiting',
      command: '',
      recordFile: workerFile(o.home),
      detail: '已有后台迁移在等待空闲，不重复启动',
    };
  const result = await migrate({ ...o, auto: true, check: true, wait: false });
  if (result.state !== 'waiting' || o.platform === 'linux') return result;
  const nonce = randomUUID();
  atomicJson(workerFile(o.home), {
    schema: 1,
    pid: process.pid,
    state: 'starting',
    nonce,
    updatedAt: new Date().toISOString(),
  });
  try {
    const pid = spawnWorker(o);
    const current = readWorker(o.home);
    if (current?.nonce === nonce && current.state === 'starting')
      atomicJson(workerFile(o.home), {
        schema: 1,
        pid,
        state: 'waiting',
        nonce,
        updatedAt: new Date().toISOString(),
      });
    return { ...result, detail: '已安排后台迁移；当前回合继续，空闲后自动更新' };
  } catch {
    atomicJson(workerFile(o.home), {
      schema: 1,
      pid: process.pid,
      state: 'failed',
      nonce,
      updatedAt: new Date().toISOString(),
    });
    throw new Error('后台迁移没能确认启动；旧接入未更改');
  }
}
