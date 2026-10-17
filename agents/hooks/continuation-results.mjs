// Stop 同步把本会话派出的工人终态放进续轮提示。Codex async hook 不会启动新轮，不能借用 Claude asyncRewake。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { endedOf, runsRootOf } from './work-watch.mjs';

/** @param {string} sessionId @param {NodeJS.ProcessEnv} [env] */
export function completedRuns(sessionId, env = process.env) {
  const root = runsRootOf(env, homedir());
  /** @type {{ key: string, text: string }[]} */
  const results = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return results;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let spec;
    try {
      spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
    } catch (err) {
      throw new Error(`工人记录 ${dir} 没查成：${String(err)}`);
    }
    if (spec.dispatcher !== sessionId) continue;
    const end = endedOf(dir, Date.now());
    if (!end) continue;
    results.push({
      key: createHash('sha256')
        .update(JSON.stringify([dir, end]))
        .digest('hex'),
      text: end.text,
    });
  }
  return results;
}
