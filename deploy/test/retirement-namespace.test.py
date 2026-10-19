"""Root mount namespace: exact product bytes; real sudo boundary/filesystem/processes.

Only journalctl/systemctl observations are fixtures, at their fixed product paths.
No host passwd, sudoers, installed helpers or service configuration is changed.
Run as Linux root with mount namespace + overlayfs and an extracted distro sudo package.
FLEET_TEST_SUDO_ROOT points to the extracted official package, never a product option.
"""
import hashlib
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parents[1]
FIXTURE_TOOL = r'''#!/usr/bin/python3
import json,os,pathlib,re,sys,time
state=json.loads(pathlib.Path('/root/retirement-fixture/state.json').read_text())
a=sys.argv[1:];now=state['at'];boot='a'*32;inv='b'*32
if state['mode']=='swap-inflight' and not pathlib.Path(state['path']+'-swapped').exists():
 os.rename(state['path'],state['path']+'-swapped');os.mkdir(state['path'],0o700);os.chown(state['path'],31002,31002)
def row(msg,pid='1',t=now,old=True):return dict(MESSAGE=msg,_PID=pid,_BOOT_ID=boot,_SYSTEMD_INVOCATION_ID=inv if old else 'c'*32,__REALTIME_TIMESTAMP=str(t))
if sys.argv[0].endswith('systemctl'):
 if 'fleet-engine.service' in a: print('KillMode=mixed\nInvocationID='+'c'*32)
 else:
  print('LoadState=not-found\nActiveState='+('active' if state['mode']=='active' else 'inactive')+'\nSubState=dead')
  sys.exit(4)
else:
 if state['mode']=='stop-query-failed' and 'SYSLOG_IDENTIFIER=sudo' in a:
  sys.stderr.write('journal read failed\n');sys.exit(1)
 if state['mode']=='timeout':time.sleep(12)
 if state['mode']=='truncated':os.write(1,b'x'*(2*1024*1024+1));sys.exit(0)
 if '-u' in a and a[a.index('-u')+1]=='fleet-engine.service':
  rows=[row("Worker state changed { state: 'RUNNING' }",'4864',now-100),row("Worker state changed { state: 'STOPPED' }",'4864',now+200),row('fleet-engine.service: Deactivated successfully.',t=now+300),row('Stopped fleet-engine.service.',t=now+400)]
  if state['mode']=='missing':rows=rows[:1]
  if state['mode']=='conflict':rows[1]['_BOOT_ID']='d'*32
 elif '-u' in a:
  rows=[row('Started fixture scope.',t=now),row('fleet-agent-scope: Deactivated successfully.',t=now+100)]
  if state['mode']=='cancelled':rows.append(row('Killed process due to cancellation',t=now+50))
  if state['mode']=='unfinished':rows=rows[:1]
  if state['mode']=='stopping-log-only':rows.insert(1,row('Stopping fixture scope.',t=now+50))
  if state['mode']=='stopped-log-only':rows.append(row('Stopped fixture scope.',t=now+150))
 elif any(x.startswith('_PID=') for x in a):
  rows=[row('pam_unix(sudo:session): session closed for user root','7001',now+150),row('pam_unix(sudo:session): session closed for user root','7003',now+150)]
  rows.extend(row('pam_unix(sudo:session): session closed for user root','7002',now+550,old) for old in (True,False))
 else:
  rows=[dict(row('fleet : COMMAND=/usr/local/sbin/fleet-agent-scope run '+state['run']+' --cwd '+state['path'],'7001',now-100),SYSLOG_IDENTIFIER='sudo')]
  if state['mode'] in ('extra-natural','stop-extra-old','stop-extra-new'):
   rows.append(dict(row('fleet : COMMAND=/usr/local/sbin/fleet-agent-scope run self-check-fixture --cwd '+state['path'],'7003',now-100),SYSLOG_IDENTIFIER='sudo'))
  if state['mode'] in ('stop-run-old','stop-run-new','stop-extra-old','stop-extra-new','unrelated-stop'):
   target='self-check-fixture' if 'extra' in state['mode'] else ('unrelated-scope' if state['mode']=='unrelated-stop' else state['run'])
   rows.append(dict(row('fleet : COMMAND=/usr/local/sbin/fleet-agent-scope stop '+target,'7002',now+450,'new' not in state['mode']),SYSLOG_IDENTIFIER='sudo'))
 if 'SYSLOG_IDENTIFIER=sudo' in a:rows=[x for x in rows if x.get('SYSLOG_IDENTIFIER')=='sudo']
 if '--grep' in a:rows=[x for x in rows if re.search(a[a.index('--grep')+1],x['MESSAGE'])]
 for x in rows:print(json.dumps(x))
 if '--grep' in a and not rows:sys.exit(1)
'''


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def isolate(root):
    """Every privileged mutation below occurs after unshare(CLONE_NEWNS)."""
    run('/usr/bin/mount', '--make-rprivate', '/')
    for target in ('/usr/bin', '/usr/lib/x86_64-linux-gnu', '/etc'):
        name=target.replace('/','_');upper=root/name/'upper';work=root/name/'work'
        upper.mkdir(parents=True);work.mkdir()
        run('/usr/bin/mount','-t','overlay','overlay','-o',f'lowerdir={target},upperdir={upper},workdir={work}',target)
    for target in ('/var/lib','/run','/usr/local','/root'):
        run('/usr/bin/mount','-t','tmpfs','tmpfs',target)
    sudo_root=pathlib.Path(os.environ['FLEET_TEST_SUDO_ROOT'])
    for directory in ('usr/lib/x86_64-linux-gnu','lib/x86_64-linux-gnu'):
        if (sudo_root/directory).exists():
            for item in (sudo_root/directory).iterdir():
                if item.is_file():shutil.copy2(item,pathlib.Path('/usr/lib/x86_64-linux-gnu')/item.name)
    libexec=sudo_root/'usr/libexec'
    if libexec.exists():
        run('/usr/bin/mount','--bind',str(libexec),'/usr/libexec')
    shutil.copy2(sudo_root/'usr/bin/sudo','/usr/bin/sudo');os.chmod('/usr/bin/sudo',0o4755)
    shutil.copytree(sudo_root/'etc/sudo.conf','/etc/sudo.conf') if (sudo_root/'etc/sudo.conf').is_dir() else shutil.copy2(sudo_root/'etc/sudo.conf','/etc/sudo.conf')
    with open('/etc/passwd','a') as out:out.write('fleet:x:31001:31001::/nonexistent:/bin/sh\nfleet-agent-carpool:x:31002:31002::/nonexistent:/bin/sh\n')
    with open('/etc/group','a') as out:out.write('fleet:x:31001:\nfleet-agent-carpool:x:31002:\n')
    with open('/etc/shadow','a') as out:out.write('fleet:*:20000:0:99999:7:::\nfleet-agent-carpool:*:20000:0:99999:7:::\n')
    shutil.copy2(sudo_root/'etc/pam.d/sudo','/etc/pam.d/sudo')
    pathlib.Path('/etc/sudoers').write_text('Defaults !requiretty\nroot ALL=(ALL:ALL) ALL\nfleet ALL=(root) NOPASSWD: /usr/local/sbin/fleet-agent-scope\n')
    os.chmod('/etc/sudoers',0o440)
    pathlib.Path('/usr/local/sbin').mkdir(parents=True)
    pathlib.Path('/usr/local/libexec').mkdir(parents=True)
    for source,target in ((HERE/'france/fleet-agent-scope.sh','/usr/local/sbin/fleet-agent-scope'),(HERE/'france/tree-usage.py','/usr/local/libexec/fleet-dao-tree-usage.py')):
        shutil.copyfile(source,target);os.chmod(target,0o755)
        assert hashlib.sha256(source.read_bytes()).digest()==hashlib.sha256(pathlib.Path(target).read_bytes()).digest()
    pathlib.Path('/etc/systemd/system').mkdir(parents=True,exist_ok=True)
    pathlib.Path('/etc/systemd/system/fleet-engine.service').write_text('[Service]\nKillMode=mixed\n')
    for name in ('journalctl','systemctl'):
        p=pathlib.Path('/usr/bin')/name;p.write_text(FIXTURE_TOOL);p.chmod(0o755)
    pathlib.Path('/root/retirement-fixture').mkdir(mode=0o700)


