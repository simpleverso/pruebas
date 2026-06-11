(function() {
    var terminals = []; // { id, ws, term, fitAddon, el }
    var activeTermIdx = -1;
    var termIdCounter = 0;
    var tabBar = document.getElementById('termTabBar');
    var container = document.getElementById('termContainer');
    var connStatus = document.getElementById('termConnStatus');
    var newTabBtn = document.getElementById('termNewTabBtn');
    var wsUrlInput = document.getElementById('termWsUrl');

    // Make the Python file downloadable as a blob link
    var pyCode = `#!/usr/bin/env python3
"""
Terminal WebSocket Server for logs2.html
pip install websockets
python terminal_server.py [--port 8765] [--host 0.0.0.0]
"""
import asyncio, json, os, pty, struct, subprocess, sys, argparse, fcntl, termios
try:
    import websockets
except ImportError:
    print("ERROR: pip install websockets"); sys.exit(1)

async def terminal_handler(websocket):
    shell = os.environ.get("SHELL", "/bin/zsh")
    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen([shell, "-l"], stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
        preexec_fn=os.setsid, env={**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"})
    os.close(slave_fd)
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    async def read_pty():
        try:
            while True:
                await asyncio.sleep(0.01)
                try:
                    data = os.read(master_fd, 4096)
                    if data: await websocket.send(json.dumps({"type":"output","data":data.decode("utf-8",errors="replace")}))
                except (OSError, BlockingIOError): pass
        except: pass

    async def write_pty():
        try:
            async for message in websocket:
                try:
                    msg = json.loads(message)
                    if msg["type"]=="input": os.write(master_fd, msg["data"].encode("utf-8"))
                    elif msg["type"]=="resize":
                        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH",msg.get("rows",24),msg.get("cols",80),0,0))
                except: pass
        except: pass

    read_task = asyncio.create_task(read_pty())
    write_task = asyncio.create_task(write_pty())
    await websocket.send(json.dumps({"type":"connected","shell":shell,"pid":proc.pid}))
    done, pending = await asyncio.wait([read_task, write_task], return_when=asyncio.FIRST_COMPLETED)
    for t in pending: t.cancel()
    try: os.close(master_fd)
    except: pass
    try: proc.terminate(); proc.wait(timeout=2)
    except: proc.kill()

async def main(host="127.0.0.1", port=8765):
    print(f"Terminal server on ws://{host}:{port}")
    async with websockets.serve(terminal_handler, host, port, max_size=2**20, ping_interval=20, ping_timeout=60):
        await asyncio.Future()

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--host",default="127.0.0.1")
    p.add_argument("--port",type=int,default=8765)
    a=p.parse_args()
    try: asyncio.run(main(a.host,a.port))
    except KeyboardInterrupt: print("Stopped.")
`;

    var downloadBtn = document.getElementById('termDownloadPy');
    if (downloadBtn) {
        var blob = new Blob([pyCode], { type: 'text/x-python' });
        downloadBtn.href = URL.createObjectURL(blob);
    }

    if (!newTabBtn || !container) return;

    newTabBtn.addEventListener('click', function() { createTerminal(); });

    function createTerminal() {
        var id = ++termIdCounter;
        var wsUrl = wsUrlInput.value.trim() || 'ws://127.0.0.1:8765';

        // Create tab
        var tab = document.createElement('div');
        tab.style.cssText = 'padding:4px 12px;border-radius:6px 6px 0 0;cursor:pointer;font-size:0.78rem;font-weight:600;display:flex;align-items:center;gap:6px;user-select:none;';
        tab.innerHTML = 'Term ' + id + ' <span class="term-close" style="color:#f85149;cursor:pointer;font-size:0.9rem;line-height:1;">&times;</span>';
        tabBar.appendChild(tab);

        // Create terminal div
        var termEl = document.createElement('div');
        termEl.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;display:none;';
        container.appendChild(termEl);

        // Init xterm.js
        var term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            theme: {
                background: '#0d1117',
                foreground: '#c9d1d9',
                cursor: '#58a6ff',
                selectionBackground: '#264f78',
            },
            allowProposedApi: true,
        });
        var fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(termEl);
        fitAddon.fit();

        // WebSocket connection
        var ws = null;
        var reconnecting = false;

        function connect() {
            ws = new WebSocket(wsUrl);
            ws.onopen = function() {
                connStatus.textContent = 'Connected';
                connStatus.style.color = '#3fb950';
                term.write('\\r\\n\\x1b[32mConnected to ' + wsUrl + '\\x1b[0m\\r\\n');
                // Send initial size
                ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            };
            ws.onmessage = function(event) {
                try {
                    var msg = JSON.parse(event.data);
                    if (msg.type === 'output') {
                        term.write(msg.data);
                    } else if (msg.type === 'connected') {
                        term.write('\\x1b[36mShell: ' + msg.shell + ' (PID: ' + msg.pid + ')\\x1b[0m\\r\\n');
                    }
                } catch(e) {}
            };
            ws.onclose = function() {
                connStatus.textContent = 'Disconnected';
                connStatus.style.color = '#f85149';
                term.write('\\r\\n\\x1b[31mDisconnected.\\x1b[0m\\r\\n');
            };
            ws.onerror = function() {
                connStatus.textContent = 'Connection failed';
                connStatus.style.color = '#f85149';
                term.write('\\r\\n\\x1b[31mConnection failed. Is terminal_server.py running?\\x1b[0m\\r\\n');
            };
        }

        connect();

        // Terminal input -> WebSocket
        term.onData(function(data) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'input', data: data }));
            }
        });

        // Resize handling
        term.onResize(function(size) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
            }
        });

        var entry = { id: id, ws: ws, term: term, fitAddon: fitAddon, el: termEl, tab: tab, connect: connect };
        terminals.push(entry);

        // Tab click -> activate
        tab.addEventListener('click', function(e) {
            if (e.target.classList.contains('term-close')) {
                closeTerminal(entry);
                return;
            }
            activateTerminal(entry);
        });

        activateTerminal(entry);

        // Resize observer
        var ro = new ResizeObserver(function() {
            if (termEl.style.display !== 'none') fitAddon.fit();
        });
        ro.observe(container);
        entry._ro = ro;
    }

    function activateTerminal(entry) {
        terminals.forEach(function(t) {
            t.el.style.display = 'none';
            t.tab.style.background = '#21262d';
            t.tab.style.color = '#8b949e';
        });
        entry.el.style.display = '';
        entry.tab.style.background = '#161b22';
        entry.tab.style.color = '#e6edf3';
        entry.fitAddon.fit();
        entry.term.focus();
        activeTermIdx = terminals.indexOf(entry);
    }

    function closeTerminal(entry) {
        if (entry.ws) { try { entry.ws.close(); } catch(e) {} }
        entry.term.dispose();
        entry.el.remove();
        entry.tab.remove();
        if (entry._ro) entry._ro.disconnect();
        var idx = terminals.indexOf(entry);
        terminals.splice(idx, 1);
        if (terminals.length > 0) {
            activateTerminal(terminals[Math.max(0, idx - 1)]);
        }
    }
})();
