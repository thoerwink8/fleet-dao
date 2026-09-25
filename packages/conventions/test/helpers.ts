// 测试用的内存假仓：键是仓内路径，值是文件内容；键以 / 结尾表示一个空目录。
import type { RepoView } from '../src/repo.ts';

export function memRepo(files: Record<string, string>): RepoView {
  const texts = new Map<string, string>();
  const dirs = new Set<string>(['']);
  for (const [key, text] of Object.entries(files)) {
    const path = key.replace(/\/+$/, '');
    const segs = path.split('/');
    if (key.endsWith('/')) dirs.add(path);
    else texts.set(path, text);
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  const clean = (rel: string) => rel.replace(/\/+$/, '');
  return {
    read: (rel) => texts.get(clean(rel)),
    exists: (rel) => texts.has(clean(rel)) || dirs.has(clean(rel)),
    isDir: (rel) => dirs.has(clean(rel)),
    list(rel) {
      const dir = clean(rel);
      if (!dirs.has(dir)) return undefined;
      const prefix = dir ? `${dir}/` : '';
      const names = new Set<string>();
      for (const p of [...texts.keys(), ...dirs]) {
        if (p && p !== dir && p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0] ?? '');
      }
      return [...names];
    },
  };
}
