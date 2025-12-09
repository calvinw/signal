# Signal MCP Server

Combined MCP + WebSocket server for controlling Signal music sequencer from Claude and other LLM tools.

## Overview

This server provides:
- **MCP Endpoint** (`/mcp`) - Streamable HTTP MCP protocol for Claude
- **WebSocket** (`/ws`) - Real-time connection for Signal browser app
- **REST API** (`/api/*`) - Health checks and status

## Quick Start

### 1. Install dependencies

```bash
cd mcp-server
uv sync
```

### 2. Start the server

```bash
uv run python signal_mcp_server.py
```

Or with custom port:

```bash
PORT=8080 uv run python signal_mcp_server.py
```

### 3. Open Signal in browser

The Signal app will automatically connect to the MCP server and display a session ID in the navigation bar.

### 4. Connect Claude

Add the MCP server to Claude Desktop or Claude Code:

**For Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "signal": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

**For Claude Code**:
```bash
claude mcp add signal --url http://localhost:3001/mcp
```

### 5. Use Claude to control Signal

Tell Claude the session ID from your browser:

> "Connect to Signal session abc1 and add a C major chord"

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Signal MCP Server (Python)                                 │
│                                                             │
│  POST /mcp  → Streamable HTTP MCP (for Claude)             │
│  GET  /ws   → WebSocket (for browser)                      │
│  GET  /api/* → REST API (health checks)                    │
└─────────────────────────────────────────────────────────────┘
           ↑                              ↑
      Claude (MCP)                    Browser (Signal App)

Flow:
1. User opens Signal → sees "Session: ABC1" in header
2. User tells Claude: "Connect to session abc1"
3. Claude calls MCP tools with session_id="abc1"
4. MCP server routes commands to that browser via WebSocket
5. Notes appear in Signal!
```

## MCP Tools

All tools require a `session_id` parameter (the 4-character code shown in Signal).

### `get_piano_roll_state(session_id)`
Get all notes and tracks from the piano roll.

### `send_notes(session_id, notes, mode="add", track_id=None)`
Add notes to the piano roll.

```python
# Example: C major chord
send_notes("abc1", [
    {"midi": 60, "duration": 2.0, "time": 0},  # C4
    {"midi": 64, "duration": 2.0, "time": 0},  # E4
    {"midi": 67, "duration": 2.0, "time": 0}   # G4
])
```

### `delete_notes(session_id, notes, track_id=None)`
Delete specific notes by MIDI number and time.

### `clear_notes(session_id, track_id=None)`
Clear all notes from a track.

### `check_connection(session_id=None)`
Check if a session is connected, or list all active sessions.

## Note Format

Notes use **quarter notes** for time and duration:

| Field | Description | Example |
|-------|-------------|---------|
| `midi` | MIDI note number (0-127) | 60 = Middle C |
| `time` | Start time in quarter notes | 0 = beat 1, 4 = beat 5 |
| `duration` | Duration in quarter notes | 1.0 = quarter note |
| `velocity` | Optional, 0.0-1.0 | 0.8 = default |

### Duration Reference

- `0.25` = 16th note
- `0.5` = 8th note
- `1.0` = Quarter note
- `2.0` = Half note
- `4.0` = Whole note

## Deployment

### Digital Ocean / Cloud

```bash
# Set environment variables
export HOST=0.0.0.0
export PORT=8080

# Run server
uv run python signal_mcp_server.py
```

For HTTPS, put behind a reverse proxy (nginx, caddy) that handles SSL.

### Docker

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN pip install uv && uv sync
EXPOSE 3001
CMD ["uv", "run", "python", "signal_mcp_server.py"]
```

## Troubleshooting

### "Session not found"
- Make sure Signal is open in a browser
- Check the session ID matches (case-insensitive)
- Verify WebSocket connection (green dot in Signal header)

### Connection issues
- Check server is running: `curl http://localhost:3001/api/health`
- Verify CORS if running on different origins
- Check browser console for WebSocket errors

### Notes not appearing
- Verify session ID is correct
- Check `get_piano_roll_state` returns successfully
- Try `check_connection` to verify session status

## Development

```bash
# Install dev dependencies
uv sync

# Run with auto-reload (for development)
uvicorn signal_mcp_server:app --reload --port 3001

# Run tests
uv run pytest
```
