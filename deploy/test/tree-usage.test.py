"""Real Linux/root tests; isolated /var/lib fixture, never the installed helper."""

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "france" / "tree-usage.py"


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "real Linux root required")
class Protocol(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="fleet-tree-usage-test-", dir="/var/lib")
        os.chmod(self.root, 0o755)
        spec = importlib.util.spec_from_file_location("tree_usage_fixture", SOURCE)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.m.BASE = self.root
        self.m.DEADLINE = time.monotonic() + 30
        self.path = self.root + "/_tmp/task"
        os.makedirs(self.path)
        # Reproduce the live fleet-writable parent, not only a root-private path.
        os.chown(self.root + "/_tmp", 1000, 1000)
        os.chown(self.path, 1000, 1000)
        pathlib.Path(self.path, "data").write_text("must be recoverable")
        self.exp = self.m.identity(os.stat(self.path), self.path)

    def tearDown(self):
        self.assertTrue(self.root.startswith("/var/lib/fleet-tree-usage-test-"))
        shutil.rmtree(self.root)

    def do_remove(self):
        with self.m.locked(self.path) as (fd, q):
            return self.m.remove(fd, q, self.exp)

    def transactions(self):
        with self.m.locked(self.path) as (fd, _):
            return self.m.pending(fd)

    def test_normal_writable_tmp_and_receipt(self):
        result = self.do_remove()
        self.assertEqual(result["state"], "removed")
        self.assertEqual(result["identity"], self.exp)
        self.assertFalse(os.path.exists(self.path))
        self.assertEqual(self.transactions(), [])

    def test_original_identity_not_reauthorized_after_replacement(self):
        os.rename(self.path, self.path + "-old")
        os.mkdir(self.path)
        pathlib.Path(self.path, "replacement").write_text("keep me")
        with self.assertRaisesRegex(self.m.Kept, "identity changed"):
            self.do_remove()
        self.assertTrue(pathlib.Path(self.path, "replacement").exists())
        self.assertTrue(pathlib.Path(self.path + "-old", "data").exists())

    def test_cross_uid_live_cwd_is_busy(self):
        proc = subprocess.Popen(["/bin/sleep", "30"], cwd=self.path, user=1000, group=1000)
        try:
            time.sleep(0.03)
            proof = self.m.scan(self.path, self.exp)
            self.assertEqual(proof["state"], "busy")
            with self.assertRaises(self.m.Kept):
                self.do_remove()
            self.assertTrue(pathlib.Path(self.path, "data").exists())
            self.assertEqual(self.transactions(), [])
        finally:
            proc.terminate()
            proc.wait()

    def test_reserved_namespace_and_bare_protocol_rejected(self):
        with self.assertRaises(self.m.Kept):
            self.m.valid_path(self.root + "/.cleanup-transactions/anything")
        with self.assertRaises(self.m.Kept):
            self.m.main(["remove", self.path])
        with self.assertRaises(self.m.Kept):
            self.m.main(["guard-run", self.root + "/_tmp/../.cleanup-transactions/test"])

    def test_independent_thread_cwd_and_exited_leader_are_busy(self):
        script = r'''
import ctypes, os, sys, threading, time
libc=ctypes.CDLL(None, use_errno=True)
ready=threading.Event()
def worker():
    if libc.unshare(0x200) != 0:
        print("ERROR unshare="+str(ctypes.get_errno()), flush=True)
        os._exit(2)
    os.chdir(sys.argv[1])
    ready.set()
    while True: time.sleep(0.1)
threading.Thread(target=worker).start()
ready.wait()
print("READY", flush=True)
if sys.argv[2] == "exit-leader":
    # libc SYS_exit ends only this native thread, not the thread group.
    machine=os.uname().machine
    number={"x86_64":60,"aarch64":93}[machine]
    libc.syscall(number, 0)
while True: time.sleep(0.1)
'''
        for mode in ("live-leader", "exit-leader"):
            with self.subTest(mode=mode):
                proc = subprocess.Popen([sys.executable, "-I", "-S", "-c", script, self.path, mode],
                                        cwd="/", stdout=subprocess.PIPE, text=True, user=1000, group=1000)
                try:
                    import select
                    self.assertTrue(select.select([proc.stdout], [], [], 5)[0], "thread fixture failed to start")
                    self.assertEqual(proc.stdout.readline().strip(), "READY")
                    time.sleep(0.03)
                    self.assertEqual(self.m.scan(self.path, self.exp)["state"], "busy")
                    with self.assertRaises(self.m.Kept):
                        self.do_remove()
                    self.assertTrue(pathlib.Path(self.path, "data").exists())
                finally:
                    proc.kill()
                    proc.wait()
                    proc.stdout.close()

    def test_leaf_symlink_never_followed(self):
        os.rename(self.path, self.path + "-old")
        os.symlink(self.path + "-old", self.path)
        with self.assertRaises(self.m.Kept):
            self.do_remove()
        self.assertTrue(pathlib.Path(self.path + "-old", "data").exists())

    def test_invalid_names_and_adopt_preserve_outside_symlink(self):
        for path in ("relative/task", self.root + "/single", self.root + "/repo/../task", self.root + "/repo/task\n"):
            with self.subTest(path=path), self.assertRaises(self.m.Kept):
                self.m.valid_path(path)
        import types
        outside = pathlib.Path(self.root, "outside")
        outside.write_text("untouched")
        os.symlink(str(outside), self.path + "/link")
        original_user = self.m.pwd.getpwnam
        import builtins
        import io
        try:
            self.m.pwd.getpwnam = lambda _: types.SimpleNamespace(pw_uid=1000, pw_gid=1000)
            # Test the real host guard first; never alter the host sysctl.
            with open("/proc/sys/fs/protected_hardlinks") as source:
                protection = source.read().strip()
            if protection != "1":
                with self.assertRaisesRegex(self.m.Kept, "protected_hardlinks"):
                    self.m.main(["adopt", self.path, "--user", self.m.SESSION_USER])
            # Explicit unit fixture exercises chown after the guard, even on WSL with sysctl=0.
            self.m.open = lambda path, *a, **kw: io.StringIO("1") if path == "/proc/sys/fs/protected_hardlinks" else builtins.open(path, *a, **kw)
            result = self.m.main(["adopt", self.path, "--user", self.m.SESSION_USER])
        finally:
            self.m.pwd.getpwnam = original_user
            self.m.__dict__.pop("open", None)
        self.assertEqual(result["identity"], self.exp)
        self.assertEqual(os.stat(outside).st_uid, 0)
        self.assertEqual(outside.read_text(), "untouched")
        self.assertEqual(os.lstat(self.path + "/link").st_uid, 1000)

    def test_expired_budget_never_claims_source(self):
        self.m.DEADLINE = time.monotonic() - 1
        with self.assertRaisesRegex(self.m.Kept, "deadline"):
            self.do_remove()
        self.assertTrue(pathlib.Path(self.path, "data").exists())

    def test_claimed_replacement_returns_without_deletion(self):
        original = self.m.rename_noreplace
        moved = False

        def replace_before_claim(a, name, b, dest):
            nonlocal moved
            if not moved:
                moved = True
                os.rename(self.path, self.path + "-old")
                os.mkdir(self.path)
                pathlib.Path(self.path, "replacement").write_text("do not delete")
            return original(a, name, b, dest)

        self.m.rename_noreplace = replace_before_claim
        with self.assertRaisesRegex(self.m.Kept, "claimed a replacement"):
            self.do_remove()
        self.assertTrue(pathlib.Path(self.path, "replacement").exists())
        self.assertTrue(pathlib.Path(self.path + "-old", "data").exists())
        self.assertEqual(self.transactions(), [])

    def test_claimed_replacement_rollback_conflict_is_visible(self):
        original = self.m.rename_noreplace
        moved = False

        def conflict(a, name, b, dest):
            nonlocal moved
            if not moved:
                moved = True
                os.rename(self.path, self.path + "-old")
                os.mkdir(self.path)
                pathlib.Path(self.path, "replacement").write_text("retain payload")
                original(a, name, b, dest)
                os.mkdir(self.path)
                pathlib.Path(self.path, "new-source").write_text("no overwrite")
                return
            return original(a, name, b, dest)

        self.m.rename_noreplace = conflict
        with self.assertRaisesRegex(self.m.Kept, "transaction="):
            self.do_remove()
        self.assertTrue(pathlib.Path(self.path, "new-source").exists())
        rows = self.transactions()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["phase"], "RECOVERY_REQUIRED")
        q = pathlib.Path(self.root, ".cleanup-transactions", rows[0]["pathHash"], rows[0]["id"], "tree")
        self.assertTrue((q / "replacement").exists())

    def test_claimed_crash_requires_explicit_rollback_and_never_gone(self):
        child = os.fork()
        if child == 0:
            original = self.m.write_record
            def crash(fd, record):
                original(fd, record)
                if record["phase"] == "CLAIMED":
                    os._exit(78)
            self.m.write_record = crash
            self.do_remove()
            os._exit(99)
        _, code = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(code), 78)
        self.assertFalse(os.path.exists(self.path))
        rows = self.transactions()
        self.assertEqual(rows[0]["phase"], "CLAIMED")
        with self.assertRaisesRegex(self.m.Kept, "unresolved"):
            self.m.main(["tree-place", self.path])
        reply = self.m.main(["cleanup-rollback", rows[0]["pathHash"], rows[0]["id"]])
        self.assertEqual(reply["state"], "restored")
        self.assertEqual(pathlib.Path(self.path, "data").read_text(), "must be recoverable")
        self.assertEqual(self.do_remove()["state"], "removed")

    def test_deleting_crash_cannot_claim_full_rollback(self):
        child = os.fork()
        if child == 0:
            def crash_after_unlink(fd, dev):
                os.unlink("data", dir_fd=fd)
                os._exit(79)
            self.m.erase = crash_after_unlink
            self.do_remove()
            os._exit(99)
        _, code = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(code), 79)
        rows = self.transactions()
        self.assertEqual(rows[0]["phase"], "DELETING")
        with self.assertRaisesRegex(self.m.Kept, "partial deletion"):
            self.m.main(["cleanup-rollback", rows[0]["pathHash"], rows[0]["id"]])
        with self.assertRaisesRegex(self.m.Kept, "unresolved"):
            self.m.main(["tree-place", self.path])

    def test_scan_failure_never_claims_source(self):
        self.m.scan = lambda *args: {"state": "unknown", "reason": "EACCES"}
        with self.assertRaisesRegex(self.m.Kept, "EACCES"):
            self.do_remove()
        self.assertTrue(pathlib.Path(self.path, "data").exists())
        self.assertEqual(self.transactions(), [])

    def test_private_namespace_open_permissions_rejected(self):
        with self.m.locked(self.path):
            pass
        os.chmod(self.root + "/.cleanup-transactions", 0o777)
        with self.assertRaisesRegex(self.m.Kept, "untrusted private parent"):
            self.do_remove()


if __name__ == "__main__":
    unittest.main()
