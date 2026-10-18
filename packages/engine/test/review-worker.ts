// 真生产动手活动/Spawner/Claude adapter，只有CLI换成本机固定脚本，标准输入落盘后逐字核对。
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { runClaudeCode, type SessionUser } from '@fleet-dao/adapters';
import type { HostDriver } from '../src/real/hosts.ts';
import { claudeReport } from '../src/real/hosts.ts';
import { createRunSegment } from '../src/real/task-segment.ts';
import type { WorkTrees } from '../src/real/worktrees.ts';
import type { RunSegmentInput } from '../src/task-contract.ts';
import { gitIn, isolatedGitEnv, isolatedUserExec } from './real/isolated-git.ts';

export function reviewWorker(root: string) {
  const dir = join(root, 'checkout');
  mkdirSync(dir, { recursive: true });
  const env = isolatedGitEnv(root, root);
  gitIn(env, root, 'init', '-q', '-b', 'main', dir);
  const key = (path: string) => {
    const canonical = resolve(realpathSync.native(path));
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  };
  if (
    key(gitIn(env, dir, 'rev-parse', '--show-toplevel')) !== key(dir) ||
    key(gitIn(env, dir, 'rev-parse', '--absolute-git-dir')) !== key(join(dir, '.git')) ||
    !lstatSync(join(dir, '.git')).isDirectory() ||
    lstatSync(join(dir, '.git')).isSymbolicLink()
  )
    throw Error('fixture git越界');
  writeFileSync(join(dir, 'README.md'), '# worker fixture\n');
  gitIn(env, dir, 'add', 'README.md');
  gitIn(env, dir, 'commit', '-qm', 'fixture root');
  const baseSha = gitIn(env, dir, 'rev-parse', 'HEAD');
  const check = (path: string) => {
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('fixture tree越界');
  };
  const trees: Pick<WorkTrees, 'ownerOf' | 'adopt' | 'remove' | 'tmpFor'> = {
    ownerOf: async (path) => {
      check(path);
      return 'fleet-agent-carpool' as SessionUser;
    },
    adopt: async (path) => {
      check(path);
      mkdirSync(path, { recursive: true });
    },
    remove: async (path) => {
      check(path);
      rmSync(path, { recursive: true, force: true });
      return { gone: true };
    },
    tmpFor: (id) => join(root, 'process-tmp', id),
  };
  const cli = join(root, 'worker.mjs');
  writeFileSync(
    cli,
    `import {readFileSync,writeFileSync} from 'node:fs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const chunks=[];for await(const c of process.stdin)chunks.push(c);writeFileSync(config.capture,Buffer.concat(chunks));
const emit=o=>process.stdout.write(JSON.stringify(o)+'\\n');
emit({type:'system',subtype:'init',session_id:config.session,model:config.model,claude_code_version:'2.1.281'});
emit({type:'assistant',session_id:config.session,message:{id:'test',role:'assistant',model:config.model,content:[{type:'text',text:'fixture received'}],usage:{input_tokens:1,output_tokens:1}}});
emit({type:'result',subtype:'success',session_id:config.session,is_error:false,result:'fixture received',num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},modelUsage:{[config.model]:{inputTokens:1,outputTokens:1,cacheReadInputTokens:0,cacheCreationInputTokens:0,costUSD:0}}});
`,
  );
  const receipts: { runId: string; stdin: string; promptMatchesStdin: boolean }[] = [];
  const driver: HostDriver = {
    hostId: 'claude-code',
    userFrom: 'pool',
    canFork: false,
    newSessionId: () => ({ id: randomUUID(), known: true }),
    loginFix: () => '',
    run: async (spec, hooks) => {
      const capture = join(root, `stdin-${receipts.length}.txt`),
        config = join(root, `config-${receipts.length}.json`);
      writeFileSync(config, JSON.stringify({ capture, session: spec.session.id, model: spec.model }));
      const report = await runClaudeCode(
        {
          runId: spec.runId,
          cwd: spec.cwd,
          prompt: spec.prompt,
          env: spec.env,
          model: spec.model,
          session: spec.session,
          permissionMode: 'bypassPermissions',
          pretoolScript: resolve('agents/hooks/pretool.mjs'),
          limits: { startupMs: 10_000, wallClockMs: 20_000, killGraceMs: 200 },
        },
        {
          command: [process.execPath, cli, config],
          ...(hooks.signal ? { signal: hooks.signal } : {}),
          ...(hooks.onSessionId ? { onSessionId: hooks.onSessionId } : {}),
        },
      );
      const stdin = readFileSync(capture, 'utf8');
      receipts.push({ runId: spec.runId, stdin, promptMatchesStdin: stdin === spec.prompt });
      return claudeReport(report);
    },
  };
  const run = createRunSegment({
    tree: {
      gh: {} as never,
      trees,
      exec: isolatedUserExec(env),
      tmpDir: join(root, 'tree-tmp'),
      gitBin: 'git',
      shBin: 'sh',
    },
    spawner: {
      routeFacts: async (id) => ({
        routeId: id,
        channelId: 'claude-subscription',
        poolId: 'p1',
        modelId: 'm1',
        hostId: 'claude-code',
        upstreamModel: null,
        runAsUser: 'fleet-agent-carpool',
        orgKind: null,
        effort: null,
      }),
      drivers: { 'claude-code': driver, 'cursor-agent': driver, grok: driver, mirasim: driver },
      trees,
      baseEnv: { PATH: process.env.PATH },
      resources: { memoryHighMb: 5888, memoryMaxMb: 6144, swapMaxMb: 0 },
    },
    runs: { start: async () => undefined, record: async () => undefined },
    reservations: { release: async () => undefined },
    attempts: { record: async () => undefined },
    runsDir: join(root, 'runs'),
    heartbeatEveryMs: 30,
  });
  return {
    receipts,
    run: (input: RunSegmentInput, ctx: Parameters<typeof run>[1]) =>
      run({ ...input, worktreePath: dir, baseSha, brief: { ...input.brief, touches: [] } }, ctx),
  };
}
