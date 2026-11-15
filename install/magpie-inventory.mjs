#!/usr/bin/env node
// 只读。从配置目录汇总路由组、轮流、资源库、设置和用量。不打印密钥、邮箱、账号 ID。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SECRET_FIELD =
  /^(apiKey|token|secret|password|passphrase|authorization|cookie|email|accessToken|refreshToken|key)$/i;
const SECRET_TEXT = /^(?:sk-|github_pat_|ghp_|Bearer )/;
const DAY = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const out = { config: null, selfTest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--config') out.config = need(argv, ++i, arg);
    else throw new Error(`不认识的参数 ${arg}`);
  }
  return out;
}

function need(argv, index, flag) {
  if (index >= argv.length) throw new Error(`${flag} 缺少值`);
  return argv[index];
}

function defaultConfig() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg?.trim() ? xdg.trim() : join(homedir(), '.config');
  return join(base, 'magpie');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function memberName(value) {
  const raw = typeof value === 'string' ? value : value && (value.model || value.id || value.name);
  if (typeof raw !== 'string' || !raw) return '成员';
  const base = raw.split('#')[0];
  if (EMAIL.test(base) || SECRET_TEXT.test(base)) return '成员';
  return base;
}

function weightText(weights) {
  if (!weights || typeof weights !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(weights)) {
    if (typeof value !== 'number') continue;
    parts.push(`${memberName(key)}=${value}`);
  }
  return parts.join('，');
}

function summarizeGroups(groups) {
  const lines = ['## 路由组', ''];
  if (!Array.isArray(groups) || !groups.length) {
    lines.push('没有路由组。', '');
    return lines;
  }
  lines.push('| 组 | 成员 | 路由方式 | 权重 |');
  lines.push('|---|---|---|---|');
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const id = typeof group.id === 'string' ? group.id : group.name;
    const members = Array.isArray(group.members) ? group.members.map(memberName).join('、') : '';
    const routing = typeof group.routing === 'string' ? group.routing : '';
    const weights = weightText(group.weights);
    const fast = Array.isArray(group.fast) ? group.fast.map(memberName).join('、') : '';
    const weightCell = fast ? `${weights}；fast=${fast}` : weights;
    lines.push(`| ${id || ''} | ${members} | ${routing} | ${weightCell} |`);
  }
  lines.push('');
  return lines;
}

function summarizeProviders(providers) {
  const lines = ['## 供应商', ''];
  if (!Array.isArray(providers) || !providers.length) {
    lines.push('没有供应商。', '');
    return lines;
  }
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue;
    const id = typeof provider.id === 'string' ? provider.id : '';
    const models = Array.isArray(provider.models)
      ? provider.models.filter((item) => typeof item === 'string').map(memberName)
      : [];
    lines.push(`- ${id}：${models.length} 个模型${models.length ? `（${models.join('、')}）` : ''}`);
    const accounts = Array.isArray(provider.accounts) ? provider.accounts : [];
    if (accounts.length) {
      lines.push(`  - 账号 ${accounts.length} 个，按文件顺序`);
      accounts.forEach((account, index) => {
        const cap = account && typeof account === 'object' ? (account.cap ?? account.percent) : undefined;
        const capText = typeof cap === 'number' ? `，封顶 ${cap}%` : '';
        lines.push(`  - 第 ${index + 1} 个${capText}`);
      });
    }
  }
  lines.push('');
  return lines;
}

function shownSetting(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw && 'default' in raw) {
    if (JSON.stringify(raw.value) === JSON.stringify(raw.default)) return undefined;
    return raw.value;
  }
  return raw;
}

function formatSetting(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return 'null';
  if (typeof value === 'string') {
    if (EMAIL.test(value) || SECRET_TEXT.test(value) || value.length > 80) return '已略';
    return value;
  }
  return '已略';
}

function summarizeSettings(settings) {
  const lines = ['## 设置', ''];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    lines.push('没有 settings.json。', '');
    return lines;
  }
  const parts = [];
  for (const [key, raw] of Object.entries(settings)) {
    if (SECRET_FIELD.test(key)) continue;
    const value = shownSetting(raw);
    if (value === undefined) continue;
    parts.push(`${key}=${formatSetting(value)}`);
  }
  lines.push(parts.length ? parts.join('、') : '没有和默认值不同的键。', '');
  return lines;
}

function namesFrom(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return memberName(item);
      if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
      return '';
    })
    .filter(Boolean);
}

function summarizeLibrary(library) {
  const lines = ['## 资源库', ''];
  if (!library || typeof library !== 'object') {
    lines.push('没有 library.json。', '');
    return lines;
  }
  const instructions = namesFrom(library.instructions);
  const mcp = namesFrom(library.mcp || library.mcps || library.servers);
  const skills = namesFrom(library.skills);
  lines.push(`- 指令：${instructions.join('、') || '没有'}`);
  lines.push(`- MCP：${mcp.join('、') || '没有'}`);
  lines.push(`- 技能：${skills.join('、') || '没有'}`);
  lines.push('');
  return lines;
}

function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rowTokens(row) {
  const total = numberOf(row.tokens) ?? numberOf(row.totalTokens);
  if (total != null) return total;
  const input = numberOf(row.inputTokens) ?? numberOf(row.promptTokens) ?? 0;
  const output = numberOf(row.outputTokens) ?? numberOf(row.completionTokens) ?? 0;
  if (input === 0 && output === 0 && !('inputTokens' in row) && !('promptTokens' in row)) return null;
  return input + output;
}

