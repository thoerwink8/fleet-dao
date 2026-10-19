"""Fixed root helper. Run only via fleet-agent-scope, with env -i/python -I -S.

No caller-selected executable, proc root, work root, uid exclusion, or import path.
The process scan is bounded evidence at a mandatory gate, not a global snapshot.
"""

import contextlib
import ctypes
import errno
import fcntl
import hashlib
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


class Kept(Exception):
    pass


def check_time():
    if time.monotonic() >= DEADLINE:
        raise Kept("hard deadline exceeded")


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
                st = os.fstat(lock)
                if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
                    raise Kept("untrusted transaction lock")
                while True:
                    check_time()
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        time.sleep(0.02)
                yield fd, q + "/" + ph
            finally:
                os.close(lock)


def read_record(fd):
    h = os.open("intent.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        st = os.fstat(h)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077 or st.st_size > 32768:
            raise Kept("untrusted intent")
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


def write_record(fd, rec):
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


def pending(fd):
    out = []
    for name in os.listdir(fd):
        if name == "lock":
            continue
        if not re.fullmatch(r"[0-9a-f]{64}", name):
            raise Kept("unrecognized transaction entry")
        h = os.open(name, FLAGS, dir_fd=fd)
        try:
            rec = read_record(h)
            if rec["id"] != name:
                raise Kept("transaction directory identity mismatch")
            if rec["phase"] not in ("DONE", "RESTORED"):
                out.append(rec)
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


def main(args):
    if os.geteuid() != 0:
        raise Kept("requires fixed root entry")
    action = args.pop(0) if args else ""
    if action == "capabilities" and not args:
        return {"state": "ok", "features": ["tree-usage", "identity-remove", "cleanup-status", "cleanup-rollback", "locked-adopt", "temporary-files"]}
    if action == "guard-run" and len(args) == 1:
        path = os.path.realpath(args[0])
        if path == BASE + "/" + PRIVATE or path.startswith(BASE + "/" + PRIVATE + "/"):
            raise Kept("reserved transaction namespace")
        return {"state": "ok"}
    if action == "cleanup-status" and not args:
        rows = []
        try:
            with chain(BASE + "/" + PRIVATE, private=True) as (root, _):
                names = os.listdir(root)
                namespace = identity(os.fstat(root), BASE + "/" + PRIVATE)
        except FileNotFoundError:
            return {"state": "ok", "rows": [], "truncated": False, "namespace": None}
        for ph in sorted(names)[:100]:
            if not re.fullmatch(r"[0-9a-f]{64}", ph):
                raise Kept("invalid private namespace entry")
            with chain(BASE + "/" + PRIVATE + "/" + ph, private=True) as (fd, _):
                # Re-open under the same path lock after learning the original path.
                for rec in pending(fd):
                    with locked(rec["identity"]["real"]) as (held, _):
                        rows.extend(pending(held))
                    break
        return {"state": "ok", "rows": rows, "truncated": len(names) > 100,
                "namespace": namespace}
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
