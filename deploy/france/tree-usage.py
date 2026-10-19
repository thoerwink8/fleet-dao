"""Fixed root helper. Run only via fleet-agent-scope, with env -i/python -I -S.

No caller-selected executable, proc root, work root, uid exclusion, or import path.
The process scan is bounded evidence at a mandatory gate, not a global snapshot.
"""

import base64
import bisect
import contextlib
import ctypes
import errno
import fcntl
import hashlib
import hmac
import json
import os
import pwd
import re
import signal
import stat
import sys
import time

BASE = "/var/lib/fleet-work"
PRIVATE = ".cleanup-transactions"
VERSION = 1
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
SESSION_USER = "fleet-agent-carpool"
DEADLINE = time.monotonic() + 110
# One cleanup-status page; a caller only calls the list complete after a page with truncated=false.
# Per page: buckets read, buckets re-stamped by the verify pass, rows and their bytes, intent bytes
# read (settled or not), bucket entries listed or stamped, and the namespace listing itself.
PAGE_BUCKETS = 100
PAGE_CHECKS = 500
PAGE_ROWS = 200
PAGE_BYTES = 96 * 1024
PAGE_READ_BYTES = 1024 * 1024
PAGE_ENTRIES = 2000
NAMESPACE_BUCKETS = 10000
# Soft: no new bucket after this. Hard: every open, lock wait and record read stops at PAGE_SECONDS.
PAGE_SOFT_SECONDS = 10
PAGE_SECONDS = 20
# One round, first page to complete; the signed cursor carries both and the helper refuses past them.
ROUND_PAGES = 256
ROUND_SECONDS = 600
# Timestamps tick coarsely: a stamp must be older than this before it can prove "unchanged".
RACY_NS = 50_000_000
PAGE_UNTIL = None
HEX64 = re.compile(r"[0-9a-f]{64}")
# Root-only per-boot key: a cleanup cursor is accepted back only if this helper signed it.
KEY_DIR = "/run/fleet-dao-tree-usage"
CURSOR = re.compile(r"([A-Za-z0-9_-]{1,2048})\.([0-9a-f]{64})")


class Kept(Exception):
    pass


class Overflow(Kept):
    pass


class Moving(Exception):
    """The namespace moved under the round: the caller restarts it, pages are never stitched."""


def check_time():
    now = time.monotonic()
    if now >= DEADLINE:
        raise Kept("hard deadline exceeded")
    if PAGE_UNTIL is not None and now >= PAGE_UNTIL:
        raise Kept("cleanup page deadline exceeded")


class Budget:
    """What one cleanup-status page may still read; every cost is paid before the read it allows."""

    def __init__(self):
        self.rows, self.size, self.read, self.entries = PAGE_ROWS, PAGE_BYTES, PAGE_READ_BYTES, PAGE_ENTRIES

    def require(self, rows=0, size=0):
        if self.rows < rows or self.size < size:
            raise Overflow("cleanup page bound exceeded")

    def spend(self, rows=0, size=0, read=0, entries=0):
        self.require(rows, size)
        if self.read < read or self.entries < entries:
            raise Overflow("cleanup page bound exceeded")
        self.rows -= rows
        self.size -= size
        self.read -= read
        self.entries -= entries


def interrupted(signum, frame):
    raise Kept("interrupted signal " + str(signum))


def emit(value):
    print(json.dumps({"version": VERSION, **value}, separators=(",", ":")), flush=True)


def identity(st, path):
    return dict(lex=path, real=path, dev=str(st.st_dev), ino=str(st.st_ino), uid=str(st.st_uid))


def stamp(st):
    return (st.st_dev, st.st_ino, st.st_uid, stat.S_IMODE(st.st_mode))


def expected(args):
    if len(args) != 7 or args[1::2] != ["--dev", "--ino", "--uid"]:
        raise Kept("identity required: <path> --dev D --ino I --uid U")
    path = valid_path(args[0])
    values = args[2::2]
    if any(not re.fullmatch(r"0|[1-9][0-9]{0,39}", v) for v in values):
        raise Kept("invalid decimal identity")
    return dict(lex=path, real=path, dev=values[0], ino=values[1], uid=values[2])


def valid_path(path):
    if not path.startswith(BASE + "/") or os.path.normpath(path) != path:
        raise Kept("path outside managed root")
    parts = path[len(BASE) + 1 :].split("/")
    if len(parts) < 2 or parts[0] == PRIVATE:
        raise Kept("reserved or incomplete managed path")
    if any(not re.fullmatch(r"[A-Za-z0-9._-]+", p) or p in (".", "..") for p in parts):
        raise Kept("invalid managed path component")
    return path


