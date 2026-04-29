# Signal MCP Server

Combined MCP + WebSocket server for controlling Signal music sequencer from Claude and other LLM tools.

## Overview

This server provides:
- **MCP Endpoint** (`/mcp`) - Streamable HTTP MCP protocol for Claude
- **WebSocket** (`/ws`) - Real-time connection for Signal browser app
- **REST API** (`/api/*`) - Health checks and status
- **Static files** (`/edit`) - Serves the Signal app in production

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

**For Claude Code CLI:**
```bash
claude mcp add signal-mcp -t http http://localhost:8080/mcp
```

**For Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "signal-mcp": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

## Helper Scripts for LLM Integration

This repository includes helper scripts to quickly configure your LLM clients (Claude, Codex, Gemini) to connect to a running Signal MCP server. These scripts assume the MCP server is running and accessible at `https://signal.mcp.mathplosion.com/mcp`.

### `add_signal_mcp_to_claude.sh`
```bash
./add_signal_mcp_to_claude.sh
```

### `add_signal_mcp_to_codex.sh`
```bash
./add_signal_mcp_to_codex.sh
```

### `add_signal_mcp_to_gemini.sh`
```bash
./add_signal_mcp_to_gemini.sh
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
│  GET  /edit → Signal app (production)                      │
│  GET  /api/* → REST API (health checks)                    │
└─────────────────────────────────────────────────────────────┘
           ↑                              ↑
      Claude (MCP)                    Browser (Signal App)

Flow:
1. User opens Signal → sees "Session: abc1" in header
2. User tells Claude: "Connect to session abc1"
3. Claude calls MCP tools with session_id="abc1"
4. MCP server routes commands to that browser via WebSocket
5. Notes appear in Signal!
```

## MCP Tools

All tools require a `session_id` parameter (the 4-character code shown in Signal).

### `get_piano_roll_state(session_id)`
Get all tracks and notes from the piano roll.

Returns per track: `id`, `name`, `channel`, `programNumber`, `notes`
Returns per note: `midi`, `time`, `duration`, `velocity`

### `send_notes(session_id, notes, mode="add", track_id=None)`
Add notes to the piano roll.

```python
# C major chord on default track
send_notes("abc1", [
    {"midi": 60, "duration": 2.0, "time": 0},  # C4
    {"midi": 64, "duration": 2.0, "time": 0},  # E4
    {"midi": 67, "duration": 2.0, "time": 0}   # G4
])

# Send to a specific track
send_notes("abc1", [...], track_id=2)

# Replace all notes
send_notes("abc1", [...], mode="replace")
```

### `delete_notes(session_id, notes, track_id=None)`
Delete specific notes by MIDI number and time.

### `clear_notes(session_id, track_id=None)`
Clear all notes from a track.

### `create_track(session_id, name=None, program_number=0)`
Create a new MIDI track with an optional name and GM instrument.

```python
result = create_track("abc1", name="Violin", program_number=40)
# Returns: trackId, channel, name, programNumber
track_id = result["data"]["trackId"]
```

### `set_instrument(session_id, track_id, program_number)`
Set the GM instrument on an existing track.

```python
set_instrument("abc1", track_id=2, program_number=32)  # Acoustic Bass
```

### `check_connection(session_id)`
Check if a specific session is connected.

**Security:** This tool ONLY checks the specified session. It will not list other active sessions.

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

### Common GM Instrument Numbers

| Program | Instrument |
|---------|-----------|
| 0 | Acoustic Grand Piano |
| 24 | Classical Guitar |
| 25 | Acoustic Guitar |
| 32 | Acoustic Bass |
| 40 | Violin |
| 41 | Viola |
| 42 | Cello |
| 48 | String Ensemble |
| 52 | Choir Aahs |
| 56 | Trumpet |
| 65 | Alto Sax |
| 73 | Flute |

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

### Docker (full stack)

Use the Dockerfile at the repo root — it builds the Signal app and bundles it with the Python server in a single image:

```bash
# From repo root
docker build -t signal-mcp .
docker run -p 8080:8080 signal-mcp
```

## Troubleshooting

### "Session not found"
- Make sure Signal is open in a browser
- Check the session ID matches exactly (case-sensitive)
- Verify WebSocket connection (green dot in Signal header)

### MCP tools stale after server restart
- The Claude Code MCP session expires when the server restarts
- Run `/mcp` in Claude Code to reconnect, or start a new session

### Connection issues
- Check server is running: `curl http://localhost:8080/api/health`
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

# Run with auto-reload
uvicorn signal_mcp_server:app --reload --port 8080

# Run tests
uv run pytest
```