function summarizeUsage(text, now) {
  const lines = ['## 近 30 天用量', ''];
  const cutoff = now - 30 * DAY;
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  let sawCost = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const stamp = row.time ?? row.ts ?? row.at ?? row.timestamp;
    const ms = typeof stamp === 'number' ? (stamp < 1e12 ? stamp * 1000 : stamp) : Date.parse(String(stamp));
    if (Number.isFinite(ms) && ms < cutoff) continue;
    const tok = rowTokens(row);
    const price = numberOf(row.cost) ?? numberOf(row.usd);
    if (tok == null && price == null) continue;
    calls += 1;
    tokens += tok ?? 0;
    if (price != null) {
      cost += price;
      sawCost = true;
    }
  }
  if (!calls) {
    lines.push('没有可加总的记录。', '');
    return lines;
  }
  lines.push(`- 请求 ${calls} 次`);
  lines.push(`- token ${tokens}`);
  lines.push(sawCost ? `- 费用 ${cost}` : '- 费用没有数字');
  lines.push('');
  return lines;
}

function summarize(dir, now) {
  const providersPath = join(dir, 'providers.json');
  if (!existsSync(providersPath)) throw new Error(`读不到 ${providersPath}`);
  const doc = readJson(providersPath);
  const lines = [`# 从 ${dir} 收的清单`, ''];
  lines.push(...summarizeProviders(doc.providers));
  lines.push(...summarizeGroups(doc.groups));
  const settingsPath = join(dir, 'settings.json');
  lines.push(...summarizeSettings(existsSync(settingsPath) ? readJson(settingsPath) : null));
  const libraryPath = join(dir, 'library.json');
  lines.push(...summarizeLibrary(existsSync(libraryPath) ? readJson(libraryPath) : null));
  const usagePath = join(dir, 'usage.jsonl');
  const usage = existsSync(usagePath) ? readFileSync(usagePath, 'utf8') : '';
  lines.push(...summarizeUsage(usage, now));
  return lines.join('\n');
}

function selfTest() {
  const now = Date.parse('2026-11-16T00:00:00Z');
  const text = summarizeFixture(now);
  const mailbox = ['person', 'example.com'].join('@');
  const forbidden = ['fixture-secret-value', mailbox, 'acct-9f3c'];
  for (const word of forbidden) {
    if (text.includes(word)) throw new Error(`自测把不该出现的内容打出来了：${word}`);
  }
  for (const word of [
    'grok-pool',
    'weight',
    'demo/m-one=2',
    'demo/m-two=1',
    'token 15',
    '费用 1.5',
    'theme=dark',
  ]) {
    if (!text.includes(word)) throw new Error(`自测缺少 ${word}`);
  }
  if (text.includes('lang=')) throw new Error('自测把和默认值相同的设置打出来了');
  if (!text.includes('账号 2 个')) throw new Error('自测没有账号个数');
  if (!text.includes('封顶 70%')) throw new Error('自测没有封顶');
  console.log('自测通过');
}

function summarizeFixture(now) {
  const dirNote = 'fixture';
  const doc = {
    providers: [
      {
        id: 'workbuddy',
        key: 'fixture-secret-value',
        models: ['m-one'],
        accounts: [
          { id: 'acct-9f3c', email: ['person', 'example.com'].join('@'), cap: 70 },
          { id: 'acct-other', email: ['second', 'example.com'].join('@'), cap: 40 },
        ],
      },
    ],
    groups: [
      {
        id: 'grok-pool',
        members: ['demo/m-one', `demo/m-two#${['person', 'example.com'].join('@')}`],
        routing: 'weight',
        weights: { 'demo/m-one': 2, 'demo/m-two': 1 },
        fast: ['demo/m-one'],
      },
    ],
  };
  const lines = [`# 从 ${dirNote} 收的清单`, ''];
  lines.push(...summarizeProviders(doc.providers));
  lines.push(...summarizeGroups(doc.groups));
  lines.push(
    ...summarizeSettings({
      theme: { value: 'dark', default: 'light' },
      lang: { value: 'zh', default: 'zh' },
      apiKey: 'fixture-secret-value',
    }),
  );
  lines.push(...summarizeLibrary({ skills: [{ name: 'fleet-rule' }], mcp: [{ name: 'local-tool' }] }));
  const recent = JSON.stringify({ time: now - DAY, inputTokens: 10, outputTokens: 5, cost: 1.5 });
  const old = JSON.stringify({ time: now - 40 * DAY, inputTokens: 99, cost: 9 });
  lines.push(...summarizeUsage(`${old}\n${recent}\n`, now));
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: magpie-inventory [--config 目录] [--self-test]');
    console.log('只读汇总。不打印密钥、邮箱、账号 ID。');
    return 0;
  }
  if (args.selfTest) {
    selfTest();
    return 0;
  }
  const dir = args.config ?? defaultConfig();
  try {
    statSync(dir);
  } catch (error) {
    throw new Error(`读不到 ${dir}（${error.code ?? 'error'}）`);
  }
  process.stdout.write(summarize(dir, Date.now()));
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : '汇总失败');
  process.exit(2);
}
