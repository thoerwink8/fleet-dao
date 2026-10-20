// 固定只读 Git：先核私有 .git 边界，再拒绝会引入外部配置/执行或对象替换的设置。
import { type TreeIdentity, treeIdentity } from '@fleet-dao/adapters';
import type { UserTree } from './user-git.ts';

const PIN = `import os,sys,json,stat,hashlib
p=sys.argv[1];fds=[os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)]
try:
 for part in p.strip('/').split('/'):fds.append(os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fds[-1]))
 s=os.fstat(fds[-1])
 if s.st_uid!=os.geteuid():raise RuntimeError('owner')
 ident=dict(lex=p,real=p,dev=str(s.st_dev),ino=str(s.st_ino),uid=str(s.st_uid))
 g=os.open('.git',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fds[-1]);fds.append(g)
 rows=[];count=[0];total=[0]
 def walk(fd,prefix):
  for name in sorted(os.listdir(fd)):
   count[0]+=1
   if count[0]>10000:raise RuntimeError('metadata limit')
   s=os.stat(name,dir_fd=fd,follow_symlinks=False);rel=prefix+name
   if stat.S_ISLNK(s.st_mode):raise RuntimeError('git link')
   if rel in ('commondir','info/grafts','objects/info/alternates','objects/info/http-alternates') or rel=='refs/replace':raise RuntimeError('git indirect objects')
   if stat.S_ISDIR(s.st_mode):
    c=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
    try:
     # Object payloads are verified by Git; only inspect their namespace boundaries.
     if rel!='objects':walk(c,rel+'/')
     else:
      for x in os.listdir(c):
       q=os.stat(x,dir_fd=c,follow_symlinks=False)
       if not stat.S_ISDIR(q.st_mode):raise RuntimeError('objects boundary')
       h=os.open(x,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=c)
       try:
        for leaf in os.listdir(h):
         count[0]+=1
         if count[0]>100000:raise RuntimeError('object limit')
         a=os.stat(leaf,dir_fd=h,follow_symlinks=False)
         if not stat.S_ISREG(a.st_mode) or (x=='info' and leaf in ('alternates','http-alternates')):raise RuntimeError('object link')
       finally:os.close(h)
    finally:os.close(c)
   elif stat.S_ISREG(s.st_mode):
    # Hooks/logs are inert for the selected commands. All other metadata is small and pinned.
    if rel.startswith(('hooks/','logs/')):continue
    if s.st_size>16*1024*1024 or total[0]+s.st_size>32*1024*1024:raise RuntimeError('metadata bytes')
    h=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
    try:
     data=os.read(h,16*1024*1024+1);total[0]+=len(data)
     if len(data)!=s.st_size:raise RuntimeError('metadata moved')
     rows.append([rel,str(s.st_dev),str(s.st_ino),hashlib.sha256(data).hexdigest()])
    finally:os.close(h)
   else:raise RuntimeError('metadata special file')
 walk(g,'')
 gs=os.fstat(g)
 print(json.dumps(dict(identity=ident,git=[str(gs.st_dev),str(gs.st_ino)],metadata=hashlib.sha256(json.dumps(rows).encode()).hexdigest())))
finally:
 for f in reversed(fds):os.close(f)`;

let sequence = 0;
async function command(t: UserTree, argv: string[], cap = 65536): Promise<Buffer> {
  t.signal?.throwIfAborted();
  sequence = (sequence + 1) % 1_000_000;
  const result = await t.exec({
    user: t.user,
    cwd: '/',
    argv,
    scopeId: `${t.scopePrefix}-${sequence}`.slice(0, 63),
    timeoutMs: 15_000,
    maxStdoutBytes: cap,
    ...(t.signal ? { signal: t.signal } : {}),
  });
  t.signal?.throwIfAborted();
  if (result.code !== 0 || result.outputOverflow || result.aborted || result.timedOut)
    throw new Error('safe_tree_read');
  return result.stdout;
}

async function pin(t: UserTree): Promise<{ identity: TreeIdentity; fingerprint: string }> {
  const text = (await command(t, ['/usr/bin/python3', '-I', '-c', PIN, t.dir], 4096)).toString('utf8');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('identity' in value)) throw new Error('tree_pin');
  return { identity: treeIdentity(value.identity), fingerprint: text };
}

async function git(t: UserTree, args: string[], cap = 65536): Promise<Buffer> {
  return command(
    t,
    [
      '/usr/bin/env',
      '-i',
      'PATH=/usr/bin:/bin',
      'HOME=/nonexistent',
      'LANG=C',
      'LC_ALL=C',
      'GIT_CONFIG_NOSYSTEM=1',
      'GIT_CONFIG_GLOBAL=/dev/null',
      'GIT_OPTIONAL_LOCKS=0',
      'GIT_NO_REPLACE_OBJECTS=1',
      '/usr/bin/git',
      `--git-dir=${t.dir}/.git`,
      `--work-tree=${t.dir}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'core.quotePath=false',
      ...args,
    ],
    cap,
  );
}

export async function readHandbackTree(
  t: UserTree,
  branch: string,
  ancestor: string,
): Promise<{ identity: TreeIdentity; head: string; fingerprint: string }> {
  if (!/^[a-f0-9]{40}$/.test(ancestor)) throw new Error('ancestor');
  const before = await pin(t);
  // config builtin reads local config with includes disabled; it runs no filters, aliases or hooks.
  const config = (await git(t, ['config', '--local', '--no-includes', '--null', '--list'])).toString('utf8');
  for (const item of config.split('\0').filter(Boolean)) {
    const key = item.split('\n', 1)[0]!;
    if (
      !/^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|autocrlf|symlinks|longpaths|hookspath|fsmonitor|untrackedcache)|remote\.[^.]+\.(?:url|fetch)|branch\.[^.]+\.(?:remote|merge)|user\.(?:name|email))$/.test(
        key,
      )
    )
      throw new Error('unsafe_git_config');
  }
  const tracked = (await git(t, ['ls-files', '--stage', '-v', '-f', '-z'], 16 * 1024 * 1024)).toString(
    'utf8',
  );
  for (const entry of tracked.split('\0').filter(Boolean)) {
    if (!/^H (?:100644|100755|120000) [a-f0-9]{40} 0\t/.test(entry) || entry.split('\t')[1] === '.gitmodules')
      throw new Error('unsupported_index_or_submodule');
  }
  const head = (await git(t, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim();
  const current = (await git(t, ['symbolic-ref', '--short', 'HEAD'])).toString('utf8').trim();
  const status = await git(t, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignore-submodules=all',
    '--no-renames',
  ]);
  const conflicts = await git(t, ['ls-files', '--unmerged']);
  if (!/^[a-f0-9]{40}$/.test(head) || current !== branch || status.length || conflicts.length)
    throw new Error('tree_not_clean');
  await git(t, ['merge-base', '--is-ancestor', ancestor, head]);
  const after = await pin(t);
  if (before.fingerprint !== after.fingerprint) throw new Error('tree_metadata_changed');
  return { ...after, head };
}