@contextlib.contextmanager
def chain(path, create=False, private=False):
    """Open every component relative to the previous FD; never follow a prefix."""
    fds = [os.open("/", FLAGS)]
    marks = [stamp(os.fstat(fds[0]))]
    try:
        for part in path.strip("/").split("/"):
            check_time()
            if create:
                try:
                    os.mkdir(part, 0o700 if private else 0o755, dir_fd=fds[-1])
                except FileExistsError:
                    pass
            nxt = os.open(part, FLAGS, dir_fd=fds[-1])
            fds.append(nxt)
            st = os.fstat(nxt)
            if private and (st.st_uid != 0 or st.st_mode & 0o022):
                raise Kept("untrusted private parent: " + part)
            marks.append(stamp(st))
        yield fds[-1], marks
    finally:
        for fd in reversed(fds):
            os.close(fd)


def parent_marks(path):
    with chain(os.path.dirname(path)) as (_, marks):
        return marks


def parent_unchanged(path, marks):
    if parent_marks(path) != marks:
        raise Kept("source parent chain changed")


def same(st, exp):
    allowed = stat.S_ISDIR(st.st_mode) or (
        stat.S_ISREG(st.st_mode) and os.path.dirname(exp["real"]) == BASE + "/_tmp"
    )
    return allowed and identity(st, exp["real"]) == exp


@contextlib.contextmanager
def place(path):
    with chain(os.path.dirname(path)) as (parent, _):
        st = os.stat(os.path.basename(path), dir_fd=parent, follow_symlinks=False)
        exp = identity(st, path)
        if not same(st, exp):
            raise Kept("only directories or direct _tmp regular files are managed")
        if stat.S_ISDIR(st.st_mode):
            fd = os.open(os.path.basename(path), FLAGS, dir_fd=parent)
            try:
                if not same(os.fstat(fd), exp):
                    raise Kept("tree identity changed before open")
                yield exp
            finally:
                os.close(fd)
        else:
            yield exp


def path_hash(path):
    return hashlib.sha256(path.encode()).hexdigest()


