"""Real Linux/root tests; isolated /var/lib fixture, never the installed helper."""

import base64
import hashlib
import hmac
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import types
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
        self.m.KEY_DIR = self.root + "/.cursor-key"
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
        # partial: one page of 100 buckets is never the whole list.
        self.assertEqual((partial["truncated"], partial["pass"], partial["through"]), (True, "read", format(99, "064x")))
        self.assertRegex(partial["cursor"], r"^[A-Za-z0-9_-]+\.[0-9a-f]{64}$")
        original = self.m.os.scandir
        try:
            self.m.os.scandir = lambda _: (_ for _ in ()).throw(PermissionError("denied"))
            with self.assertRaises(PermissionError):
                self.m.main(["cleanup-status"])
        finally:
            self.m.os.scandir = original

    def crowded(self, count, tail_phase="RECOVERY_REQUIRED"):
        """Empty, lock-only and settled buckets first; the only open transaction sorts last."""
        private = self.root + "/" + self.m.PRIVATE
        os.mkdir(private, 0o700)
        paths = sorted((self.root + "/_tmp/t" + str(i) for i in range(count)), key=self.m.path_hash)
        self.settled = {}
        for i, path in enumerate(paths[:-1]):
            if i % 4 == 0:
                os.mkdir(private + "/" + self.m.path_hash(path), 0o700)
            elif i % 4 == 1:
                with self.m.locked(path):
                    pass
            else:
                self.settled[path] = self.bucket_record(path, "DONE" if i % 4 == 2 else "RESTORED")
        return paths, self.bucket_record(paths[-1], tail_phase)

    def page(self, prev):
        return self.m.main(["cleanup-status", "--cursor", prev["cursor"]])

    def walk(self, limit=400):
        pages = [self.m.main(["cleanup-status"])]
        while pages[-1]["state"] == "ok" and pages[-1]["truncated"]:
            self.assertLess(len(pages), limit, "cursor never finished")
            pages.append(self.page(pages[-1]))
        return pages

    def complete(self, pages):
        """complete: one round of consecutive pages, each starting where the last stopped, the last untruncated."""
        self.assertEqual({p["round"] for p in pages}, {pages[0]["round"]})
        self.assertEqual([p["page"] for p in pages], list(range(1, len(pages) + 1)))
        for prev, cur in zip(pages, pages[1:]):
            self.assertEqual(cur["from"], prev["through"])
        self.assertEqual((pages[-1]["state"], pages[-1]["truncated"], pages[-1]["pass"]), ("ok", False, "verify"))
        self.assertNotIn("cursor", pages[-1])
        return [r for p in pages for r in p["rows"]]

    def bucket_listing(self):
        private = self.root + "/" + self.m.PRIVATE
        return {ph: sorted(os.listdir(private + "/" + ph)) for ph in os.listdir(private)}

    def forge(self, cursor, key=None, **change):
        """A cursor body changed by the caller: re-signed with `key`, or carrying the helper's old signature."""
        data, mac = cursor.split(".")
        body = json.loads(base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)))
        body.update(change)
        data = base64.urlsafe_b64encode(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())
        data = data.decode().rstrip("=")
        return data + "." + (mac if key is None else hmac.new(key, data.encode(), hashlib.sha256).hexdigest())

    def test_cleanup_pages_complete_read_beyond_100_with_tail_recovery(self):
        paths, tail = self.crowded(130)
        before = self.bucket_listing()
        first = self.m.main(["cleanup-status"])
        # partial: the first 100 buckets show no rows, which never proves the namespace clear.
        self.assertEqual((first["rows"], first["truncated"], first["through"]), ([], True, self.m.path_hash(paths[99])))
        pages = self.walk()
        self.assertEqual(len(pages), 2)
        # complete: every page walked and re-stamped; the tail RECOVERY_REQUIRED is the only open row.
        self.assertEqual(self.complete(pages), [tail])
        self.assertEqual(pages[-1]["buckets"], 130)
        # Nothing removed to make room: empty, lock-only, DONE and RESTORED buckets all stay.
        self.assertEqual(self.bucket_listing(), before)
        key = os.lstat(self.m.KEY_DIR + "/cursor.key")
        self.assertEqual((key.st_uid, key.st_mode & 0o777, key.st_size), (0, 0o600, 32))
        self.assertEqual(os.lstat(self.m.KEY_DIR).st_mode & 0o777, 0o700)

    def test_cleanup_single_page_round_signs_nothing(self):
        paths, tail = self.crowded(3)
        self.assertEqual(self.complete([self.m.main(["cleanup-status"])]), [tail])
        self.assertFalse(os.path.lexists(self.m.KEY_DIR))

    def test_cleanup_page_bounds_settled_record_bytes_and_entries(self):
        paths, tail = self.crowded(60, "PREPARED")
        private = self.root + "/" + self.m.PRIVATE
        size = max(os.stat(private + "/" + r["pathHash"] + "/" + r["id"] + "/intent.json").st_size
                   for r in [tail, *self.settled.values()])
        read, listed = [], []
        original_read, original_listing = self.m.read_record, self.m.listing

        def counted_read(fd, budget=None):
            got = os.stat("intent.json", dir_fd=fd, follow_symlinks=False).st_size
            rec = original_read(fd, budget)
            read[-1] += got
            return rec

        def counted_listing(fd, budget, limit=None):
            got = original_listing(fd, budget, limit)
            if budget:
                listed[-1] += len(got)
            return got

        self.m.read_record, self.m.listing = counted_read, counted_listing
        self.addCleanup(setattr, self.m, "read_record", original_read)
        self.addCleanup(setattr, self.m, "listing", original_listing)
        # DONE/RESTORED records are paid for like open ones: a page of settled buckets stops at the bound.
        self.m.PAGE_READ_BYTES, self.m.PAGE_ENTRIES = 6 * size, 40
        pages = []
        while not pages or pages[-1]["truncated"]:
            read.append(0)
            listed.append(0)
            pages.append(self.m.main(["cleanup-status", *(["--cursor", pages[-1]["cursor"]] if pages else [])]))
        self.assertEqual(self.complete(pages), [tail])
        self.assertGreater(len(pages), 6)
        self.assertLessEqual(max(read), self.m.PAGE_READ_BYTES)
        self.assertLessEqual(max(listed), self.m.PAGE_ENTRIES)
        settled = sum(os.stat(private + "/" + r["pathHash"] + "/" + r["id"] + "/intent.json").st_size
                      for r in self.settled.values())
        self.assertGreaterEqual(sum(read), settled)  # every settled record was read and paid for
        self.m.read_record, self.m.listing = original_read, original_listing
        self.m.PAGE_READ_BYTES = size - 1
        with self.assertRaisesRegex(self.m.Kept, "exceeds page bound"):
            self.walk()
        self.m.PAGE_READ_BYTES, self.m.PAGE_ENTRIES = 1024 * 1024, 2000
        self.m.NAMESPACE_BUCKETS = 59
        with self.assertRaisesRegex(self.m.Kept, "namespace exceeds round bound"):
            self.m.main(["cleanup-status"])

    def test_cleanup_page_bounds_rows_and_bytes(self):
        paths, tail = self.crowded(100, "PREPARED")
        one = self.walk()
        self.assertEqual((len(one), self.complete(one)), (1, [tail]))
        extra = self.bucket_record(self.root + "/_tmp/extra", "DELETING")
        two = self.walk()
        self.assertEqual(len(two), 2)
        self.assertEqual(sorted(r["id"] for r in self.complete(two)), sorted([tail["id"], extra["id"]]))
        self.m.PAGE_ROWS = 1
        pages = self.walk()
        self.assertEqual(len(self.complete(pages)), 2)
        self.assertTrue(all(len(p["rows"]) <= 1 for p in pages))
        self.bucket_record(tail["identity"]["real"], "CLAIMED", "8")
        with self.assertRaisesRegex(self.m.Kept, "exceeds page bound"):
            self.walk()
        self.m.PAGE_ROWS = 200
        self.m.PAGE_BYTES = 10
        with self.assertRaisesRegex(self.m.Kept, "exceeds page bound"):
            self.walk()

    def test_cleanup_soft_page_time_round_bounds_and_hard_deadline(self):
        paths, tail = self.crowded(12, "PREPARED")
        self.m.PAGE_SOFT_SECONDS = 0
        timed = self.walk()
        # One bucket per page: 12 reads, then 12 re-stamps; every page but the last is partial.
        self.assertEqual(len(timed), 24)
        self.assertEqual(self.complete(timed), [tail])
        self.assertTrue(all(p["truncated"] for p in timed[:-1]))
        self.m.ROUND_PAGES = 5
        with self.assertRaisesRegex(self.m.Kept, "round exceeds page bound"):
            self.walk()
        self.m.ROUND_PAGES = 256
        first = self.m.main(["cleanup-status"])
        self.m.ROUND_SECONDS = 0
        time.sleep(0.01)
        with self.assertRaisesRegex(self.m.Kept, "round exceeds time bound"):
            self.page(first)
        self.m.DEADLINE = time.monotonic() - 1
        with self.assertRaisesRegex(self.m.Kept, "hard deadline"):
            self.m.main(["cleanup-status"])

    def test_cleanup_pages_concurrent_add_and_namespace_replacement(self):
        paths, tail = self.crowded(105)
        first = self.m.main(["cleanup-status"])
        with self.m.locked(self.path):  # a new bucket between pages
            pass
        changed = self.page(first)
        self.assertEqual(changed["state"], "changed")
        self.assertNotIn("rows", changed)
        self.assertEqual(self.complete(self.walk()), [tail])
        private = self.root + "/" + self.m.PRIVATE
        current = self.m.main(["cleanup-status"])
        os.rename(private, private + "-old")
        os.mkdir(private, 0o700)
        for name in os.listdir(private + "-old"):
            os.mkdir(private + "/" + name, 0o700)
        with self.assertRaisesRegex(self.m.Kept, "another namespace"):
            self.page(current)
        os.rename(private, private + "-gone")
        with self.assertRaisesRegex(self.m.Kept, "disappeared"):
            self.page(current)

    def mutate_after_read(self, bucket, mutate):
        """Run `mutate` once, right after `bucket` was read: i.e. while that page is still being read."""
        original, fired = self.m.read_bucket, []

        def wrapped(ph, budget):
            got = original(ph, budget)
            if ph == bucket and not fired:
                fired.append(ph)
                mutate()
            return got

        self.m.read_bucket = wrapped
        self.addCleanup(setattr, self.m, "read_bucket", original)
        return fired

    def update_phase(self, rec, phase):
        with self.m.chain(self.root + "/" + self.m.PRIVATE + "/" + rec["pathHash"] + "/" + rec["id"],
                          private=True) as (fd, _):
            self.m.write_record(fd, dict(rec, phase=phase))

    def test_cleanup_visited_bucket_change_between_pages_restarts(self):
        paths, tail = self.crowded(130)
        first = self.m.main(["cleanup-status"])
        head = self.bucket_record(paths[0], "PREPARED", "9")  # a new transaction in an already read bucket
        self.assertEqual(self.page(first)["state"], "changed")
        restarted = self.walk()
        self.assertEqual(sorted(r["id"] for r in self.complete(restarted)), sorted([tail["id"], head["id"]]))
        restored = next(r for r in self.settled.values() if r["phase"] == "RESTORED")
        self.assertLess(restored["pathHash"], first["through"])  # read on the first page
        for name, mutate in (
            ("phase written in a read transaction", lambda: self.update_phase(head, "DELETING")),
            ("read RESTORED receipt reused as PREPARED", lambda: self.update_phase(restored, "PREPARED")),
        ):
            with self.subTest(name):
                again = self.m.main(["cleanup-status"])
                mutate()
                self.assertEqual(self.page(again)["state"], "changed")
        rows = self.complete(self.walk())
        self.assertEqual(sorted(r["phase"] for r in rows), ["DELETING", "PREPARED", "RECOVERY_REQUIRED"])

    def test_cleanup_change_during_a_page_is_never_complete(self):
        paths, tail = self.crowded(5)
        last = self.m.path_hash(paths[-1])
        original = self.m.read_bucket
        for name, mutate in (
            ("read bucket gains a transaction", lambda: self.bucket_record(paths[0], "PREPARED", "9")),
            ("tail transaction rewritten", lambda: self.update_phase(tail, "DELETING")),
            ("bucket added after the listing", lambda: self.bucket_record(self.root + "/_tmp/late", "RECOVERY_REQUIRED")),
        ):
            with self.subTest(name):
                self.m.read_bucket = original
                self.mutate_after_read(last, mutate)
                reply = self.m.main(["cleanup-status"])
                self.assertEqual(reply["state"], "changed")  # never ok, rows, truncated=false
                self.assertNotIn("rows", reply)
        self.m.read_bucket = original
        rows = self.complete(self.walk())
        self.assertEqual(sorted(r["phase"] for r in rows), ["DELETING", "PREPARED", "RECOVERY_REQUIRED"])
        private = self.root + "/" + self.m.PRIVATE

        def replace():
            os.rename(private, private + "-old")
            os.mkdir(private, 0o700)
            for name in os.listdir(private + "-old"):
                os.mkdir(private + "/" + name, 0o700)

        self.mutate_after_read(last, replace)
        with self.assertRaisesRegex(self.m.Kept, "another namespace"):
            self.m.main(["cleanup-status"])

    def test_cleanup_first_page_waits_out_coarse_timestamps(self):
        paths, tail = self.crowded(3)
        slept, real = [], self.m.time
        self.addCleanup(setattr, self.m, "time", real)
        self.m.time = types.SimpleNamespace(monotonic=real.monotonic, time_ns=real.time_ns,
                                            sleep=lambda s: (slept.append(s), real.sleep(s)))
        reply = self.m.main(["cleanup-status"])
        self.assertEqual((reply["state"], reply["truncated"]), ("ok", False))
        self.assertTrue(slept and all(0 < s <= self.m.RACY_NS / 1e9 for s in slept))
        slept.clear()

        def churn(s):
            slept.append(s)
            self.bucket_record(self.root + "/_tmp/churn" + str(len(slept)), "DONE")

        self.m.RACY_NS = 10 * 10**9  # slow writes must not look old: the sleeps are fake here
        self.m.time = types.SimpleNamespace(monotonic=real.monotonic, time_ns=real.time_ns, sleep=churn)
        self.assertEqual(self.m.main(["cleanup-status"])["state"], "changed")
        self.assertEqual(len(slept), 5)
        # A bucket that keeps being written is never stamped as settled either.
        with self.m.chain(self.root + "/" + self.m.PRIVATE + "/" + tail["pathHash"], private=True) as (fd, _):
            with self.assertRaises(self.m.Moving):
                self.m.settled_mark(fd, self.m.Budget())
        self.assertEqual(len(slept), 8)

    def test_cleanup_page_deadline_covers_first_bucket_lock_and_reads(self):
        paths, tail = self.crowded(3, "PREPARED")
        self.m.PAGE_SECONDS = 0
        with self.assertRaisesRegex(self.m.Kept, "page deadline"):
            self.m.main(["cleanup-status"])
        self.m.PAGE_SECONDS = 0.3
        started = time.monotonic()
        with self.m.locked(tail["identity"]["real"]):
            with self.assertRaisesRegex(self.m.Kept, "page deadline"):  # lock wait on the first bucket
                self.m.main(["cleanup-status"])
        self.assertLess(time.monotonic() - started, 5)
        original = self.m.pending

        def slow(*args, **kwargs):
            time.sleep(0.5)
            return original(*args, **kwargs)

        self.m.pending = slow
        self.addCleanup(setattr, self.m, "pending", original)
        with self.assertRaisesRegex(self.m.Kept, "page deadline"):  # a slow record read
            self.m.main(["cleanup-status"])

    def test_cleanup_budget_stops_reading_inside_one_bucket(self):
        path = self.root + "/_tmp/many"
        for i in range(50):
            self.bucket_record(path, "PREPARED", str(100 + i))
        calls, original = [], self.m.read_record
        self.m.read_record = lambda fd, budget=None: (calls.append(1), original(fd, budget))[1]
        self.addCleanup(setattr, self.m, "read_record", original)
        self.m.PAGE_ROWS = 2
        with self.assertRaisesRegex(self.m.Kept, "exceeds page bound"):
            self.m.main(["cleanup-status"])
        self.assertLess(len(calls), 8)  # stopped at the third row, not after all 50
        self.m.PAGE_ROWS = 200
        self.m.PAGE_ENTRIES = 5
        calls.clear()
        with self.assertRaisesRegex(self.m.Kept, "exceeds page bound"):
            self.m.main(["cleanup-status"])
        self.assertEqual(calls, [])  # entry count refused before any record is read

    def test_cleanup_record_is_refused_before_it_is_parsed_when_the_page_cannot_hold_it(self):
        path = self.root + "/_tmp/few"
        recs = [self.bucket_record(path, "PREPARED", str(100 + i)) for i in range(3)]
        loads, real_json = [], self.m.json
        self.m.json = types.SimpleNamespace(
            loads=lambda data: (loads.append(1), real_json.loads(data))[1], dumps=real_json.dumps)
        self.addCleanup(setattr, self.m, "json", real_json)
        # Room for one record only: the second must be refused on its size, without being parsed.
        self.m.PAGE_BYTES = len(real_json.dumps(recs[0], separators=(",", ":"))) + 50
        with self.assertRaisesRegex(self.m.Kept, "exceeds page bound"):
            self.m.main(["cleanup-status"])
        self.assertEqual(len(loads), 2)  # the probe and the first row; never the second row

    def test_cleanup_page_deadline_after_the_hundredth_bucket_is_not_a_truncated_page(self):
        paths, tail = self.crowded(130)
        slow_bucket = self.m.path_hash(paths[99])
        self.m.PAGE_SECONDS = 2
        original = self.m.read_bucket

        def wrapped(ph, budget):
            got = original(ph, budget)
            if ph == slow_bucket:
                time.sleep(2.2)
            return got

        self.m.read_bucket = wrapped
        self.addCleanup(setattr, self.m, "read_bucket", original)
        with self.assertRaisesRegex(self.m.Kept, "page deadline"):
            self.m.main(["cleanup-status"])

    def test_cleanup_namespace_gains_a_bucket_while_the_last_page_is_read(self):
        paths, tail = self.crowded(3, "DONE")
        first_bucket = sorted(map(self.m.path_hash, paths))[0]
        self.mutate_after_read(first_bucket, lambda: self.bucket_record(self.root + "/_tmp/late", "RECOVERY_REQUIRED"))
        reply = self.m.main(["cleanup-status"])
        self.assertEqual(reply["state"], "changed")  # never state=ok, rows=[], truncated=false
        self.assertNotIn("rows", reply)
        restarted = self.m.main(["cleanup-status"])  # the bounded restart sees the new transaction
        self.assertEqual((restarted["state"], restarted["truncated"]), ("ok", False))
        self.assertEqual([r["phase"] for r in restarted["rows"]], ["RECOVERY_REQUIRED"])

    def test_cleanup_cursor_only_from_this_helper(self):
        paths, tail = self.crowded(130)
        first = self.m.main(["cleanup-status"])
        cursor = first["cursor"]
        names = sorted(os.listdir(self.root + "/" + self.m.PRIVATE))
        keyfile = pathlib.Path(self.m.KEY_DIR, "cursor.key")
        key = keyfile.read_bytes()

        def refuse(arg, why):
            with self.assertRaisesRegex(self.m.Kept, why):
                self.m.main(["cleanup-status", "--cursor", arg])

        # A legal later bucket must not skip the ones before it, however the caller dresses it up:
        # the body, the bucket names and sha256 are all public, the key is not.
        for forged in (names[-1], names[120], names[100]):
            with self.subTest(forged=forged[:8]):
                refuse(self.forge(cursor, after=forged, through=forged), "not issued by this helper")
                for guess in (b"", os.urandom(32), hashlib.sha256(forged.encode()).digest()):
                    refuse(self.forge(cursor, key=guess, after=forged, through=forged), "not issued by this helper")
                data = self.forge(cursor, after=forged).split(".")[0]
                refuse(data + "." + hashlib.sha256(data.encode()).hexdigest(), "not issued by this helper")
        refuse(self.forge(cursor, seal="0" * 64), "not issued by this helper")
        refuse(self.forge(cursor, page=2, **{"pass": "verify"}), "not issued by this helper")
        refuse(self.forge(cursor, mtime="1"), "not issued by this helper")
        refuse(cursor[:-1] + ("0" if cursor[-1] != "0" else "1"), "not issued by this helper")
        # Even under the real key, a body this helper would never write is refused.
        for change in ({"page": 0}, {"after": "../x"}, {"extra": 1}, {"v": 2}):
            refuse(self.forge(cursor, key=key, **change), "invalid cleanup cursor")
        for bad in (["--after", names[100], "--dev", first["namespace"]["dev"]], ["--offset", "100"], ["--cursor"],
                    ["--cursor", cursor, "--cursor", cursor], ["--cursor", "../" + cursor], ["--cursor", "A" * 3000 + "." + "0" * 64]):
            with self.assertRaisesRegex(self.m.Kept, r"cleanup-status \[--cursor C\]"):
                self.m.main(["cleanup-status", *bad])
        # Replaying the helper's own cursor repeats that page; it never moves anywhere else.
        again = self.page(first)
        self.assertEqual(self.page(first), again)
        self.assertEqual(self.complete([first, again]), [tail])
        # A key that is not root-only, a link, or gone (reboot): every outstanding cursor is refused.
        os.chmod(keyfile, 0o644)
        refuse(cursor, "untrusted cleanup cursor key")
        os.chmod(keyfile, 0o600)
        os.chmod(self.m.KEY_DIR, 0o777)
        refuse(cursor, "untrusted private parent")
        os.chmod(self.m.KEY_DIR, 0o700)
        os.rename(keyfile, str(keyfile) + ".x")
        os.symlink(str(keyfile) + ".x", keyfile)
        with self.assertRaises(OSError):
            self.page(first)
        os.unlink(keyfile)
        refuse(cursor, "not issued by this helper")
        fresh = self.walk()
        self.assertNotEqual(keyfile.read_bytes(), key)
        refuse(cursor, "not issued by this helper")
        self.assertEqual(self.complete(fresh), [tail])

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
        os.unlink(private + "/" + "e" * 64)
        os.chmod(intent, 0o644)
        with self.assertRaisesRegex(self.m.Kept, "untrusted intent"):
            self.walk()
        os.chmod(intent, 0o600)
        pathlib.Path(bucket, "a" * 64).write_text("not a transaction")
        with self.assertRaisesRegex(self.m.Kept, "unrecognized transaction entry type"):
            self.walk()
        os.unlink(bucket + "/" + "a" * 64)
        os.unlink(bucket + "/lock")
        os.symlink("/etc/passwd", bucket + "/lock")
        with self.assertRaisesRegex(self.m.Kept, "unrecognized transaction entry type"):
            self.walk()
        os.unlink(bucket + "/lock")
        os.rename(bucket + "/" + tail["id"], bucket + "/" + "b" * 64)
        with self.assertRaisesRegex(self.m.Kept, "transaction directory identity mismatch"):
            self.walk()
        os.rename(bucket + "/" + "b" * 64, bucket + "/" + tail["id"])
        # Every guard lifted: the same tail is read in full again, its lock re-created under the path lock.
        self.assertEqual(self.complete(self.walk()), [tail])

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