class Retirement(unittest.TestCase):
    def setUp(self):
        self.path='/var/lib/fleet-work/test_repo/3343-t01a155b5'
        shutil.rmtree('/var/lib/fleet-work',ignore_errors=True)
        pathlib.Path(self.path).mkdir(parents=True)
        os.chown(self.path,31002,31002);os.chmod(self.path,0o700)
        st=os.stat(self.path);now=int(time.time()*1000)
        self.runid='89b8928a-6a0c-4dfc-8ae7-0154a1644a94'
        self.dto=dict(version=1,identity=dict(lex=self.path,real=self.path,dev=str(st.st_dev),ino=str(st.st_ino),uid=str(st.st_uid)),runIds=[self.runid],worker='4864@'+socket.gethostname(),sinceMs=now-5000,untilMs=now)
        self.state=dict(at=(now-2000)*1000,mode='normal',path=self.path,run=self.runid)

    def call(self,mode='normal',uid=31001):
        self.state['mode']=mode
        pathlib.Path('/root/retirement-fixture/state.json').write_text(json.dumps(self.state))
        p=subprocess.run(['/usr/bin/sudo','-n','/usr/local/sbin/fleet-agent-scope','retirement',json.dumps(self.dto)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,user=uid,group=uid,timeout=20,cwd='/')
        if not p.stdout.strip():raise AssertionError(f'helper transport {p.returncode}: {p.stderr}')
        value=json.loads(p.stdout)
        return p,value

    def test_natural_and_nonroot_no_direct_read(self):
        denied=subprocess.run(['/usr/bin/cat','/root/retirement-fixture/state.json'],user=31001,group=31001,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.assertNotEqual(denied.returncode,0)
        p,result=self.call()
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertEqual(result['state'],'natural-retired')
        self.assertEqual(result['identity'],self.dto['identity'])
        self.assertNotIn('COMMAND',p.stdout)
        self.assertFalse(pathlib.Path('/var/lib/fleet-work/.cleanup-transactions').exists())
        root_p,root_result=self.call(uid=0)
        self.assertEqual(root_p.returncode,0,root_p.stderr)
        for key in ('state','identity','bootId','invocationId','worker','runIds','helperCount','scopes','engineStoppedUs','failed'):
            self.assertEqual(result[key],root_result[key],key)

    def test_unknown_for_missing_conflict_active_cancelled_unfinished_truncated_timeout(self):
        for mode in ('missing','conflict','active','cancelled','unfinished','truncated','timeout'):
            with self.subTest(mode=mode):
                p,value=self.call(mode)
                self.assertNotEqual(p.returncode,0)
                self.assertEqual(value['state'],'unknown')
                self.assertLess(len(p.stdout),4096)

    def test_explicit_stop_or_scope_stop_log_is_not_natural(self):
        for mode in ('stop-run-old','stop-run-new','stop-extra-old','stop-extra-new','stopping-log-only','stopped-log-only'):
            with self.subTest(mode=mode):
                p,value=self.call(mode)
                self.assertNotEqual(p.returncode,0)
                self.assertEqual(value['state'],'unknown')
                self.assertIn('scope',value['reason'])

    def test_failed_intervention_query_is_unknown(self):
        p,value=self.call('stop-query-failed')
        self.assertNotEqual(p.returncode,0)
        self.assertEqual(value['state'],'unknown')
        self.assertIn('command failed',value['reason'])

    def test_natural_extra_scope_and_unrelated_stop_do_not_reject(self):
        for mode,count in (('extra-natural',2),('unrelated-stop',1)):
            with self.subTest(mode=mode):
                p,value=self.call(mode)
                self.assertEqual(p.returncode,0,p.stderr)
                self.assertEqual(value['state'],'natural-retired')
                self.assertEqual(len(value['scopes']),count)

    def test_replaced_tree_and_symlink_rejected(self):
        os.rename(self.path,self.path+'-old');os.mkdir(self.path);os.chown(self.path,31002,31002)
        self.assertEqual(self.call()[1]['state'],'unknown')
        os.rmdir(self.path);os.symlink(self.path+'-old',self.path)
        self.assertEqual(self.call()[1]['state'],'unknown')

    def test_tree_replaced_during_root_observation_rejected(self):
        self.assertEqual(self.call('swap-inflight')[1]['state'],'unknown')

    def test_mismatched_run_and_worker_rejected(self):
        self.dto['worker']='4864@different-host'
        self.assertEqual(self.call()[1]['state'],'unknown')
        self.dto['worker']='4864@'+socket.gethostname()
        self.dto['runIds']=['e52f0afc-bc85-41d4-b278-7e62220e6827']
        self.assertEqual(self.call()[1]['state'],'unknown')

    def test_live_cross_uid_cwd_rejected(self):
        p=subprocess.Popen(['/bin/sleep','20'],cwd=self.path,user=31002,group=31002)
        try:self.assertEqual(self.call()[1]['state'],'unknown')
        finally:p.terminate();p.wait()


if __name__=='__main__':
    if sys.platform!='linux' or os.geteuid()!=0:raise SystemExit('Linux root required; no skip')
    if '--inside' not in sys.argv:
        with tempfile.TemporaryDirectory(prefix='fleet-retirement-ns-',dir='/var/tmp') as root:
            p=subprocess.run(['/usr/bin/unshare','--mount','--propagation','private',sys.executable,__file__,'--inside',root])
            raise SystemExit(p.returncode)
    root=pathlib.Path(sys.argv[sys.argv.index('--inside')+1]);isolate(root)
    unittest.main(argv=[sys.argv[0]],verbosity=2)
