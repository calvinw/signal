# Signal MCP Integration

This is a fork of Signal (web-based music sequencer) with integrated MCP support for AI-assisted music composition.

## Quick Start

### Option 1: Production Mode (Recommended)

Build and run everything on a single server:

```bash
# Build the Signal app
npm install
npm run build:app

# Copy build to mcp-server
cp -r dist mcp-server/

# Start the server
cd mcp-server
uv run python signal_mcp_server.py
```

This starts a unified server on port 8080:
- **Signal App:** `http://localhost:8080/edit`
- **MCP Endpoint:** `http://localhost:8080/mcp` (Streamable HTTP for Claude/AI)
- **WebSocket:** `ws://localhost:8080/ws` (for Signal browser app)
- **Health Check:** `http://localhost:8080/api/health`

### Option 2: Development Mode (Hot Reload)

Run two servers for development with hot reload:

```bash
# Terminal 1: Start MCP Server
cd mcp-server && uv run python signal_mcp_server.py

# Terminal 2: Start Signal dev server
npm start
```

Opens Signal at `http://localhost:3000/edit` with hot reload.

**Note:** The dev server automatically connects to the MCP server on port 8080.

### Connect AI to Signal

For Claude Code CLI:
```bash
claude mcp add signal-mcp -t http http://localhost:8080/mcp
```

### Get the Session ID

When Signal opens, look for the **session ID** displayed in the header (e.g., `abc1`). Share this with the AI so it can control your specific browser instance.

---

## Architecture

```
┌─────────────────┐         ┌──────────────────────────────────┐
│  Claude / AI    │         │     MCP Server (Python)          │
│  (MCP Client)   │◀───────▶│     Port 8080                    │
└─────────────────┘  HTTP   │                                  │
                            ├─ /edit   (Signal App)            │
                            ├─ /mcp    (MCP via Streamable HTTP│
                            ├─ /ws     (WebSocket)             │
                            └─ /api/*  (REST endpoints)        │
                            └──────────────┬───────────────────┘
                                           │ WebSocket
                                           ▼
                            ┌──────────────────────────────────┐
                            │     Signal Browser App           │
                            │     (served from /edit)          │
                            │                                  │
                            │  ┌─────────────────────────────┐│
                            │  │ APIBridge.ts                ││
                            │  │ - WebSocket client          ││
                            │  │ - Session ID management     ││
                            │  │ - Note time/tick conversion ││
                            │  │ - Track/instrument control  ││
                            │  └─────────────────────────────┘│
                            │                                  │
                            │  Piano Roll (WebGL)              │
                            └──────────────────────────────────┘
```

### Session ID System

Each browser tab gets a unique 4-character session ID (e.g., `abc1`). This enables:
- Multiple users/browsers simultaneously
- AI targets specific browser instance
- No conflicts between sessions

---

## MCP Tools

All tools require a `session_id` parameter to identify which browser to control.

### `get_piano_roll_state(session_id)`
Read all notes and tracks from the piano roll.

```python
get_piano_roll_state("abc1")
# Returns: tracks with id, name, channel, programNumber, notes
# Each note: midi, time, duration, velocity
# Also returns: timebase, song name
```

### `send_notes(session_id, notes, mode, track_id)`
Add notes to the piano roll.

```python
# Add a C major chord
send_notes("abc1", [
    {"midi": 60, "duration": 2.0, "time": 0},    # C4
    {"midi": 64, "duration": 2.0, "time": 0},    # E4
    {"midi": 67, "duration": 2.0, "time": 0}     # G4
])

# Replace all notes with new ones
send_notes("abc1", [...], mode="replace")

# Send to a specific track
send_notes("abc1", [...], track_id=2)
```

### `delete_notes(session_id, notes, track_id)`
Delete specific notes.

```python
delete_notes("abc1", [{"midi": 67, "time": 0}])
```

### `clear_notes(session_id, track_id)`
Clear all notes from a track.

```python
clear_notes("abc1")
clear_notes("abc1", track_id=2)
```

### `create_track(session_id, name, program_number)`
Create a new track with an optional name and GM instrument.

```python
# Create a violin track
create_track("abc1", name="Violin", program_number=40)
# Returns: trackId, channel, name, programNumber
```

### `set_instrument(session_id, track_id, program_number)`
Set the GM instrument on an existing track.

```python
set_instrument("abc1", track_id=2, program_number=32)  # Acoustic Bass
```

### `check_connection(session_id)`
Verify connection status for a specific session.

