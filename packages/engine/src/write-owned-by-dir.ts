// root 跑的升级入口往 fleet 的目录里写状态文件：写完把属主改成所在目录的属主，不留 root 属主的文件
// （france.sh 读回见到 root 属主的文件判红，整套就不记已装版本）。目录自己归 root 时不改。
import { chown, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ChownFn = (path: string, uid: number, gid: number) => Promise<void>;

export async function writeAtomicOwnedByDir(
  file: string,
  text: string,
  chownFn: ChownFn = chown,
): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o644 });
  const owner = await stat(dir);
  if (owner.uid !== 0) await chownFn(tmp, owner.uid, owner.gid);
  await rename(tmp, file);
}
