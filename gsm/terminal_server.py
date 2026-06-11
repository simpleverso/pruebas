#!/usr/bin/env python3
"""
Terminal WebSocket Server for logs2.html
=========================================
Cross-platform with automatic best-option detection:

  macOS / Linux → PTY (full terminal emulation, resize, colors, TUI apps)
  Windows + pywinpty → ConPTY (full Windows terminal, resize, colors, TUI apps)
  Windows fallback → subprocess pipes (basic, no resize)

Usage:
    pip install websockets
    python terminal_server.py [--port 8765] [--host 0.0.0.0] [--shell /bin/zsh]

    On Windows, for the best experience also install:
        pip install pywinpty

Security Warning:
    This gives FULL shell access to whoever connects.
    Only run on trusted networks. Do NOT expose to the internet.
"""

import asyncio
import json
import os
import sys
import argparse
import subprocess
import platform
import threading

try:
    import websockets
except ImportError:
    print("ERROR: 'websockets' package not found.")
    print("Install it with:  pip install websockets")
    sys.exit(1)

IS_WINDOWS = platform.system() == "Windows"
IS_MACOS = platform.system() == "Darwin"
IS_LINUX = platform.system() == "Linux"

# --- Unix PTY (macOS & Linux) ---
if not IS_WINDOWS:
    import pty
    import fcntl
    import struct
    import termios
    import select

# --- Windows ConPTY via pywinpty (optional, best experience) ---
HAS_WINPTY = False
if IS_WINDOWS:
    try:
        from winpty import PtyProcess
        HAS_WINPTY = True
    except ImportError:
        pass


def detect_shell():
    """Detect the best shell for the current platform."""
    if IS_WINDOWS:
        # Prefer PowerShell 7+ (pwsh), then Windows PowerShell, then cmd
        for sh in ["pwsh.exe", "powershell.exe", "cmd.exe"]:
            try:
                subprocess.run([sh, "-Command", "echo ok"] if "power" in sh.lower() or "pwsh" in sh.lower()
                               else [sh, "/C", "echo ok"],
                               capture_output=True, timeout=3)
                return sh
            except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
                continue
        return "cmd.exe"
    else:
        return os.environ.get("SHELL", "/bin/zsh" if IS_MACOS else "/bin/bash")


# =============================================================================
# SESSION CLASSES
# =============================================================================