def id_hash(exp):
    return hashlib.sha256(json.dumps(exp, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def trusted_lock(st):
    return stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o077


def wait_flock(lock):
    while True:
        check_time()
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            time.sleep(0.02)


@contextlib.contextmanager
def bucket_lock(fd):
    """The reader's side of the bucket lock every writer holds from before its first namespace touch
    until its last intent write is done. While this is held no write is half done in the bucket, and
    a writer that takes it later touches the namespace root after this reader began, so a cleanup-status
    round either waits here for the writer (bounded by the page deadline) or sees the root move.
    A bucket with no lock file has had no writer past its lock creation; it is refused if it holds
    transactions (bucket_mark)."""
    lock = None
    try:
        seen = os.stat("lock", dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        seen = None
    try:
        if seen is not None:
            if not trusted_lock(seen):
                raise Kept("untrusted transaction lock")
            lock = os.open("lock", os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
            held = os.fstat(lock)
            if not trusted_lock(held) or (held.st_dev, held.st_ino) != (seen.st_dev, seen.st_ino):
                raise Kept("untrusted transaction lock")
            wait_flock(lock)
        yield
    finally:
        if lock is not None:
            os.close(lock)


@contextlib.contextmanager
def locked(path):
    # ROOT_BASE itself must be root-owned and not writable by another identity.
    with chain(BASE, private=True) as (base, _):
        try:
            os.mkdir(PRIVATE, 0o700, dir_fd=base)
        except FileExistsError:
            pass
    q = BASE + "/" + PRIVATE
    with chain(q, private=True) as (root, _):
        ph = path_hash(path)
        try:
            os.mkdir(ph, 0o700, dir_fd=root)
        except FileExistsError:
            pass
        with chain(q + "/" + ph, private=True) as (fd, _):
            lock = os.open("lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
            try:
                if not trusted_lock(os.fstat(lock)):
                    raise Kept("untrusted transaction lock")
                wait_flock(lock)
                yield fd, q + "/" + ph
            finally:
                os.close(lock)


def read_record(fd, budget=None):
    h = os.open("intent.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        st = os.fstat(h)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077 or st.st_size > 32768:
            raise Kept("untrusted intent")
        if budget:
            # Paid before it is read, settled (DONE/RESTORED) or not; and the page must still be
            # able to hold it as a row before it is parsed.
            budget.require(rows=1, size=st.st_size)
            budget.spend(read=st.st_size)
        data = json.loads(os.read(h, 32769))
    finally:
        os.close(h)
    exp = data.get("identity", {})
    path = valid_path(exp.get("real", ""))
    if data.get("version") != VERSION or exp.get("lex") != path:
        raise Kept("invalid intent version/identity")
    if data.get("id") != id_hash(exp) or data.get("pathHash") != path_hash(path):
        raise Kept("intent hash mismatch")
    if data.get("phase") not in ("PREPARED", "CLAIMED", "DELETING", "DONE", "RESTORED", "RECOVERY_REQUIRED"):
        raise Kept("invalid intent phase")
    return data


def touch_namespace():
    """Move the namespace root's stamp. Only this helper writes the root-private namespace; it does
    so, holding the bucket lock, around every transaction it creates and every intent it writes, so
    a cleanup-status round, which re-checks the root stamp on every page, sees any change to the
    pending set made while it ran, including in a bucket it already read and re-stamped. The stamp
    alone cannot tell a write still in flight from none: readers take the bucket lock (bucket_lock)
    for every bucket in both passes, so a write that spans a reader's look at its bucket is waited
    for, and one that starts later touches the root inside the round."""
    with chain(BASE + "/" + PRIVATE, private=True) as (root, _):
        os.utime(root)


def write_record(fd, rec):
    touch_namespace()
    try:
        _write_record(fd, rec)
    finally:
        touch_namespace()


def _write_record(fd, rec):
    tmp = "intent.next"
    h = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        data = json.dumps(rec, sort_keys=True).encode()
        with os.fdopen(h, "wb", closefd=False) as out:
            out.write(data)
            out.flush()
        os.fsync(h)
    finally:
        os.close(h)
    os.replace(tmp, "intent.json", src_dir_fd=fd, dst_dir_fd=fd)
    os.fsync(fd)


def listing(fd, budget, limit=None):
    """Directory names, each paid for (or counted against `limit`) before the next one is read."""
    out = []
    with os.scandir(fd) as it:
        for entry in it:
            check_time()
            if budget:
                budget.spend(entries=1)
            elif len(out) >= limit:
                raise Kept("cleanup namespace exceeds round bound")
            out.append(entry.name)
    return out


def pending(fd, budget=None):
    """Open transactions of one bucket; with a budget every entry and row is paid for before the next read."""
    out = []
    for name in listing(fd, budget) if budget else os.listdir(fd):
        check_time()
        if name == "lock":
            if not trusted_lock(os.stat(name, dir_fd=fd, follow_symlinks=False)):
                raise Kept("untrusted transaction lock")
            continue
        if not HEX64.fullmatch(name):
            raise Kept("unrecognized transaction entry")
        h = os.open(name, FLAGS, dir_fd=fd)
        try:
            rec = read_record(h, budget)
            if rec["id"] != name:
                raise Kept("transaction directory identity mismatch")
            if rec["phase"] not in ("DONE", "RESTORED"):
                out.append(rec)
                if budget:
                    budget.spend(rows=1, size=len(json.dumps(rec, separators=(",", ":"))))
        finally:
            os.close(h)
    return out


def scan(real, exp):
    """All TGIDs and TIDs, pinned proc FDs. No uid/name/ancestor exclusions."""
    regular = stat.S_ISREG(os.stat(real, follow_symlinks=False).st_mode)
    until = min(DEADLINE, time.monotonic() + 10)
    seen = 0
    previous = None
    for _ in range(4):
        check_time()
        if time.monotonic() >= until:
            raise Kept("process scan deadline")
        instances = set()
        with chain("/proc") as (proc, _):
            for pid in os.listdir(proc):
                if not pid.isdigit():
                    continue
                check_time()
                if time.monotonic() >= until:
                    raise Kept("process scan deadline")
                try:
                    group = os.open(pid, FLAGS, dir_fd=proc)
                except FileNotFoundError:
                    continue
                try:
                    tasks = os.open("task", FLAGS, dir_fd=group)
                    try:
                        names = os.listdir(tasks)
                        if not names:
                            raise Kept("empty task list: " + pid)
                        for tid in names:
                            if not tid.isdigit():
                                continue
                            try:
                                thread = os.open(tid, FLAGS, dir_fd=tasks)
                            except FileNotFoundError:
                                continue
                            try:
                                def read(name):
                                    h = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=thread)
                                    try:
                                        return os.read(h, 65536).decode()
                                    finally:
                                        os.close(h)

                                raw = read("stat")
                                fields = raw[raw.rfind(")") + 2 :].split()
                                if len(fields) < 20:
                                    raise Kept("truncated thread stat: " + tid)
                                start = fields[19]
                                status = dict(line.split(":", 1) for line in read("status").splitlines() if ":" in line)
                                state = fields[0]
                                seen += 1
                                instances.add((pid, tid, start))
                                try:
                                    cwd = os.readlink("cwd", dir_fd=thread)
                                except FileNotFoundError:
                                    if state in ("Z", "X", "x") or status.get("Kthread", "").strip() == "1":
                                        continue
                                    # ESRCH from an already opened proc FD proves exit; a live
                                    # thread with no cwd does not prove that its siblings exited.
                                    try:
                                        latest = read("stat")
                                    except (ProcessLookupError, FileNotFoundError):
                                        continue
                                    if latest[latest.rfind(")") + 2 :].split()[0] in ("Z", "X", "x"):
                                        continue
                                    raise Kept("live thread cwd unavailable: " + tid)
                                if cwd.removesuffix(" (deleted)") == real or cwd.startswith(real + "/"):
                                    return {"state": "busy", "scanned": seen, "failed": 0, "reason": "cwd in tree, tid=" + tid}
                                # A temporary file cannot be a cwd. Compare its inode against
                                # open FDs, including after it moves into the private claim.
                                if regular:
                                    handles = os.open("fd", FLAGS, dir_fd=thread)
                                    try:
                                        for name in os.listdir(handles):
                                            check_time()
                                            if time.monotonic() >= until:
                                                raise Kept("open file scan deadline")
                                            try:
                                                opened = os.stat(name, dir_fd=handles)
                                            except FileNotFoundError:
                                                continue  # Descriptor closed during enumeration.
                                            if str(opened.st_dev) == exp["dev"] and str(opened.st_ino) == exp["ino"]:
                                                return {"state": "busy", "scanned": seen, "failed": 0, "reason": "open file in use, tid=" + tid}
                                    finally:
                                        os.close(handles)
                                after = read("stat")
                                if after[after.rfind(")") + 2 :].split()[19] != start:
                                    raise Kept("thread identity changed: " + tid)
                            except (FileNotFoundError, ProcessLookupError):
                                # Missing status/cwd is not evidence of exit while stat lives.
                                try:
                                    read("stat")
                                except (FileNotFoundError, ProcessLookupError):
                                    continue
                                raise Kept("live thread metadata unavailable: " + tid)
                            finally:
                                os.close(thread)
                    finally:
                        os.close(tasks)
                except (FileNotFoundError, ProcessLookupError):
                    try:
                        os.stat("stat", dir_fd=group, follow_symlinks=False)
                    except (FileNotFoundError, ProcessLookupError):
                        continue
                    raise Kept("live process task enumeration unavailable: " + pid)
                finally:
                    os.close(group)
        if previous == instances:
            return {"state": "idle", "scanned": seen, "failed": 0, "reason": "bounded complete thread scan"}
        previous = instances
    raise Kept("process enumeration did not converge")


def rename_noreplace(srcfd, src, dstfd, dst):
    libc = ctypes.CDLL(None, use_errno=True)
    fn = libc.renameat2
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    if fn(srcfd, os.fsencode(src), dstfd, os.fsencode(dst), 1) != 0:
        value = ctypes.get_errno()
        raise OSError(value, os.strerror(value))


def rollback(fd, rec):
    if rec["phase"] in ("DELETING", "DONE") or rec.get("destructive"):
        raise Kept("partial deletion cannot be rolled back; recovery required")
    path = rec["identity"]["real"]
    parent_unchanged(path, [tuple(x) for x in rec["parents"]])
    with chain(os.path.dirname(path)) as (parent, _):
        try:
            os.stat("tree", dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            if not same(os.stat(os.path.basename(path), dir_fd=parent, follow_symlinks=False), rec["identity"]):
                raise Kept("neither original object nor claimed payload can be restored")
        else:
            rename_noreplace(fd, "tree", parent, os.path.basename(path))
            os.fsync(parent)
            os.fsync(fd)
        rec["phase"] = "RESTORED"
        write_record(fd, rec)


def erase(fd, dev):
    for name in os.listdir(fd):
        check_time()
        st = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if st.st_dev != dev:
            raise Kept("cross-device child retained")
        if stat.S_ISDIR(st.st_mode):
            child = os.open(name, FLAGS, dir_fd=fd)
            try:
                if stamp(os.fstat(child)) != stamp(st):
                    raise Kept("child replaced before deletion")
                erase(child, dev)
                if stamp(os.stat(name, dir_fd=fd, follow_symlinks=False)) != stamp(st):
                    raise Kept("child replaced during deletion")
                os.rmdir(name, dir_fd=fd)
            finally:
                os.close(child)
        else:
            os.unlink(name, dir_fd=fd)


def remove(pathfd, qpath, exp):
    path = exp["real"]
    entries = pending(pathfd)
    if entries:
        raise Kept("unresolved cleanup transaction: " + entries[0]["id"])
    with chain(os.path.dirname(path)) as (parent, marks):
        leaf = os.path.basename(path)
        st = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        if not same(st, exp):
            raise Kept("original identity changed")
        proof = scan(path, exp)
        if proof["state"] != "idle":
            raise Kept(proof["reason"])
        parent_unchanged(path, marks)
        tx = id_hash(exp)
        touch_namespace()  # A new transaction directory; the first intent write touches it again.
        try:
            os.mkdir(tx, 0o700, dir_fd=pathfd)
        except FileExistsError:
            existing = os.open(tx, FLAGS, dir_fd=pathfd)
            try:
                prior = read_record(existing)
                if prior["phase"] != "RESTORED" or prior["identity"] != exp:
                    raise Kept("identity already has a cleanup receipt; inspect cleanup-status")
                try:
                    os.stat("tree", dir_fd=existing, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise Kept("restored transaction still has a payload")
            finally:
                os.close(existing)
        fd = os.open(tx, FLAGS, dir_fd=pathfd)
        rec = dict(version=VERSION, identity=exp, pathHash=path_hash(path), id=tx, parents=marks, phase="PREPARED", destructive=False)
        try:
            write_record(fd, rec)
            os.fsync(pathfd)
            rename_noreplace(parent, leaf, fd, "tree")
            os.fsync(parent)
            os.fsync(fd)
            claimed = os.stat("tree", dir_fd=fd, follow_symlinks=False)
            if not same(claimed, exp):
                raise Kept("claimed a replacement; never delete it")
            parent_unchanged(path, marks)
            rec["phase"] = "CLAIMED"
            write_record(fd, rec)
            regular = stat.S_ISREG(claimed.st_mode)
            # A regular payload is pinned by the root-private claim, not an open
            # file FD that would itself count as active use in the second scan.
            target = None if regular else os.open("tree", FLAGS, dir_fd=fd)
            try:
                actual = qpath + "/" + tx + "/tree"
                pinned = os.stat("tree", dir_fd=fd, follow_symlinks=False) if regular else os.fstat(target)
                if not same(pinned, exp) or (not regular and os.readlink("/proc/self/fd/" + str(target)) != actual):
                    raise Kept("claimed path/FD identity mismatch")
                proof = scan(actual, exp)
                if proof["state"] != "idle":
                    raise Kept(proof["reason"])
                parent_unchanged(path, marks)
                rec["phase"] = "DELETING"
                rec["destructive"] = True
                write_record(fd, rec)
                if not regular:
                    erase(target, st.st_dev)
                if not same(os.stat("tree", dir_fd=fd, follow_symlinks=False), exp):
                    raise Kept("claimed root identity changed")
                if regular:
                    os.unlink("tree", dir_fd=fd)
                else:
                    os.rmdir("tree", dir_fd=fd)
                os.fsync(fd)
                rec["phase"] = "DONE"
                write_record(fd, rec)
                try:
                    os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    return {"state": "removed", "identity": exp, "transaction": tx}
                raise Kept("authorized object removed; replacement at source preserved")
            finally:
                if target is not None:
                    os.close(target)
        except BaseException as error:
            if rec["phase"] != "DONE":
                try:
                    if not rec.get("destructive"):
                        rollback(fd, rec)
                    else:
                        raise Kept("deletion may be partial")
                except BaseException as restore_error:
                    rec["phase"] = "RECOVERY_REQUIRED"
                    rec["reason"] = str(error)[:500] + "; recovery: " + str(restore_error)[:500]
                    with contextlib.suppress(BaseException):
                        write_record(fd, rec)
            raise Kept(str(error) + "; transaction=" + qpath + "/" + tx)
        finally:
            os.close(fd)


CURSOR_FIELDS = {"v", "dev", "ino", "mtime", "ctime", "round", "started", "page", "pass", "after", "through", "seal", "check"}
NUMBER = re.compile(r"0|[1-9][0-9]{0,39}")
ZERO = "0" * 64


def cursor_key(create):
    """The per-boot signing key: root-owned 0600, exactly 32 bytes, under a root-private KEY_DIR.

    Created once (never replaced, so cursors already signed stay valid); a cursor page never creates
    it, so a lost key (reboot) refuses every outstanding cursor instead of accepting any.
    """
    try:
        with chain(KEY_DIR, create=create, private=True) as (fd, _):
            for _ in range(2):
                try:
                    h = os.open("cursor.key", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                except FileNotFoundError:
                    if not create:
                        break
                    tmp = "cursor.key.%d" % os.getpid()
                    with contextlib.suppress(FileNotFoundError):
                        os.unlink(tmp, dir_fd=fd)
                    w = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
                    try:
                        if os.write(w, os.urandom(32)) != 32:
                            raise Kept("short cleanup cursor key write")
                        os.fsync(w)
                    finally:
                        os.close(w)
                    try:
                        os.link(tmp, "cursor.key", src_dir_fd=fd, dst_dir_fd=fd)
                    except FileExistsError:
                        pass  # Another page made it first; use that one.
                    finally:
                        os.unlink(tmp, dir_fd=fd)
                    continue
                try:
                    st = os.fstat(h)
                    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077 or st.st_size != 32:
                        raise Kept("untrusted cleanup cursor key")
                    key = os.read(h, 33)
                finally:
                    os.close(h)
                if len(key) != 32:
                    raise Kept("untrusted cleanup cursor key")
                return key
    except FileNotFoundError:
        pass
    raise Kept("cleanup cursor was not issued by this helper")


def sign(body):
    data = base64.urlsafe_b64encode(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())
    data = data.decode().rstrip("=")
    return data + "." + hmac.new(cursor_key(True), data.encode(), hashlib.sha256).hexdigest()


def open_cursor(args):
    """Only a cursor this helper signed: no caller-chosen bucket, offset, digest, page or bound."""
    if not args:
        return None
    got = CURSOR.fullmatch(args[1]) if len(args) == 2 and args[0] == "--cursor" else None
    if not got:
        raise Kept("cleanup-status [--cursor C]")
    data, mac = got.groups()
    expected_mac = hmac.new(cursor_key(False), data.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expected_mac):
        raise Kept("cleanup cursor was not issued by this helper")
    try:
        body = json.loads(base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)))
    except ValueError:
        body = None
    valid = (
        isinstance(body, dict) and set(body) == CURSOR_FIELDS and body["v"] == 1
        and all(isinstance(body[k], str) and NUMBER.fullmatch(body[k]) for k in ("dev", "ino", "mtime", "ctime", "started"))
        and type(body["page"]) is int and body["page"] >= 2 and body["pass"] in ("read", "verify")
        and isinstance(body["round"], str) and re.fullmatch(r"[0-9a-f]{32}", body["round"])
        and all(body[k] is None or (isinstance(body[k], str) and HEX64.fullmatch(body[k])) for k in ("after", "through"))
        and all(isinstance(body[k], str) and HEX64.fullmatch(body[k]) for k in ("seal", "check"))
    )
    if not valid:
        raise Kept("invalid cleanup cursor")
    return body


def mark(name, st):
    return "%s %d %d %d %d\n" % (name, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def bucket_mark(fd, budget):
    """Stamps of one bucket, its entries and every intent, no record parsed; paid per entry.

    Any transaction added, phase written, rolled back or replaced moves one. Returns the digest
    and the newest timestamp seen.
    """
    st = os.fstat(fd)
    lines, newest = [mark(".", st)], max(st.st_mtime_ns, st.st_ctime_ns)
    names = sorted(listing(fd, budget))
    if names and "lock" not in names:
        raise Kept("transaction bucket without its lock")
    for name in names:
        check_time()
        if name != "lock" and not HEX64.fullmatch(name):
            raise Kept("unrecognized transaction entry")
        cs = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if name == "lock":
            if not trusted_lock(cs):
                raise Kept("untrusted transaction lock")
        elif not stat.S_ISDIR(cs.st_mode):
            raise Kept("unrecognized transaction entry type")
        stamps = [cs]
        if name != "lock":
            budget.spend(entries=1)
            h = os.open(name, FLAGS, dir_fd=fd)
            try:
                stamps = [os.fstat(h)]
                try:
                    stamps.append(os.stat("intent.json", dir_fd=h, follow_symlinks=False))
                except FileNotFoundError:
                    lines.append(name + " intent -\n")
            finally:
                os.close(h)
        for s in stamps:
            lines.append(mark(name, s))
            newest = max(newest, s.st_mtime_ns, s.st_ctime_ns)
    return hashlib.sha256("".join(lines).encode()).hexdigest(), newest


def settled_mark(fd, budget):
    """A bucket stamp that can prove "unchanged" later: every timestamp in it was already older
    than RACY_NS when stamping began, so a write after it cannot land in the same coarse tick."""
    for _ in range(3):
        began = time.time_ns()
        digest, newest = bucket_mark(fd, budget)
        wait = RACY_NS - (began - newest)
        if wait <= 0:
            return digest
        check_time()
        time.sleep(min(wait, RACY_NS) / 1e9)
    raise Moving()


def read_bucket(ph, budget):
    """Open rows of one bucket and its settled stamp, taken before its records are read, both under
    the bucket lock: settled or not, empty or not, no writer is half way through an intent meanwhile."""
    with chain(BASE + "/" + PRIVATE + "/" + ph, private=True) as (fd, _):
        with bucket_lock(fd):
            seal = settled_mark(fd, budget)
            rows = pending(fd, budget)
            if any(rec["pathHash"] != ph for rec in rows):
                raise Kept("transaction bucket identity mismatch")
            return rows, seal


def check_bucket(ph, budget):
    with chain(BASE + "/" + PRIVATE + "/" + ph, private=True) as (fd, _):
        with bucket_lock(fd):
            return bucket_mark(fd, budget)[0]


def fold(digest, ph, stamp_digest):
    return hashlib.sha256((digest + ph + stamp_digest).encode()).hexdigest()


def bound(st, cursor):
    """The namespace a round began on, with the stamp it began with; another one is never continued."""
    if (str(st.st_dev), str(st.st_ino)) != (cursor["dev"], cursor["ino"]):
        raise Kept("cleanup cursor bound to another namespace")
    if (str(st.st_mtime_ns), str(st.st_ctime_ns)) != (cursor["mtime"], cursor["ctime"]):
        raise Moving()


def namespace_root(cursor):
    """The namespace root and its sorted bucket names (at most NAMESPACE_BUCKETS), listed between
    two equal stamps. A first page waits until the stamp is older than RACY_NS, so any later add,
    removal or rename of a bucket moves it; a cursor page must find the stamp its round began with."""
    for _ in range(5):
        with chain(BASE + "/" + PRIVATE, private=True) as (root, _):
            began = time.time_ns()
            before = os.fstat(root)
            if cursor:
                bound(before, cursor)
            wait = RACY_NS - (began - max(before.st_mtime_ns, before.st_ctime_ns))
            if not cursor and wait > 0:
                check_time()
                time.sleep(min(wait, RACY_NS) / 1e9)
                continue
            names = sorted(listing(root, None, NAMESPACE_BUCKETS))
            after = os.fstat(root)
            if mark("", after) != mark("", before) or after.st_dev != before.st_dev:
                if cursor:
                    raise Moving()
                continue
            if any(not HEX64.fullmatch(ph) for ph in names):
                raise Kept("invalid private namespace entry")
            return after, names
    raise Moving()


def cleanup_page(args):
    """One bounded page of a round over the sorted buckets; never an atomic snapshot across pages.

    A round first reads every bucket (rows, plus a settled stamp folded into `seal`), then
    re-stamps every bucket (folded into `check`). It is complete only when both agree and the
    namespace root still has the stamp the round began with: a bucket added, removed or replaced,
    or a transaction added, rewritten or rolled back anywhere during the round, returns
    state=changed and the caller restarts the round. The root stamp covers changes inside buckets
    too, including ones already re-stamped: every helper write to the pending set touches it
    (touch_namespace), and it is re-checked at the end of every page, the last one included. Position, digests and round bounds travel in
    a cursor signed with a root-only key, so a caller can only continue where this helper stopped.
    """
    global PAGE_UNTIL
    cursor = open_cursor(args)
    PAGE_UNTIL = time.monotonic() + PAGE_SECONDS
    try:
        return read_page(cursor)
    except Moving:
        return {"state": "changed", "reason": "namespace changed during the round"}
    finally:
        PAGE_UNTIL = None


def read_page(cursor):
    q = BASE + "/" + PRIVATE
    if cursor and cursor["page"] > ROUND_PAGES:
        raise Kept("cleanup round exceeds page bound")
    if cursor and time.time_ns() - int(cursor["started"]) > ROUND_SECONDS * 10**9:
        raise Kept("cleanup round exceeds time bound")
    try:
        st, names = namespace_root(cursor)
    except FileNotFoundError:
        if cursor:
            raise Kept("cleanup namespace disappeared during paging")
        return {"state": "ok", "rows": [], "truncated": False, "namespace": None}
    namespace = identity(st, q)
    c = dict(cursor or {
        "v": 1, "dev": namespace["dev"], "ino": namespace["ino"], "mtime": str(st.st_mtime_ns),
        "ctime": str(st.st_ctime_ns), "round": os.urandom(16).hex(), "started": str(time.time_ns()), "page": 1,
        "pass": "read", "after": None, "through": None, "seal": ZERO, "check": ZERO})
    if c["after"] is not None and c["after"] not in names:
        raise Kept("cleanup cursor is not a namespace bucket")
    covered, rows, budget, began = c["through"], [], Budget(), time.monotonic()
    done, finished = {"read": 0, "verify": 0}, False
    while True:
        check_time()
        pos = bisect.bisect_right(names, c["after"]) if c["after"] else 0
        if pos == len(names):
            if c["pass"] == "verify":
                finished = True
                break
            c["pass"], c["after"] = "verify", None
            continue
        if done[c["pass"]] >= (PAGE_BUCKETS if c["pass"] == "read" else PAGE_CHECKS):
            break
        units = done["read"] + done["verify"]
        if units and time.monotonic() - began >= PAGE_SOFT_SECONDS:
            break
        ph = names[pos]
        try:
            if c["pass"] == "read":
                got, digest = read_bucket(ph, budget)
            else:
                digest = check_bucket(ph, budget)
        except Overflow:
            if not units:
                raise Kept("cleanup bucket exceeds page bound: " + ph)
            break
        if c["pass"] == "read":
            rows.extend(got)
            c["seal"], c["through"] = fold(c["seal"], ph, digest), ph
        else:
            c["check"] = fold(c["check"], ph, digest)
        c["after"] = ph
        done[c["pass"]] += 1
    check_time()
    # Re-resolved by path: the same namespace with the stamp the round began with, or no page.
    try:
        with chain(q, private=True) as (root, _):
            bound(os.fstat(root), c)
    except FileNotFoundError:
        raise Kept("cleanup namespace disappeared during paging")
    if finished and c["check"] != c["seal"]:
        raise Moving()
    reply = {"state": "ok", "rows": rows, "truncated": not finished, "namespace": namespace,
             "round": c["round"], "page": c["page"], "pass": c["pass"], "from": covered, "through": c["through"],
             "buckets": len(names)}
    if not finished:
        c["page"] += 1
        reply["cursor"] = sign(c)
    return reply


def main(args):
    if os.geteuid() != 0:
        raise Kept("requires fixed root entry")
    action = args.pop(0) if args else ""
    if action == "capabilities" and not args:
        return {"state": "ok", "features": ["tree-usage", "identity-remove", "cleanup-status", "cleanup-rollback", "locked-adopt", "temporary-files", "cleanup-status-pages"]}
    if action == "guard-run" and len(args) == 1:
        path = os.path.realpath(args[0])
        if path == BASE + "/" + PRIVATE or path.startswith(BASE + "/" + PRIVATE + "/"):
            raise Kept("reserved transaction namespace")
        return {"state": "ok"}
    if action == "cleanup-status":
        return cleanup_page(args)
    if action == "cleanup-rollback" and len(args) == 2 and all(re.fullmatch(r"[0-9a-f]{64}", x) for x in args):
        q = BASE + "/" + PRIVATE + "/" + args[0]
        with chain(q + "/" + args[1], private=True) as (fd, _):
            rec = read_record(fd)
            if rec["pathHash"] != args[0] or rec["id"] != args[1]:
                raise Kept("recovery identity mismatch")
            with locked(rec["identity"]["real"]):
                rec = read_record(fd)
                rollback(fd, rec)
            return {"state": "restored", "identity": rec["identity"], "transaction": rec["id"]}
    if action == "adopt" and len(args) == 3 and args[1:] == ["--user", SESSION_USER]:
        path = valid_path(args[0])
        uid = pwd.getpwnam(SESSION_USER).pw_uid
        gid = pwd.getpwnam(SESSION_USER).pw_gid
        with locked(path) as (tx, _):
            if pending(tx):
                raise Kept("unresolved transaction prevents adopt")
            with chain(os.path.dirname(path), create=True) as (parent, _):
                leaf = os.path.basename(path)
                try:
                    os.mkdir(leaf, 0o700, dir_fd=parent)
                except FileExistsError:
                    pass
                with chain(path) as (tree, _):
                    with open("/proc/sys/fs/protected_hardlinks") as protection:
                        hardlinks = protection.read().strip()
                    if hardlinks != "1":
                        raise Kept("protected_hardlinks required")
                    def chown(fd):
                        check_time()
                        for name in os.listdir(fd):
                            s = os.stat(name, dir_fd=fd, follow_symlinks=False)
                            if stat.S_ISDIR(s.st_mode):
                                h = os.open(name, FLAGS, dir_fd=fd)
                                try:
                                    chown(h)
                                finally:
                                    os.close(h)
                            else:
                                os.chown(name, uid, gid, dir_fd=fd, follow_symlinks=False)
                        os.fchown(fd, uid, gid)
                    chown(tree)
                    return {"state": "adopted", "identity": identity(os.fstat(tree), path)}
    if action == "tree-place" and len(args) == 1:
        path = valid_path(args[0])
        with locked(path) as (tx, _):
            if pending(tx):
                raise Kept("unresolved cleanup transaction")
            try:
                with place(path) as exp:
                    return {"state": "ok", "identity": exp}
            except FileNotFoundError:
                return {"state": "gone"}
    if action in ("tree-usage", "remove"):
        exp = expected(args)
        path = exp["real"]
        with locked(path) as (tx, q):
            if action == "remove":
                return remove(tx, q, exp)
            if pending(tx):
                raise Kept("unresolved cleanup transaction")
            with place(path) as current:
                if current != exp:
                    raise Kept("tree identity mismatch")
                result = scan(path, exp)
                with place(path) as again:
                    if again != exp:
                        raise Kept("tree identity changed during scan")
                return {**result, "identity": exp}
    raise Kept("unsupported fixed operation or arguments")


if __name__ == "__main__":
    os.chdir("/")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.setitimer(signal.ITIMER_REAL, 110)
    try:
        emit(main(sys.argv[1:]))
    except BaseException as error:
        emit({"state": "unknown", "failed": 1, "reason": (type(error).__name__ + ": " + str(error))[:2000]})
        sys.exit(1)
