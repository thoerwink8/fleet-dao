#!/usr/bin/python3
"""Trusted, root-owned bootstrap only; candidate Node starts after privilege drop.

Install from reviewed/merged bytes, never execute a writable worktree as root.
All networking and /proc mounts below are private to this one invocation.
"""
import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import pwd
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

LIMIT = 15 * 60
LEASE = 10
PREFIX = "FLEET_ISOLATED_RESOURCE_RECEIPT="


def namespace(kind):
    return os.readlink("/proc/self/ns/" + kind)


def trusted_self():
    path = os.path.abspath(__file__)
    current = path
    while True:
        st = os.lstat(current)
        if stat.S_ISLNK(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError("bootstrap and all parents must be root-owned, non-writable, non-links")
        if current == "/":
            break
        current = os.path.dirname(current)
    with open(path, "rb") as stream:
        return path, hashlib.sha256(stream.read()).hexdigest()


def drop_privileges(uid):
    account = pwd.getpwuid(uid)
    if uid <= 0 or account.pw_gid <= 0:
        raise RuntimeError("a real non-root account is required")
    libc = ctypes.CDLL(None, use_errno=True)
    # Bound privileges before executing any candidate-controlled bytes.
    for capability in range(64):
        if libc.prctl(24, capability, 0, 0, 0) != 0 and ctypes.get_errno() != errno.EINVAL:
            raise OSError(ctypes.get_errno(), "PR_CAPBSET_DROP")
    if libc.prctl(47, 4, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_CAP_AMBIENT_CLEAR_ALL")
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(uid)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS")
    return account


def enable_loopback():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        request = struct.pack("16sh", b"lo", 0)
        flags = struct.unpack("16sh", fcntl.ioctl(sock.fileno(), 0x8913, request)[:18])[1]
        fcntl.ioctl(sock.fileno(), 0x8914, struct.pack("16sh", b"lo", flags | 1))


def processes():
    return [int(p) for p in os.listdir("/proc") if p.isdigit() and int(p) != os.getpid()]


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return
        except ChildProcessError:
            return


def clean_children():
    reap()
    original = processes()
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in processes():
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        end = time.monotonic() + 2
        while time.monotonic() < end:
            reap()
            if not processes():
                return len(original), 0
            time.sleep(0.02)
    reap()
    return len(original), len(processes())


def inside(args):
    if os.getpid() != 1 or namespace("net") == args.parent_net or namespace("pid") == args.parent_pid:
        raise RuntimeError("bootstrap is not in its own PID/network namespace")
    enable_loopback()
    account = drop_privileges(args.uid)
    # Root never parses candidate input, reads candidate files or executes Node.
    if not os.path.isabs(args.tmpdir) or not os.path.isdir(args.tmpdir):
        raise RuntimeError("prepared TMPDIR must exist")
    fields = dict(line.split(":", 1) for line in open("/proc/self/status") if ":" in line)
    record = {
        "schema": 1, "uid": os.getuid(), "gid": os.getgid(),
        "parentNetns": args.parent_net, "netns": namespace("net"),
        "parentPidns": args.parent_pid, "pidns": namespace("pid"),
        "capEff": fields["CapEff"].strip(), "noNewPrivs": int(fields["NoNewPrivs"]),
        "cancelled": False, "timedOut": False, "orphaned": False,
        "remaining": None, "status": 2, "payloadDelivered": False,
        "receivedBytes": 0, "deliveredBytes": 0,
    }
    child = None
    interrupted = False

    def stop(_sig, _frame):
        nonlocal interrupted
        interrupted = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    started = time.monotonic()
    pending = b""
    try:
        # One JSON line followed by a live lease, not EOF-delimited test input.
        chunks = []
        last_input = started
        while True:
            now = time.monotonic()
            if interrupted:
                record["cancelled"] = True
                raise RuntimeError("test input cancelled")
            if now - started >= LIMIT:
                record["timedOut"] = True
                raise RuntimeError("test input exceeded absolute transport limit")
            if now - last_input >= LEASE:
                record["cancelled"] = True
                raise RuntimeError("test input lease expired")
            if select.select([0], [], [], 0.2)[0]:
                data = os.read(0, 65536)
                if not data:
                    record["cancelled"] = True
                    raise RuntimeError("test input closed before payload")
                last_input = time.monotonic()
                record["receivedBytes"] += len(data)
                if record["receivedBytes"] > 128 * 1024 * 1024:
                    raise RuntimeError("test payload exceeds transport limit")
                newline = data.find(b"\n")
                if newline >= 0:
                    chunks.append(data[:newline])
                    pending = data[newline + 1:]
                    break
                chunks.append(data)
        payload = b"".join(chunks)
        del chunks
        # Node is executed without shell, after setuid/capability removal.
        command = args.command
        if not command or not os.path.isabs(command[0]):
            raise RuntimeError("explicit absolute Linux Node is required")
        environment = {
            "HOME": account.pw_dir, "USER": account.pw_name, "LOGNAME": account.pw_name,
            "PATH": os.path.dirname(command[0]) + ":/usr/bin:/bin", "TMPDIR": args.tmpdir,
        }
        child = subprocess.Popen(command, stdin=subprocess.PIPE, env=environment, close_fds=True)
        os.set_blocking(child.stdin.fileno(), False)
        sent = 0
        last_pulse = time.monotonic()
        while child.poll() is None:
            now = time.monotonic()
            if interrupted:
                record["cancelled"] = True
                break
            if now - started >= LIMIT:
                record["timedOut"] = True
                break
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if line != b"keepalive":
                    record["cancelled"] = True
                    break
                last_pulse = now
            if record["cancelled"]:
                break
            if now - last_pulse >= LEASE:
                record["cancelled"] = True
                break
            writers = [] if record["payloadDelivered"] else [child.stdin]
            readers, writable, _ = select.select([0], writers, [], 0.1)
            if readers:
                data = os.read(0, 4096)
                if not data:
                    record["cancelled"] = True
                    break
                pending += data
                if len(pending) > 64 * 1024:
                    raise RuntimeError("invalid lease stream")
            # Never synchronously fill the candidate's pipe: a candidate which
            # does not read input must not block lease/cancellation handling.
            if writable:
                try:
                    sent += os.write(child.stdin.fileno(), payload[sent:sent + 65536])
                    record["deliveredBytes"] = sent
                except BlockingIOError:
                    continue
                if sent == len(payload):
                    child.stdin.close()
                    record["payloadDelivered"] = True
        if child.poll() is not None and record["payloadDelivered"]:
            record["status"] = child.returncode
    except Exception as error:
        print("isolated resource: " + str(error), file=sys.stderr, flush=True)
    finally:
        try:
            if child is not None and child.poll() is None:
                try:
                    child.terminate()
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
        except Exception as error:
            record["status"] = 2
            print("isolated direct-child cleanup: " + str(error), file=sys.stderr, flush=True)
        finally:
            try:
                count, remaining = clean_children()
                record["orphaned"] = count != 0
                record["remaining"] = remaining
                if interrupted or record["cancelled"] or record["timedOut"] or count or remaining:
                    record["status"] = 2
            except Exception as error:
                record["status"] = 2
                print("isolated namespace cleanup: " + str(error), file=sys.stderr, flush=True)
            finally:
                os.write(args.report_fd, json.dumps(record).encode())
                os.close(args.report_fd)
    return record["status"] if record["status"] in (0, 1, 2) else 2


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--uid", type=int, required=True)
    parser.add_argument("--tmpdir", required=True)
    parser.add_argument("--inside", action="store_true")
    parser.add_argument("--parent-net")
    parser.add_argument("--parent-pid")
    parser.add_argument("--report-fd", type=int)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command.pop(0)
    path, digest = trusted_self()
    if os.getuid() != 0 or not sys.flags.isolated:
        raise RuntimeError("trusted bootstrap requires root only for namespace setup")
    if args.inside:
        return inside(args)
    parent_net, parent_pid = namespace("net"), namespace("pid")
    report_read, report_write = os.pipe()
    command = [
        "/usr/bin/unshare", "--mount", "--pid", "--net", "--fork", "--kill-child=SIGKILL", "--mount-proc", "--propagation", "private",
        "/usr/bin/python3", "-I", path, "--inside", "--uid", str(args.uid), "--tmpdir", args.tmpdir,
        "--parent-net", parent_net, "--parent-pid", parent_pid, "--report-fd", str(report_write),
        "--", *args.command,
    ]
    child = subprocess.Popen(command, pass_fds=(report_write,), start_new_session=True)
    os.close(report_write)
    timed_out = False
    cancelled = False

    def cancel(_sig, _frame):
        nonlocal cancelled
        cancelled = True
        if child.poll() is None:
            child.terminate()

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        code = child.wait(timeout=LIMIT + 10)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGKILL)
        code = child.wait(timeout=5)
    raw = os.read(report_read, 65536)
    os.close(report_read)
    record = json.loads(raw) if raw else {"schema": 1, "status": 2}
    record["helperSha256"] = digest
    record["closed"] = code is not None and namespace("net") == parent_net and namespace("pid") == parent_pid
    if timed_out or cancelled or not raw:
        record["timedOut"] = timed_out
        record["cancelled"] = cancelled
        record["status"] = 2
    code = record["status"] if record["status"] in (0, 1, 2) else 2
    print(PREFIX + json.dumps(record), flush=True)
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("isolated bootstrap failed: " + str(error), file=sys.stderr, flush=True)
        sys.exit(2)