**Security:** This tool ONLY checks the specified session. It will not list other active sessions.

```python
check_connection("abc1")
# Returns: connected/disconnected status for session "abc1" only
```

---

## Note Format

### Time and Duration (Quarter Notes)

All time values use **quarter notes** (beats), not ticks:

| Value | Meaning |
|-------|---------|
| `time=0` | Beat 1 (start) |
| `time=1` | Beat 2 |
| `time=4` | Beat 5 (measure 2 in 4/4) |
| `duration=0.25` | 16th note |
| `duration=0.5` | 8th note |
| `duration=1.0` | Quarter note |
| `duration=2.0` | Half note |
| `duration=4.0` | Whole note |

### MIDI Note Numbers

| Note | MIDI |
|------|------|
| C4 (Middle C) | 60 |
| E4 | 64 |
| G4 | 67 |
| C5 | 72 |

### Velocity

- Range: `0.0` to `1.0`
- Default: `0.8`
- Converted internally to MIDI 0-127

### GM Instrument Numbers (Common)

| Program | Instrument |
|---------|-----------|
| 0 | Acoustic Grand Piano |
| 24 | Classical Guitar |
| 25 | Acoustic Guitar |
| 32 | Acoustic Bass |
| 33 | Electric Bass |
| 40 | Violin |
| 41 | Viola |
| 42 | Cello |
| 48 | String Ensemble |
| 52 | Choir Aahs |
| 56 | Trumpet |
| 65 | Alto Sax |
| 73 | Flute |

---

## File Structure

```
signal/
├── app/                          # React application
│   └── src/
│       ├── services/
│       │   └── APIBridge.ts      # WebSocket client for MCP
│       ├── hooks/
│       │   └── useMCP.tsx        # React hook for session status
│       └── components/
│           └── App/App.tsx       # Initializes APIBridge
│
├── mcp-server/                   # Python MCP server
│   ├── signal_mcp_server.py      # Combined MCP + WebSocket server
│   └── pyproject.toml            # Python dependencies
│
├── packages/                     # Shared packages
│   ├── @signal-app/player        # Audio engine (SpessaSynth)
│   ├── @signal-app/core          # Core types and utilities
│   └── ...
│
├── Dockerfile                    # Production multi-stage build
└── requirements.txt              # Python dependencies for Docker
```

---

## Development Commands

### App Development

```bash
npm start           # Start dev server (turbo dev)
npm run build       # Build all packages
npm test            # Run tests
npm run lint        # Run linting with Biome
npm run format      # Format code with Biome
npm run check       # Run linting and formatting check with Biome
```

### MCP Server

```bash
cd mcp-server
uv run python signal_mcp_server.py           # Start server
uv pip install -e .                           # Install in dev mode
```

### Testing the API

```bash
# Health check
curl http://localhost:8080/api/health

# Status
curl http://localhost:8080/api/status
```

---

## How It Works

### Message Flow

1. **AI sends MCP request** to `/mcp` endpoint
2. **MCP Server** receives request, looks up session WebSocket
3. **Server sends WebSocket message** to Signal browser
4. **APIBridge.ts** in browser handles action (addNotes, deleteNotes, createTrack, etc.)
5. **Browser sends response** back via WebSocket
6. **MCP Server** returns response to AI

### Time Conversion

The APIBridge converts between:
- **Quarter notes** (API format) - what AI sends
- **Ticks** (Signal internal) - stored in song data

Formula: `ticks = quarterNotes * timebase` (typically timebase=480)

---

## Example Session

```
AI: "Create a string quartet arrangement"

1. AI calls: check_connection("abc1")
   → Verifies browser is connected

2. AI calls: get_piano_roll_state("abc1")
   → Gets current tracks, notes, programNumbers, timebase

3. AI calls: create_track("abc1", name="Cello", program_number=42)
   → New Cello track created, returns trackId=2

4. AI calls: create_track("abc1", name="Viola", program_number=41)
   → New Viola track created, returns trackId=3

5. AI calls: set_instrument("abc1", track_id=1, program_number=40)
   → Sets existing track 1 to Violin

6. AI calls: send_notes("abc1", [...], track_id=1)
   → Violin melody appears in piano roll

7. AI calls: send_notes("abc1", [...], track_id=2)
   → Cello bass line appears

User hears a full string quartet!
```

---

## Troubleshooting

