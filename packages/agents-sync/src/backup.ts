// 备份：动别人的东西之前先留一份。放 ~/.fleet-dao/backups/<时间>/，照原来相对家目录的路径摆；
// 链接没法「拷一份」，记进同一目录的 links.json（链接在哪、指向哪），要恢复照着重建。
// 不放进各家会扫的目录（放在 ~/.claude 底下，Claude 会把备份的旧规矩也读进去）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Platform, placeOn, STATE_DIR } from './targets.ts';

export interface LinkRecord {
  /** 相对家目录，/ 分隔 */
  path: string;
  target: string;
}

export class Backups {
  #dir: string | undefined;
  readonly #root: string;
  readonly #stamp: string;

  constructor(home: string, platform: Platform, now: Date) {
    this.#root = join(home, placeOn(STATE_DIR, platform), 'backups');
    this.#stamp = now.toISOString().replace(/[:.]/g, '-');
  }

  /** 这一次的备份目录；第一次用到才建，同一秒里跑两次就加后缀，不混进上一次的 */
  get dir(): string {
    if (this.#dir === undefined) {
      let dir = join(this.#root, this.#stamp);
      for (let i = 2; existsSync(dir); i++) dir = join(this.#root, `${this.#stamp}-${i}`);
      mkdirSync(dir, { recursive: true });
      this.#dir = dir;
    }
    return this.#dir;
  }

  /** 拷一份文件；rel 是相对家目录的路径（/ 分隔）。返回备份的位置 */
  saveFile(abs: string, rel: string): string {
    const dest = join(this.dir, ...rel.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    return dest;
  }

  /** 记下一个链接；返回记在哪个文件里 */
  recordLink(record: LinkRecord): string {
    const file = join(this.dir, 'links.json');
    const list: LinkRecord[] = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as LinkRecord[])
      : [];
    list.push(record);
    writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
    return file;
  }
}