class UnixPtySession:
    """Full PTY session for macOS and Linux. Best possible terminal experience."""

    def __init__(self, shell=None):
        self.shell = shell or detect_shell()
        self.master_fd = None
        self.proc = None

    def start(self):
        self.master_fd, slave_fd = pty.openpty()

        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["LC_ALL"] = env.get("LC_ALL", "en_US.UTF-8")

        self.proc = subprocess.Popen(
            [self.shell, "-l"],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            preexec_fn=os.setsid,
            env=env,
        )
        os.close(slave_fd)

        # Non-blocking reads
        flags = fcntl.fcntl(self.master_fd, fcntl.F_GETFL)
        fcntl.fcntl(self.master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        return {
            "shell": self.shell,
            "pid": self.proc.pid,
            "backend": "pty",
            "platform": platform.system(),
        }

    def resize(self, cols, rows):
        if self.master_fd is not None:
            try:
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
            except OSError:
                pass

    def write(self, data: str):
        if self.master_fd is not None:
            try:
                os.write(self.master_fd, data.encode("utf-8"))
            except OSError:
                pass

    def read(self) -> str:
        if self.master_fd is None:
            return ""
        try:
            # Use select to check if data is available (more efficient than blind read)
            r, _, _ = select.select([self.master_fd], [], [], 0)
            if r:
                data = os.read(self.master_fd, 16384)
                return data.decode("utf-8", errors="replace") if data else ""
        except (OSError, BlockingIOError, ValueError):
            pass
        return ""

    def is_alive(self) -> bool:
        if self.proc is None:
            return False
        return self.proc.poll() is None

    def close(self):
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None
        if self.proc:
            try:
                os.killpg(os.getpgid(self.proc.pid), 9)
            except (OSError, ProcessLookupError):
                pass
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    self.proc.kill()
                except OSError:
                    pass
            self.proc = None


class WindowsConPtySession:
    """ConPTY session for Windows using pywinpty. Full terminal with resize."""

    def __init__(self, shell=None):
        self.shell = shell or detect_shell()
        self.pty_process = None

    def start(self):
        self.pty_process = PtyProcess.spawn(self.shell, dimensions=(24, 80))
        return {
            "shell": self.shell,
            "pid": self.pty_process.pid,
            "backend": "conpty (pywinpty)",
            "platform": "Windows",
        }

    def resize(self, cols, rows):
        if self.pty_process:
            try:
                self.pty_process.setwinsize(rows, cols)
            except Exception:
                pass

    def write(self, data: str):
        if self.pty_process:
            try:
                self.pty_process.write(data)
            except Exception:
                pass

    def read(self) -> str:
        if self.pty_process is None:
            return ""
        try:
            # pywinpty's read is non-blocking with a timeout
            data = self.pty_process.read(16384, blocking=False)
            return data if data else ""
        except Exception:
            return ""

    def is_alive(self) -> bool:
        if self.pty_process is None:
            return False
        return self.pty_process.isalive()

    def close(self):
        if self.pty_process:
            try:
                self.pty_process.close(force=True)
            except Exception:
                pass
            self.pty_process = None


class WindowsFallbackSession:
    """Basic subprocess session for Windows without pywinpty. No resize, limited TUI."""

    def __init__(self, shell=None):
        self.shell = shell or detect_shell()
        self.proc = None
        self._output_buf = []
        self._lock = threading.Lock()
        self._stop = threading.Event()

    def start(self):
        creation_flags = 0
        if hasattr(subprocess, "CREATE_NO_WINDOW"):
            creation_flags = subprocess.CREATE_NO_WINDOW

        self.proc = subprocess.Popen(
            [self.shell],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
            creationflags=creation_flags,
        )

        # Reader thread
        def reader():
            try:
                while not self._stop.is_set():
                    byte = self.proc.stdout.read(1)
                    if byte:
                        with self._lock:
                            self._output_buf.append(byte.decode("utf-8", errors="replace"))
                    else:
                        break
            except (OSError, ValueError):
                pass

        self._reader = threading.Thread(target=reader, daemon=True)
        self._reader.start()

        return {
            "shell": self.shell,
            "pid": self.proc.pid,
            "backend": "subprocess (fallback, no resize)",
            "platform": "Windows",
            "note": "Install pywinpty for full terminal: pip install pywinpty",
        }

    def resize(self, cols, rows):
        pass  # Not supported in subprocess mode

    def write(self, data: str):
        if self.proc and self.proc.stdin:
            try:
                self.proc.stdin.write(data.encode("utf-8"))
                self.proc.stdin.flush()
            except (OSError, BrokenPipeError):
                pass

    def read(self) -> str:
        with self._lock:
            if self._output_buf:
                out = "".join(self._output_buf)
                self._output_buf.clear()
                return out
        return ""

    def is_alive(self) -> bool:
        if self.proc is None:
            return False
        return self.proc.poll() is None

    def close(self):
        self._stop.set()
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    self.proc.kill()
                except OSError:
                    pass
            self.proc = None


# =============================================================================
# SESSION FACTORY
# =============================================================================

def create_session(shell=None):
    """Create the best terminal session for the detected OS."""
    if IS_WINDOWS:
        if HAS_WINPTY:
            return WindowsConPtySession(shell)
        else:
            return WindowsFallbackSession(shell)
    else:
        # macOS or Linux — always use PTY
        return UnixPtySession(shell)


# =============================================================================
# WEBSOCKET HANDLER
# =============================================================================

async def terminal_handler(websocket, shell_override=None):
    """Handle a single terminal WebSocket connection."""
    session = create_session(shell_override)
    info = session.start()

    async def read_from_terminal():
        """Read terminal output and send to WebSocket."""
        try:
            while True:
                await asyncio.sleep(0.015)  # ~66 reads/sec
                if not session.is_alive():
                    await websocket.send(json.dumps({
                        "type": "output",
                        "data": "\r\n\x1b[31m[Process exited]\x1b[0m\r\n"
                    }))
                    break
                data = session.read()
                if data:
                    await websocket.send(json.dumps({
                        "type": "output",
                        "data": data
                    }))
        except (asyncio.CancelledError, websockets.exceptions.ConnectionClosed):
            pass

    async def write_to_terminal():
        """Read from WebSocket and write to terminal."""
        try:
            async for message in websocket:
                try:
                    msg = json.loads(message)
                    msg_type = msg.get("type", "")
                    if msg_type == "input":
                        session.write(msg["data"])
                    elif msg_type == "resize":
                        session.resize(msg.get("cols", 80), msg.get("rows", 24))
                    elif msg_type == "ping":
                        await websocket.send(json.dumps({"type": "pong"}))
                except (json.JSONDecodeError, KeyError, OSError):
                    continue
        except (asyncio.CancelledError, websockets.exceptions.ConnectionClosed):
            pass

    read_task = asyncio.create_task(read_from_terminal())
    write_task = asyncio.create_task(write_to_terminal())

    try:
        await websocket.send(json.dumps({"type": "connected", **info}))
        done, pending = await asyncio.wait(
            [read_task, write_task],
            return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
    finally:
        read_task.cancel()
        write_task.cancel()
        session.close()


# =============================================================================
# MAIN
# =============================================================================

async def main(host="127.0.0.1", port=8765, shell=None):
    """Start the WebSocket server."""
    detected = detect_shell()
    backend = "pty" if not IS_WINDOWS else ("conpty/pywinpty" if HAS_WINPTY else "subprocess (install pywinpty for better experience)")

    print(f"╔═══════════════════════════════════════════════════════╗")
    print(f"║  Terminal WebSocket Server                            ║")
    print(f"║  Platform : {platform.system():10s} ({platform.machine()})        ║")
    print(f"║  Backend  : {backend:42s} ║")
    print(f"║  Shell    : {(shell or detected):42s} ║")
    print(f"║  Listen   : ws://{host}:{port:<5d}                         ║")
    print(f"║  Press Ctrl+C to stop                                 ║")
    print(f"╚═══════════════════════════════════════════════════════╝")

    if IS_WINDOWS and not HAS_WINPTY:
        print("\n⚠️  TIP: For full terminal support on Windows, install pywinpty:")
        print("    pip install pywinpty\n")

    handler = lambda ws: terminal_handler(ws, shell)

    async with websockets.serve(
        handler,
        host,
        port,
        max_size=2**20,
        ping_interval=20,
        ping_timeout=60,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Terminal WebSocket Server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="Bind port (default: 8765)")
    parser.add_argument("--shell", default=None, help="Override shell (e.g. /bin/bash, pwsh.exe)")
    args = parser.parse_args()

    try:
        asyncio.run(main(args.host, args.port, args.shell))
    except KeyboardInterrupt:
        print("\nServer stopped.")
