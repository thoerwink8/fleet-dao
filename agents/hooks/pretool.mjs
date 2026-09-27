// PreToolUse 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，Claude Code 每次调 Bash、PowerShell 之前跑）：拦住绕过仓里脚本、
// 会把本机会话全弄断的命令。只是止血：正式的强制点在仓里（packages/conventions、卫生检查），这里挡的是会话自己手滑。
// 协议：stdin 一份 JSON（tool_name、tool_input.command、cwd）；退出码 2 = 拦下，stderr 给模型看；0 = 放行。
// 输入认不出一律按拦处理（退出码 2），不当成没事放行。
// 规矩本身由 agents/test/rules/pretool.rules.test.ts 钉住：改这里的判断改了规矩，那边会红。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// bash 里反引号是「先把里面当命令跑」（命令替换）：只有单引号里、带引号的 heredoc（<<'EOF'）里才是普通字符。
// 双引号里、不带引号、不带引号的 heredoc 里出现没转义的反引号，就返回 true。
// 认 $( ) 套在双引号里的写法（git commit -m "$(cat <<'EOF' … EOF)" 这种不误拦）；算术 << 之类极少见的写法认错时只会漏拦、不会误拦。
export function bashBacktickSubst(cmd) {
  const s = String(cmd).replace(/\r\n/g, '\n');
  const n = s.length;
  const stack = [{ k: 'none', d: 0 }];
  const pending = [];
  let i = 0;
  while (i < n) {
    const f = stack[stack.length - 1];
    const c = s[i];
    if (f.k === 'sq') {
      if (c === "'") stack.pop();
      i++;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return true;
    if (c === '$' && s[i + 1] === '(') {
      stack.push({ k: 'none', d: 0 });
      i += 2;
      continue;
    }
    if (f.k === 'dq') {
      if (c === '"') stack.pop();
      i++;
      continue;
    }
    if (c === "'") {
      stack.push({ k: 'sq' });
      i++;
      continue;
    }
    if (c === '"') {
      stack.push({ k: 'dq' });
      i++;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      i += 2;
      while (i < n && s[i] !== "'") i += s[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(') {
      f.d++;
      i++;
      continue;
    }
    if (c === ')') {
      if (f.d > 0) f.d--;
      else if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] === '<') {
      i += 3;
      continue;
    }
    if (c === '<' && s[i + 1] === '<') {
      let j = i + 2;
      const strip = s[j] === '-';
      if (strip) j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      let delim = '';
      let quoted = false;
      while (j < n && !/[\s;&|<>()]/.test(s[j])) {
        const d = s[j];
        if (d === "'" || d === '"') {
          quoted = true;
          j++;
          while (j < n && s[j] !== d) delim += s[j++];
          j++;
        } else if (d === '\\') {
          quoted = true;
          delim += s[j + 1] ?? '';
          j += 2;
        } else delim += s[j++];
      }
      if (delim) pending.push({ delim, quoted, strip });
      i = j;
      continue;
    }
    if (c === '\n' && pending.length > 0) {
      i++;
      for (const h of pending.splice(0)) {
        while (i < n) {
          let e = s.indexOf('\n', i);
          if (e === -1) e = n;
          const line = s.slice(i, e);
          i = e + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          if (!h.quoted && /(^|[^\\])`/.test(line)) return true;
        }
      }
      continue;
    }
    i++;
  }
  return false;
}

const block = (message) => ({ code: 2, message });

/**
 * 跑命令的工具在各家叫什么。登记在 ~/.claude/settings.json 的这条钩子，Grok、Devin、Cursor 默认也借道读，
 * 送进来的是它们自己的工具名：Grok 是 run_terminal_command（输入是 camelCase 的 toolName、toolInput），Devin 是 exec，
 * Cursor 是 Shell。bash 语法的检查（反引号）只对确定是 bash 的 Bash 做：别家的终端在 Windows 上未必是 bash。
 */
export const SHELL_TOOLS = {
  Bash: 'bash',
  PowerShell: 'powershell',
  run_terminal_command: 'shell',
  exec: 'shell',
  Shell: 'shell',
};

/** 判一条钩子输入（原文）：{ code: 0 } 放行，{ code: 2, message } 拦下。 */
export function decide(raw, fallbackCwd = '') {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return block('fleet-guard：钩子输入不是 JSON，按拦处理');
  }
  const tool = input?.tool_name ?? input?.toolName;
  const kind = typeof tool === 'string' && Object.hasOwn(SHELL_TOOLS, tool) ? SHELL_TOOLS[tool] : undefined;
  if (kind === undefined) {
    return block(`fleet-guard：钩子输入里认不出工具名（${JSON.stringify(tool)}），按拦处理`);
  }
  const command = input?.tool_input?.command ?? input?.toolInput?.command ?? input?.command;
  if (typeof command !== 'string') {
    return block(`fleet-guard：${tool} 的输入里认不出命令（${JSON.stringify(command)}），按拦处理`);
  }
  const cmd = command;
  const cwd = String(input?.cwd ?? input?.workspaceRoot ?? fallbackCwd)
    .split('\\')
    .join('/')
    .toLowerCase();
  const inFleet = cwd.includes('fleet-dao') || /fleet-dao/i.test(cmd);
  // 2026-09-26 撞过两回：子代理拼命令时反引号误跑了切号登录；总指挥 node -e "…`specs/…/需求.md`…" 把整份需求文档当脚本执行了。
  // PowerShell 里反引号是转义符，不归这条管；别家的终端是不是 bash 说不准，也不管。不分仓，全机都拦。
  if (kind === 'bash' && bashBacktickSubst(cmd)) {
    return block(
      "这条 bash 命令里有会被当成命令执行的反引号（在双引号里、没加引号、或 <<EOF 不带引号的 heredoc 里）：bash 会先把反引号里的内容当命令跑掉。Markdown 的 `代码` 写法放进单引号里、用 <<'EOF' 的 heredoc，或者先用 Write 写进文件再用 --body-file / -F / 读文件；真要取命令输出用 $(…)。",
    );
  }
  // -R/--repo 指到 fleet-dao 以外的仓（比如巡检仓 fleet-dao-canary 的验收单）不归 issue:new 管，放行
  const repoFlag = /(?:^|\s)(?:-R|--repo)[\s=]+['"]?([^\s'"]+)/.exec(cmd)?.[1];
  const otherRepo = repoFlag !== undefined && !/(?:^|\/)fleet-dao$/i.test(repoFlag);
  if (inFleet && /\bgh\s+issue\s+create\b/.test(cmd) && !otherRepo) {
    return block(
      'fleet-dao 开单一律用 `pnpm issue:new --kind <需求|缺陷|杂项> --milestone <版本全名|v<N>|未排期> --specs`（母单加 --mother），不直接 gh issue create（会漏类别标签、里程碑、需求文档）。',
    );
  }
  // 本机有 Claude 会话在跑时，在本机切号、登录、退出会让所有会话当场断掉（全局规矩「我的机器与模型」）。
  // 经 ssh 到别的机器上跑的放行。不分仓，全机都拦。
  // ssh 开头也不放行反引号、$( ) 里的：本机 bash 会先把它们执行掉，根本到不了远端。
  const rc = String.raw`\breclaude\s+(?:login|logout|org\s+use)\b`;
  const localSubst = new RegExp(String.raw`\x60[^\x60]*${rc}[^\x60]*\x60|\$\([^)]*${rc}`);
  if (new RegExp(rc).test(cmd) && (!/^\s*ssh\s/.test(cmd) || localSubst.test(cmd))) {
    return block(
      "本机有 Claude 会话在跑：不许在本机跑 reclaude login / logout / org use（会让本机所有会话当场断掉）。要切号请创始人自己来；要在别的机器上跑，用 ssh <机器> '…'。",
    );
  }
  // stash 栈是整个仓（所有工作树）共用一个：两个会话同时 stash/pop 会拿到对方的改动（2026-09-26 撞过）
  if (inFleet && /\bgit\b[^|;&\n]*\sstash\b(?!\s+(?:list|show)\b)/.test(cmd)) {
    return block(
      'fleet-dao 里不用 git stash：stash 栈所有工作树共用，并行会话会互相拿错改动。临时存改动用 `git diff > 文件` / `git apply 文件`，或先提交到自己分支。',
    );
  }
  return { code: 0 };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (err) {
    process.stderr.write(`fleet-guard：读不到钩子输入（${err?.code ?? err}），按拦处理\n`);
    process.exit(2);
  }
  // Devin 的输入里没有会话目录：钩子进程的工作目录就是会话目录
  const verdict = decide(raw, process.cwd());
  if (verdict.code !== 0) process.stderr.write(`${verdict.message}\n`);
  process.exit(verdict.code);
}
