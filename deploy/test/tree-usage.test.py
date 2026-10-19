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

    def test_cleanup_namespace_absent_empty_and_settled(self):
        absent = self.m.main(["cleanup-status"])
        self.assertIsNone(absent["namespace"])
        self.assertEqual(absent["rows"], [])
        with self.m.locked(self.path):
            pass
        empty = self.m.main(["cleanup-status"])
        private = self.root + "/" + self.m.PRIVATE
        self.assertEqual(empty["namespace"], self.m.identity(os.stat(private), private))
        self.assertEqual(empty["rows"], [])
        self.assertFalse(empty["truncated"])
        self.namespace_record("DONE")
        self.assertEqual(self.m.main(["cleanup-status"])["rows"], [])

    def namespace_record(self, phase):
        return self.bucket_record(self.path, phase, self.exp["ino"])

    def bucket_record(self, path, phase, ino="7"):
        exp = dict(self.exp, lex=path, real=path, ino=ino)
        rec = dict(version=1, identity=exp, id=self.m.id_hash(exp),
                   pathHash=self.m.path_hash(path), phase=phase)
        with self.m.locked(path) as (fd, _):
            os.mkdir(rec["id"], 0o700, dir_fd=fd)
            h = os.open(rec["id"], self.m.FLAGS, dir_fd=fd)
            try:
                self.m.write_record(h, rec)
            finally:
                os.close(h)
        return rec

    def test_cleanup_namespace_pending_and_bad_record_not_hidden(self):
        rec = self.namespace_record("DELETING")
        reply = self.m.main(["cleanup-status"])
        self.assertEqual(reply["rows"], [rec])
        self.assertIsNotNone(reply["namespace"])
        intent = pathlib.Path(self.root, self.m.PRIVATE, rec["pathHash"], rec["id"], "intent.json")
        intent.write_text("broken JSON")
        with self.assertRaises(json.JSONDecodeError):
            self.m.main(["cleanup-status"])

    def test_cleanup_namespace_file_link_foreign_and_unsafe_rejected(self):
        private = self.root + "/" + self.m.PRIVATE
        pathlib.Path(private).write_text("not metadata directory")
        with self.assertRaises(OSError):
            self.m.main(["cleanup-status"])
        os.unlink(private)
        os.symlink(self.path, private)
        with self.assertRaises(OSError):
            self.m.main(["cleanup-status"])
        os.unlink(private)
        os.mkdir(private, 0o700)
        os.chown(private, 1000, 1000)
        with self.assertRaisesRegex(self.m.Kept, "untrusted private parent"):
            self.m.main(["cleanup-status"])
        os.chown(private, 0, 0)
        os.chmod(private, 0o777)
        with self.assertRaisesRegex(self.m.Kept, "untrusted private parent"):
            self.m.main(["cleanup-status"])

    def test_cleanup_namespace_truncation_and_read_failure_not_empty(self):
        private = self.root + "/" + self.m.PRIVATE
        os.mkdir(private, 0o700)
        for i in range(101):
            os.mkdir(private + "/" + format(i, "064x"), 0o700)
        partial = self.m.main(["cleanup-status"])
        self.assertTrue(partial["truncated"])
        self.assertEqual(partial["next"], format(99, "064x"))
        original = self.m.os.listdir
        try:
            self.m.os.listdir = lambda _: (_ for _ in ()).throw(PermissionError("denied"))
            with self.assertRaises(PermissionError):
                self.m.main(["cleanup-status"])
        finally:
            self.m.os.listdir = original

    def crowded(self, count, tail_phase="RECOVERY_REQUIRED"):
        """Empty, lock-only and settled buckets first; the only open transaction sorts last."""
        private = self.root + "/" + self.m.PRIVATE
        os.mkdir(private, 0o700)
        paths = sorted((self.root + "/_tmp/t" + str(i) for i in range(count)), key=self.m.path_hash)
        for i, path in enumerate(paths[:-1]):
            if i % 4 == 0:
                os.mkdir(private + "/" + self.m.path_hash(path), 0o700)
            elif i % 4 == 1:
                with self.m.locked(path):
                    pass
            else:
                self.bucket_record(path, "DONE" if i % 4 == 2 else "RESTORED")
        return paths, self.bucket_record(paths[-1], tail_phase)

    def page(self, prev, after=None):
        ns = prev["namespace"]
        return self.m.main(["cleanup-status", "--after", after or prev["next"], "--dev", ns["dev"],
                            "--ino", ns["ino"], "--generation", prev["generation"]])

    def walk(self):
        pages = [self.m.main(["cleanup-status"])]
        while pages[-1]["truncated"]:
            self.assertLess(len(pages), 200, "cursor never finished")
            pages.append(self.page(pages[-1]))
        return pages

    def test_cleanup_pages_complete_read_beyond_100_with_tail_recovery(self):
        paths, tail = self.crowded(130)
        first = self.m.main(["cleanup-status"])
        # partial: the old fixed prefix shows no rows, which never proves the namespace is clear.
        self.assertEqual((first["rows"], first["truncated"]), ([], True))
        self.assertEqual(first["next"], self.m.path_hash(paths[99]))
        pages = self.walk()
        self.assertEqual(len(pages), 2)
        self.assertEqual({p["generation"] for p in pages}, {first["generation"]})
        self.assertEqual(pages[1]["after"], first["next"])
        # complete: every page walked, the tail RECOVERY_REQUIRED is visible and nothing else is open.
        self.assertEqual((pages[-1]["truncated"], pages[-1]["next"]), (False, None))
        self.assertEqual([r for p in pages for r in p["rows"]], [tail])
        for ph in map(self.m.path_hash, paths):
            self.assertTrue(os.path.isdir(self.root + "/" + self.m.PRIVATE + "/" + ph))

    def test_cleanup_page_boundaries_rows_bytes_and_time(self):
        paths, tail = self.crowded(100, "PREPARED")
        one = self.walk()
        self.assertEqual((len(one), one[0]["truncated"], one[0]["rows"]), (1, False, [tail]))
        self.bucket_record(self.root + "/_tmp/extra", "DELETING")
        two = self.walk()
        self.assertEqual(len(two), 2)
        self.assertEqual(sum(len(p["rows"]) for p in two), 2)
        last = self.page(two[0], max(map(self.m.path_hash, paths + [self.root + "/_tmp/extra"])))
        self.assertEqual((last["rows"], last["truncated"], last["next"]), ([], False, None))
        self.m.PAGE_ROWS = 1
        rows = [r for p in self.walk() for r in p["rows"]]
        self.assertEqual(len(rows), 2)
        self.bucket_record(tail["identity"]["real"], "CLAIMED", "8")
        with self.assertRaisesRegex(self.m.Kept, "exceeds page bound"):
            self.walk()
        self.m.PAGE_ROWS = 200
        self.m.PAGE_BYTES = 10
        with self.assertRaisesRegex(self.m.Kept, "exceeds page bound"):
            self.walk()
        self.m.PAGE_BYTES = 96 * 1024
        self.m.PAGE_SECONDS = 0
        timed = self.walk()
        self.assertEqual(len(timed), 101)
        self.assertTrue(all(p["truncated"] for p in timed[:-1]))
        self.assertEqual(sum(len(p["rows"]) for p in timed), 3)
        self.m.DEADLINE = time.monotonic() - 1
        with self.assertRaisesRegex(self.m.Kept, "hard deadline"):
            self.m.main(["cleanup-status"])

    def test_cleanup_pages_concurrent_add_and_namespace_replacement(self):
        paths, tail = self.crowded(105)
        first = self.m.main(["cleanup-status"])
        with self.m.locked(self.path):
            pass
        changed = self.page(first)
        self.assertEqual(changed["state"], "changed")
        self.assertNotIn("rows", changed)
        restarted = self.walk()
        self.assertEqual([r for p in restarted for r in p["rows"]], [tail])
        private = self.root + "/" + self.m.PRIVATE
        os.rename(private, private + "-old")
        os.mkdir(private, 0o700)
        for name in os.listdir(private + "-old"):
            os.mkdir(private + "/" + name, 0o700)
        replaced = self.m.main(["cleanup-status"])
        with self.assertRaisesRegex(self.m.Kept, "another namespace"):
            self.page(dict(restarted[0], generation=replaced["generation"]))
        os.rename(private, private + "-gone")
        with self.assertRaisesRegex(self.m.Kept, "disappeared"):
            self.page(replaced)

    def test_cleanup_cursor_forged_cycle_and_malformed_rejected(self):
        self.crowded(102)
        first = self.m.main(["cleanup-status"])
        ns = first["namespace"]
        with self.assertRaisesRegex(self.m.Kept, "not a namespace bucket"):
            self.page(first, "f" * 64)
        stale = self.page(dict(first, generation="1.1"))
        self.assertEqual(stale["state"], "changed")
        again = self.page(first, first["next"])
        self.assertEqual(again, self.page(first))
        for bad in (["--after", "A" * 64, "--dev", ns["dev"], "--ino", ns["ino"], "--generation", first["generation"]],
                    ["--after", "../x", "--dev", ns["dev"], "--ino", ns["ino"], "--generation", first["generation"]],
                    ["--after", first["next"], "--dev", "01", "--ino", ns["ino"], "--generation", first["generation"]],
                    ["--after", first["next"], "--generation", first["generation"]],
                    ["--offset", "100"]):
            with self.assertRaises(self.m.Kept):
                self.m.main(["cleanup-status", *bad])

    def test_cleanup_tail_bucket_guards_beyond_first_page(self):
        paths, tail = self.crowded(103)
        private = self.root + "/" + self.m.PRIVATE
        bucket = private + "/" + tail["pathHash"]
        intent = pathlib.Path(bucket, tail["id"], "intent.json")
        good = intent.read_bytes()
        intent.write_text("broken JSON")
        with self.assertRaises(json.JSONDecodeError):
            self.walk()
        intent.write_bytes(good)
        os.chmod(bucket, 0o777)
        with self.assertRaisesRegex(self.m.Kept, "untrusted private parent"):
            self.walk()
        os.chmod(bucket, 0o700)
        os.rename(bucket, bucket + ".x")
        os.symlink(bucket + ".x", bucket)
        with self.assertRaises(self.m.Kept):  # an unrecognized ".x" entry is refused before following
            self.walk()
        os.unlink(bucket)
        os.rename(bucket + ".x", private + "/" + "f" * 64)
        os.symlink(private + "/" + "f" * 64, bucket)
        with self.assertRaises(OSError):
            self.walk()
        os.unlink(bucket)
        os.rename(private + "/" + "f" * 64, bucket)
        moved = private + "/" + self.m.path_hash(paths[0])
        os.rename(bucket + "/" + tail["id"], moved + "/" + tail["id"])
        with self.assertRaisesRegex(self.m.Kept, "bucket identity mismatch"):
            self.walk()
        os.rename(moved + "/" + tail["id"], bucket + "/" + tail["id"])
        pathlib.Path(private, "e" * 64).write_text("not a bucket")
        with self.assertRaises(OSError):
            self.walk()

    def temp_file(self, name="ops-verify-2901.tar"):
        path = self.root + "/_tmp/" + name
        pathlib.Path(path).write_text("temporary payload")
        os.chown(path, 1000, 1000)
        return path, self.m.identity(os.stat(path), path)

    def remove_file(self, path, exp):
        return self.m.main(["remove", path, "--dev", exp["dev"], "--ino", exp["ino"], "--uid", exp["uid"]])

    def test_ops_temporary_regular_files_use_identity_transaction(self):
        for suffix in ("bundle", "log", "tar", "tgz"):
            with self.subTest(suffix=suffix):
                path, exp = self.temp_file("ops-verify-2901." + suffix)
                self.assertEqual(self.m.main(["tree-place", path])["identity"], exp)
                usage = self.m.main(["tree-usage", path, "--dev", exp["dev"], "--ino", exp["ino"], "--uid", exp["uid"]])
                self.assertEqual(usage["state"], "idle")
                result = self.remove_file(path, exp)
                self.assertEqual(result["state"], "removed")
                self.assertEqual(result["identity"], exp)
                self.assertFalse(os.path.lexists(path))

    def test_file_scope_excludes_other_paths_links_and_special_files(self):
        for name in ("repo1/file", "_tmp/nested/file"):
            path = self.root + "/" + name
            os.makedirs(os.path.dirname(path), exist_ok=True)
            pathlib.Path(path).write_text("keep")
            with self.subTest(path=path), self.assertRaises(self.m.Kept):
                self.m.main(["tree-place", path])
            self.assertEqual(pathlib.Path(path).read_text(), "keep")
        path, exp = self.temp_file()
        os.rename(path, path + "-old")
        os.symlink(path + "-old", path)
        with self.assertRaises(self.m.Kept):
            self.m.main(["tree-place", path])
        with self.assertRaises(self.m.Kept):
            self.remove_file(path, exp)
        self.assertEqual(pathlib.Path(path + "-old").read_text(), "temporary payload")
        os.mkfifo(self.root + "/_tmp/pipe")
        with self.assertRaises(self.m.Kept):
            self.m.main(["tree-place", self.root + "/_tmp/pipe"])

    def test_file_replaced_inode_or_owner_is_not_reauthorized(self):
        for change in ("inode", "uid"):
            path, exp = self.temp_file(change)
            if change == "inode":
                os.rename(path, path + "-old")
                pathlib.Path(path).write_text("new object")
                os.chown(path, 1000, 1000)
            else:
                os.chown(path, 1001, 1001)
            with self.subTest(change=change), self.assertRaisesRegex(self.m.Kept, "identity changed"):
                self.remove_file(path, exp)
            self.assertTrue(os.path.exists(path))

    def test_file_claimed_replacement_is_restored_without_unlink(self):
        path, exp = self.temp_file()
        original = self.m.rename_noreplace
        moved = False
        def replace(a, name, b, dest):
            nonlocal moved
            if not moved:
                moved = True
                os.rename(path, path + "-old")
                pathlib.Path(path).write_text("replacement")
            return original(a, name, b, dest)
        self.m.rename_noreplace = replace
        with self.assertRaisesRegex(self.m.Kept, "claimed a replacement"):
            self.remove_file(path, exp)
        self.assertEqual(pathlib.Path(path).read_text(), "replacement")
        self.assertEqual(pathlib.Path(path + "-old").read_text(), "temporary payload")

    def test_file_parent_symlink_swap_is_retained(self):
        path, exp = self.temp_file()
        original = self.m.scan
        def swap(real, expected):
            result = original(real, expected)
            os.rename(self.root + "/_tmp", self.root + "/tmp-old")
            os.symlink(self.root + "/tmp-old", self.root + "/_tmp")
            return result
        self.m.scan = swap
        with self.assertRaises((self.m.Kept, OSError)):
            self.remove_file(path, exp)
        self.assertEqual(pathlib.Path(self.root, "tmp-old", os.path.basename(path)).read_text(), "temporary payload")

    def test_file_unknown_claimed_scan_rolls_back_and_stays_visible(self):
        path, exp = self.temp_file()
        calls = 0
        def fail_after_claim(*args):
            nonlocal calls
            calls += 1
            return {"state": "idle"} if calls == 1 else {"state": "unknown", "reason": "proc unreadable"}
        self.m.scan = fail_after_claim
        with self.assertRaisesRegex(self.m.Kept, "proc unreadable; transaction="):
            self.remove_file(path, exp)
        self.assertEqual(pathlib.Path(path).read_text(), "temporary payload")
        with self.m.locked(path) as (fd, _):
            self.assertEqual(self.m.pending(fd), [])

    def test_live_open_file_blocks_both_source_and_claimed_stage(self):
        path, exp = self.temp_file()
        script = 'import sys,time; f=open(sys.argv[1]); print("READY",flush=True); time.sleep(30)'
        proc = subprocess.Popen([sys.executable, "-I", "-S", "-c", script, path],
                                cwd="/", stdout=subprocess.PIPE, text=True, user=1000, group=1000)
        try:
            import select
            self.assertTrue(select.select([proc.stdout], [], [], 5)[0])
            self.assertEqual(proc.stdout.readline().strip(), "READY")
            with self.assertRaisesRegex(self.m.Kept, "open file"):
                self.remove_file(path, exp)
            self.assertTrue(os.path.exists(path))
            original = self.m.scan
            calls = 0
            def after_claim(real, expected):
                nonlocal calls
                calls += 1
                return {"state": "idle"} if calls == 1 else original(real, expected)
            self.m.scan = after_claim
            with self.assertRaisesRegex(self.m.Kept, "open file"):
                self.remove_file(path, exp)
            self.assertEqual(calls, 2)
            self.assertEqual(pathlib.Path(path).read_text(), "temporary payload")
        finally:
            proc.terminate()
            proc.wait()
            proc.stdout.close()


if __name__ == "__main__":
    unittest.main()