### "Session not found"
- Check that Signal is open at `http://localhost:3000/edit` (or `http://localhost:8080/edit` in production)
- Verify the session ID matches exactly what's shown in Signal's header
- Ensure the browser tab with Signal is still open and connected

### WebSocket won't connect
- Ensure MCP server is running on port 8080
- Check browser console for connection errors
- Verify no firewall blocking WebSocket connections

### MCP tools stale after server restart
- The Claude Code MCP session expires when the server restarts
- Run `/mcp` in Claude Code to reconnect, or start a new session

### Notes not appearing
- Confirm session ID is correct
- Check that you're sending valid MIDI note numbers (0-127)
- Ensure time/duration are positive numbers

### Port conflicts
- MCP Server: Change with `PORT=9000 uv run python signal_mcp_server.py`
- Signal App: Configured in vite config

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Signal App | React 18, TypeScript, MobX, Vite |
| Piano Roll | WebGL |
| Audio | Web Audio API, SpessaSynth |
| MCP Server | Python, FastMCP, FastAPI, Uvicorn |
| WebSocket | Python (Starlette), TypeScript (native) |
| Monorepo | Turbo, npm workspaces |

---

## Docker / Production Deployment

### Quick Deploy with Docker

```bash
# Build and run locally
docker build -t signal-mcp .
docker run -p 8080:8080 signal-mcp

# Or use docker compose
docker compose up --build
```

The production container serves everything on a single port (8080):
- **Signal App:** `http://localhost:8080/edit`
- **MCP Endpoint:** `http://localhost:8080/mcp`
- **WebSocket:** `ws://localhost:8080/ws`
- **Health Check:** `http://localhost:8080/api/health`

### Deploy to Coolify / Digital Ocean

1. **Connect your Git repository** to Coolify
2. **Set build settings:**
   - Build Pack: Docker
   - Dockerfile location: `./Dockerfile`
3. **Set environment variables:**
   - `PORT=8080` (or your preferred port)
   - `NODE_ENV=production`
4. **Configure networking:**
   - Expose port 8080
   - Enable WebSocket support in reverse proxy

### Architecture (Production)

In production, a single Python server handles everything:

```
┌─────────────────┐         ┌──────────────────────────────────┐
│  Claude / AI    │         │     Production Server (Python)   │
│  (MCP Client)   │◀───────▶│     Port 8080                    │
└─────────────────┘  HTTP   │                                  │
                            ├─ /edit     (Signal App)          │
                            ├─ /mcp      (MCP Endpoint)        │
                            ├─ /ws       (WebSocket)           │
                            └─ /api/*    (REST endpoints)      │
                            └──────────────┬───────────────────┘
                                           │ WebSocket
                                           ▼
                            ┌──────────────────────────────────┐
                            │     User's Browser               │
                            │     (same origin = auto-connect) │
                            └──────────────────────────────────┘
```

### Connect AI to Deployed Instance

Once deployed, connect your AI client to the public URL:

```bash
# For Claude Code CLI
claude mcp add signal-mcp -t http https://your-domain.com/mcp

# For remote MCP clients
MCP URL: https://your-domain.com/mcp
```

---

## For AI Assistants

When helping users with this project:

1. **Always get session ID first** - Ask user for their session ID from Signal's header
2. **Check connection** before making changes - Use `check_connection(session_id)`
3. **Get state first** - Use `get_piano_roll_state(session_id)` to see current tracks, notes, and instruments
4. **Use quarter notes** - All time values are in quarter notes, not ticks
5. **Validate responses** - Check `success` field in returned JSON
6. **Match harmony to melody** - When adding accompaniment, analyze melody pitches before choosing chords

### Common Patterns

```python
# Initialize
session = "abc1"  # Get from user
check_connection(session)
state = get_piano_roll_state(session)  # Returns programNumber per track

# Add chord to specific track
send_notes(session, [
    {"midi": 60, "duration": 2, "time": 0},
    {"midi": 64, "duration": 2, "time": 0},
    {"midi": 67, "duration": 2, "time": 0}
], track_id=1)

# Create a new instrument track
result = create_track(session, name="Flute", program_number=73)
track_id = result["data"]["trackId"]
send_notes(session, [...], track_id=track_id)

# Change instrument on existing track
set_instrument(session, track_id=2, program_number=32)  # Acoustic Bass

# Modify notes (delete + add)
delete_notes(session, [{"midi": 67, "time": 0}])
send_notes(session, [{"midi": 69, "duration": 2, "time": 0}])

# Start fresh
send_notes(session, [...], mode="replace")
```
