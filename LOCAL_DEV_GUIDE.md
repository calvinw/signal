# Signal MCP - Local Development & Testing Guide

Guide for running Signal locally with MCP integration in development or production mode.

---

## Prerequisites

- **Node.js** 20+ (download from https://nodejs.org/)
- **Python** 3.11+ (download from https://python.org/)
- **uv** (recommended) or pip for Python package management
- **Git** (download from https://git-scm.com/)

---

## Option 1: Production Mode (Recommended for Testing)

This runs the unified server that serves both the Signal app and MCP endpoint on a single port. This matches how it runs in Docker.

### Step 1: Build the Signal App

```bash
# From project root (signal/)
npm install
npm run build:app
```

### Step 2: Copy Build to MCP Server

```bash
cp -r dist mcp-server/
```

### Step 3: Start the Production Server

```bash
cd mcp-server
uv run python signal_mcp_server.py
```

Expected output:
```
🎹 Signal MCP Server Starting on port 8080!

🌐 Web Interface: http://localhost:8080/edit
🤖 MCP Endpoint:  http://localhost:8080/sse
⚡ WebSocket:     ws://localhost:8080/ws
📊 Status:        http://localhost:8080/api/status
```

### Step 4: Open Signal & Connect

1. Open browser to **http://localhost:8080/edit**
2. Look for **Session ID** in the header (e.g., `vyq5`)
3. Share this session ID with Claude/AI
4. Claude can now control your piano roll!

### Architecture (Production Mode)

```
Single Server (http://localhost:8080)
    ├── /edit     → Signal App (static files)
    ├── /sse      → MCP Endpoint (for Claude)
    ├── /ws       → WebSocket (browser ↔ server)
    └── /api/*    → REST endpoints
```

---

## Option 2: Development Mode (Hot Reload)

This runs two separate servers - useful when actively developing the Signal app.

### Step 1: Start MCP Server (Terminal 1)

```bash
cd mcp-server
uv run python signal_mcp_server.py
```

Server runs on port 8080.

### Step 2: Start Signal Dev Server (Terminal 2)

```bash
# From project root (signal/)
npm start
```

Opens Signal at http://localhost:3000/edit with hot reload.

**Note:** The dev server auto-detects the MCP server on port 8080. If on localhost:3000, it connects to ws://localhost:8080/ws.

### Architecture (Development Mode)

```
Dev Server (http://localhost:3000)    MCP Server (http://localhost:8080)
    │                                     │
    └──────── WebSocket ─────────────────→│
                                          │
Claude ────────── MCP/SSE ───────────────→│
```

---

## Connecting Claude Code CLI

After the server is running, add the MCP server to Claude:

```bash
# For production mode (port 8080)
claude mcp add signal-mcp -t sse http://localhost:8080/sse

# Reconnect if needed
/mcp
```

Then share your session ID with Claude to start composing!

---

## Docker (Full Production)

Build and run everything in a container:

```bash
docker compose up --build
```

Access at http://localhost:8080/edit

---

## Rebuilding After Code Changes

If you modify the Signal app code:

```bash
# Rebuild the app
npm run build:app

# Update the mcp-server dist
rm -rf mcp-server/dist && cp -r dist mcp-server/

# Restart the server
cd mcp-server && uv run python signal_mcp_server.py
```

---

## Troubleshooting

### Port Already In Use

```bash
# Find process using port 8080
lsof -i :8080

# Kill it
kill -9 <PID>

# Or kill all Python servers
pkill -9 -f "signal_mcp_server"
```

### 503 Service Unavailable at /edit

The static build files are missing. Run:

```bash
npm run build:app
cp -r dist mcp-server/
```

### WebSocket Connection Failed

- Make sure the MCP server is running
- Check browser console for the WebSocket URL being used
- Verify session ID matches what's shown in Signal's header

### Session Not Found (Claude error)

- Run `/mcp` in Claude Code to reconnect
- Verify the session ID is correct
- Check http://localhost:8080/api/status to see active sessions

---

## Useful Commands

```bash
# Check server health
curl http://localhost:8080/api/health

# List active sessions
curl http://localhost:8080/api/status

# Kill all Python servers
pkill -9 -f "signal_mcp_server"

# Full rebuild
npm run build:app && rm -rf mcp-server/dist && cp -r dist mcp-server/
```

---

## Using with Claude

Once connected:

```python
# Share your session ID (from Signal's header)
session = "vyq5"

# Check connection
check_connection(session)

# Get current piano roll
state = get_piano_roll_state(session)

# Add a C major chord
send_notes(session, [
    {"midi": 60, "duration": 2, "time": 0},
    {"midi": 64, "duration": 2, "time": 0},
    {"midi": 67, "duration": 2, "time": 0}
])

# Clear and replace with new notes
send_notes(session, [...], mode="replace")
```

---

Happy composing! 🎵
