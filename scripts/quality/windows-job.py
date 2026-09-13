"""Own one Windows stage tree with a non-inheritable kill-on-close Job.

Invoke an explicitly resolved Python executable (not a shell command) as:
  python.exe windows-job.py --node C:\\absolute\\node.exe -- COMMAND ARG ...
The caller owns cwd/env and the timeout. Killing this supervisor closes its
Job handle in the OS, including on forced termination. Only stdlib is used;
there is no restricted token, privilege change, or user service operation.
"""

import argparse
import ctypes
from ctypes import wintypes
from pathlib import Path
import subprocess
import sys


def create_kill_job():
    """Create an unnamed, non-inheritable Job with no breakaway permission.

    ABI layout follows the existing legacy sandbox Job implementation. This
    supervisor differs by attaching a dormant wrapper before actual argv runs.
    """
    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
        )]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimits),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    api.CreateJobObjectW.restype = wintypes.HANDLE
    api.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    api.SetInformationJobObject.restype = wintypes.BOOL
    api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    api.AssignProcessToJobObject.restype = wintypes.BOOL
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    api.CloseHandle.restype = wintypes.BOOL
    # A null SECURITY_ATTRIBUTES keeps this handle non-inheritable, so killing
    # the supervisor always closes the final handle, even with live children.
    job = api.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    information = ExtendedLimits()
    information.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
    if not api.SetInformationJobObject(job, 9, ctypes.byref(information), ctypes.sizeof(information)):
        error = ctypes.get_last_error()
        api.CloseHandle(job)
        raise ctypes.WinError(error)
    return api, job


def run(node, command):
    """Attach a waiting Node wrapper, then allow it to spawn literal argv.

    If this process dies before attach, stdin EOF stops the dormant wrapper.
    Attach failure terminates it without ever sending the start handshake.
    After attach, OS Job ownership covers every descendant, even detached ones.
    """
    api, job = create_kill_job()
    wrapper = None
    try:
        wrapper = subprocess.Popen(
            [node, str(Path(__file__).with_name("windows-stage.mjs")), *command],
            stdin=subprocess.PIPE, close_fds=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if not api.AssignProcessToJobObject(job, wintypes.HANDLE(int(wrapper._handle))):
            raise ctypes.WinError(ctypes.get_last_error())
        wrapper.stdin.write(b"start\n")
        wrapper.stdin.close()
        return wrapper.wait()
    finally:
        # Close before waiting for any pipes: orphan descendants may still own
        # inherited stdout/stderr. Closing the Job kills the whole attached tree.
        closed = api.CloseHandle(job)
        if wrapper is not None:
            if wrapper.stdin is not None and not wrapper.stdin.closed:
                wrapper.stdin.close()
            if wrapper.poll() is None:
                # Also covers attach failure, where the wrapper is not in Job.
                wrapper.kill()
            wrapper.wait()
        if not closed:
            raise ctypes.WinError(ctypes.get_last_error())


def main():
    """Validate invocation and surface only sanitized infrastructure failures."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    command = options.command[1:] if options.command[:1] == ["--"] else options.command
    if sys.platform != "win32":
        parser.error("this supervisor requires Windows")
    if not Path(options.node).is_absolute() or not Path(options.node).is_file() or not command:
        parser.error("an absolute Node executable and a nonempty command are required")
    try:
        return run(options.node, command)
    except (OSError, ValueError) as error:
        # Do not repeat argv/env in errors: a caller can pass sensitive inputs.
        sys.stderr.write(f"windows-job: infrastructure failure ({type(error).__name__}, winerror={getattr(error, 'winerror', None)})\n")
        return 125


if __name__ == "__main__":
    sys.exit(main())
