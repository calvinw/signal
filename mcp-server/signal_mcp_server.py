"""
Signal MCP Server - Combined HTTP/WebSocket/MCP Server

A unified server that provides:
- MCP tools via SSE (for Claude and other LLM clients)
- WebSocket connections (for Signal browser app)
- REST API endpoints (for other integrations)
- Static file serving for Signal app (in production)

Usage:
    python signal_mcp_server.py

    Or with uv:
    uv run python signal_mcp_server.py
"""

import os
import json
import logging
import random
import string
import asyncio
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# =============================================================================
# WebSocket Connection Manager
# =============================================================================

class ConnectionManager:
    """WebSocket connection manager with session support"""

    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self.session_connections: dict[str, WebSocket] = {}  # session_id -> websocket
        self.pending_requests: dict[str, asyncio.Future] = {}  # request_id -> future

    async def connect(self, websocket: WebSocket, session_id: str = None):
        """Accept a WebSocket connection and associate it with a session"""
        await websocket.accept()
        self.active_connections.append(websocket)
        if session_id:
            self.session_connections[session_id] = websocket
            logger.info(f"New WebSocket connection with session {session_id}. Total: {len(self.active_connections)}")
        else:
            logger.info(f"New WebSocket connection (no session). Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        """Remove a WebSocket connection and clean up session associations"""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

        # Remove from session connections
        session_to_remove = None
        for session_id, ws in self.session_connections.items():
            if ws == websocket:
                session_to_remove = session_id
                break

        if session_to_remove:
            del self.session_connections[session_to_remove]
            logger.info(f"WebSocket disconnected (session {session_to_remove}). Total: {len(self.active_connections)}")
        else:
            logger.info(f"WebSocket disconnected. Total: {len(self.active_connections)}")

    async def send_to_session(self, session_id: str, message: dict) -> bool:
        """Send message to specific session. Returns True if successful."""
        if session_id not in self.session_connections:
            return False

        try:
            await self.session_connections[session_id].send_text(json.dumps(message))
            return True
        except Exception as e:
            logger.error(f"Error sending to session {session_id}: {e}")
            self.disconnect(self.session_connections[session_id])
            return False

    async def send_and_wait(self, session_id: str, message: dict, timeout: float = 10.0) -> dict:
        """Send message and wait for response"""
        request_id = message.get("id")
        if not request_id:
            raise ValueError("Message must have an 'id' field")

        # Create future for response
        future = asyncio.Future()
        self.pending_requests[request_id] = future

        # Send message
        success = await self.send_to_session(session_id, message)
        if not success:
            del self.pending_requests[request_id]
            raise ConnectionError(f"Session {session_id} not found or disconnected")

        # Wait for response
        try:
            response = await asyncio.wait_for(future, timeout=timeout)
            return response
        except asyncio.TimeoutError:
            if request_id in self.pending_requests:
                del self.pending_requests[request_id]
            raise TimeoutError(f"Timeout waiting for response from session {session_id}")

    def handle_response(self, request_id: str, response: dict):
        """Handle response from browser"""
        if request_id in self.pending_requests:
            future = self.pending_requests[request_id]
            if not future.done():
                future.set_result(response)
            del self.pending_requests[request_id]

    def generate_session_id(self) -> str:
        """Generate a memorable 4-character session ID (3 letters + 1 digit)"""
        while True:
            letters = ''.join(random.choices(string.ascii_lowercase, k=3))
            digit = random.choice(string.digits)
            session_id = letters + digit
            if session_id not in self.session_connections:
                return session_id

    def get_session_ids(self) -> list[str]:
        """Get list of active session IDs"""
        return list(self.session_connections.keys())

    def session_exists(self, session_id: str) -> bool:
        """Check if a session exists"""
        return session_id in self.session_connections


# Create global connection manager
manager = ConnectionManager()


# =============================================================================
# MCP Tools
# =============================================================================

from fastmcp import FastMCP

mcp = FastMCP("Signal MCP Server")


@mcp.tool()
async def get_piano_roll_state(session_id: str) -> str:
    """
    Read the current piano roll state from Signal.

    Args:
        session_id: The session ID from the Signal browser app (e.g., "abc1")

    Returns:
        JSON string containing all tracks with their notes, including:
        - Track ID, name, and channel
        - All notes with MIDI number, time, duration, and velocity
        - Song metadata (timebase, name)
    """
    if not manager.session_exists(session_id):
        return json.dumps({
            "success": False,
            "error": f"Session '{session_id}' not found. Make sure Signal is open with this session ID."
        })

    try:
        request_id = f"state_{random.randint(1000, 9999)}"
        message = {"id": request_id, "action": "getState", "payload": {}}

        response = await manager.send_and_wait(session_id, message)
        return json.dumps(response, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool()
async def send_notes(
    session_id: str,
    notes: list[dict],
    mode: str = "add",
    track_id: Optional[int] = None
) -> str:
    """
    Send notes to Signal's piano roll.

    Args:
        session_id: The session ID from the Signal browser app (e.g., "abc1")
        notes: List of note dictionaries, each containing:
            - midi: MIDI note number (0-127), e.g., 60 = Middle C
            - duration: Note duration in quarter notes (1.0 = quarter note)
            - time: Start time in quarter notes from beginning (0 = beat 1)
            - velocity: Optional, 0.0-1.0 (default 0.8)
        mode: Either "add" to add to existing notes or "replace" to clear first
        track_id: Optional track ID to add notes to (uses first track if not specified)

    Example:
        # Add a C major chord at beat 0
        send_notes("abc1", [
            {"midi": 60, "duration": 2.0, "time": 0},    # C4
            {"midi": 64, "duration": 2.0, "time": 0},    # E4
            {"midi": 67, "duration": 2.0, "time": 0}     # G4
        ])

    Returns:
        Status of the note creation
    """
    if not manager.session_exists(session_id):
        return json.dumps({
            "success": False,
            "error": f"Session '{session_id}' not found. Make sure Signal is open with this session ID."
        })

    # Validate notes
    if not notes:
        return json.dumps({"success": False, "error": "notes list cannot be empty"})

    for i, note in enumerate(notes):
        if "midi" not in note:
            return json.dumps({"success": False, "error": f"note {i} missing 'midi' field"})
        if "duration" not in note:
            return json.dumps({"success": False, "error": f"note {i} missing 'duration' field"})
        if "time" not in note:
            return json.dumps({"success": False, "error": f"note {i} missing 'time' field"})

    try:
        request_id = f"notes_{random.randint(1000, 9999)}"
        payload = {"notes": notes, "mode": mode}
        if track_id is not None:
            payload["trackId"] = track_id

        message = {"id": request_id, "action": "addNotes", "payload": payload}

        response = await manager.send_and_wait(session_id, message)
        return json.dumps(response, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool()
async def delete_notes(
    session_id: str,
    notes: list[dict],
    track_id: Optional[int] = None
) -> str:
    """
    Delete specific notes from Signal's piano roll.

    Args:
        session_id: The session ID from the Signal browser app (e.g., "abc1")
        notes: List of note dictionaries to delete, each containing:
            - midi: MIDI note number (0-127)
            - time: Start time in quarter notes
        track_id: Optional track ID (uses first track if not specified)

    Example:
        # Delete the G note at beat 0
        delete_notes("abc1", [{"midi": 67, "time": 0}])

    Returns:
        Status of the deletion
    """
    if not manager.session_exists(session_id):
        return json.dumps({
            "success": False,
            "error": f"Session '{session_id}' not found. Make sure Signal is open with this session ID."
        })

    if not notes:
        return json.dumps({"success": False, "error": "notes list cannot be empty"})

    for i, note in enumerate(notes):
        if "midi" not in note:
            return json.dumps({"success": False, "error": f"note {i} missing 'midi' field"})
        if "time" not in note:
            return json.dumps({"success": False, "error": f"note {i} missing 'time' field"})

    try:
        request_id = f"delete_{random.randint(1000, 9999)}"
        payload = {"notes": notes}
        if track_id is not None:
            payload["trackId"] = track_id

        message = {"id": request_id, "action": "deleteNotes", "payload": payload}

        response = await manager.send_and_wait(session_id, message)
        return json.dumps(response, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool()
async def clear_notes(session_id: str, track_id: Optional[int] = None) -> str:
    """
    Clear all notes from a track in Signal's piano roll.

    Args:
        session_id: The session ID from the Signal browser app (e.g., "abc1")
        track_id: Optional track ID to clear (uses first track if not specified)

    Returns:
        Status of the clearing operation
    """
    if not manager.session_exists(session_id):
        return json.dumps({
            "success": False,
            "error": f"Session '{session_id}' not found. Make sure Signal is open with this session ID."
        })

    try:
        request_id = f"clear_{random.randint(1000, 9999)}"
        payload = {}
        if track_id is not None:
            payload["trackId"] = track_id

        message = {"id": request_id, "action": "clearNotes", "payload": payload}

        response = await manager.send_and_wait(session_id, message)
        return json.dumps(response, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool()
async def create_track(
    session_id: str,
    name: Optional[str] = None,
    program_number: int = 0
) -> str:
    """
    Create a new track in Signal's piano roll.

    Args:
        session_id: The session ID from the Signal browser app (e.g., "abc1")
        name: Optional track name (e.g. "Strings", "Bass", "Lead")
        program_number: GM instrument number 0-127 (default 0 = Acoustic Grand Piano)
            Common values: 0=Piano, 25=Acoustic Guitar, 32=Acoustic Bass,
            40=Violin, 48=String Ensemble, 56=Trumpet, 65=Alto Sax, 73=Flute

    Returns:
        JSON with the new track's id, channel, name, and program_number
    """
    if not manager.session_exists(session_id):
        return json.dumps({
            "success": False,
            "error": f"Session '{session_id}' not found. Make sure Signal is open with this session ID."
        })

    try:
        request_id = f"createtrack_{random.randint(1000, 9999)}"
        payload = {"programNumber": program_number}
        if name is not None:
            payload["name"] = name

        message = {"id": request_id, "action": "createTrack", "payload": payload}

        response = await manager.send_and_wait(session_id, message)
        return json.dumps(response, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool()
async def set_instrument(
    session_id: str,
    track_id: int,
    program_number: int
) -> str:
    """
    Set the GM instrument for an existing track.

    Args:
        session_id: The session ID from the Signal browser app (e.g., "abc1")
        track_id: The track ID (get from get_piano_roll_state)
        program_number: GM instrument number 0-127
            Common values: 0=Acoustic Grand Piano, 25=Acoustic Guitar,
            32=Acoustic Bass, 40=Violin, 48=String Ensemble,
            56=Trumpet, 65=Alto Sax, 73=Flute

    Returns:
        Status of the instrument change
    """
    if not manager.session_exists(session_id):
        return json.dumps({
            "success": False,
            "error": f"Session '{session_id}' not found. Make sure Signal is open with this session ID."
        })

    if not (0 <= program_number <= 127):
        return json.dumps({"success": False, "error": "program_number must be 0-127"})

    try:
        request_id = f"setinstr_{random.randint(1000, 9999)}"
        payload = {"trackId": track_id, "programNumber": program_number}

        message = {"id": request_id, "action": "setInstrument", "payload": payload}

        response = await manager.send_and_wait(session_id, message)
        return json.dumps(response, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool()
async def delete_track(session_id: str, track_id: int) -> str:
    """
    Delete a track from Signal's piano roll.

    Args:
        session_id: The session ID from the Signal browser app (e.g., "abc1")
        track_id: The track ID to delete (get from get_piano_roll_state)

    Returns:
        Status of the deletion
    """
    if not manager.session_exists(session_id):
        return json.dumps({
            "success": False,
            "error": f"Session '{session_id}' not found. Make sure Signal is open with this session ID."
        })

    try:
        request_id = f"deletetrack_{random.randint(1000, 9999)}"
        payload = {"trackId": track_id}

        message = {"id": request_id, "action": "deleteTrack", "payload": payload}

        response = await manager.send_and_wait(session_id, message)
        return json.dumps(response, indent=2)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool()
async def check_connection(session_id: str) -> str:
    """
    Check connection status for a specific session.

    Args:
        session_id: The session ID to check (required)

    Returns:
        Connection status for the specified session only
    """
    if manager.session_exists(session_id):
        return json.dumps({
            "success": True,
            "data": {
                "status": "connected",
                "session_id": session_id,
                "message": f"Session {session_id} is connected and ready!"
            }
        }, indent=2)
    else:
        return json.dumps({
            "success": False,
            "error": f"Session '{session_id}' not found. Make sure Signal is open with this session ID."
        }, indent=2)


# =============================================================================
# FastAPI Application
# =============================================================================

# Create MCP ASGI app (using Streamable HTTP transport)
mcp_app = mcp.http_app(path="/mcp")

# Create main FastAPI app with MCP lifespan
# This is required for FastMCP's StreamableHTTPSessionManager to initialize properly
app = FastAPI(title="Signal MCP Server", lifespan=mcp_app.lifespan)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Or ["https://your-username.github.io"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # CRITICAL: This allows the browser client to see the session ID
    expose_headers=["Mcp-Session-Id"]
)

# Define static build directory (for production)
STATIC_BUILD_DIR = Path(__file__).parent / "dist"


# Health check endpoint
@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return JSONResponse({
        "success": True,
        "data": {
            "status": "ok",
            "total_connections": len(manager.active_connections)
        }
    })


# Status endpoint
@app.get("/api/status")
async def get_status():
    """Get detailed status of WebSocket connections"""
    return JSONResponse({
        "success": True,
        "data": {
            "total_connections": len(manager.active_connections),
            "static_build": str(STATIC_BUILD_DIR)
        }
    })


# WebSocket endpoint for Signal browser app
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for Signal browser app"""
    session_id = websocket.query_params.get("session_id")

    if not session_id:
        await websocket.close(code=4000, reason="session_id required")
        return

    logger.info(f"WebSocket connection attempt with session_id='{session_id}'")
    await manager.connect(websocket, session_id)

    try:
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)

                # Handle ping/pong
                if message.get("type") == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))

                # Handle response to MCP request
                elif "id" in message and "response" in message:
                    manager.handle_response(message["id"], message["response"])

            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON received: {data}")

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)


# =============================================================================
# Static File Serving (Production Mode)
# =============================================================================

# Serve the main Signal editor at /edit
@app.get("/edit")
@app.get("/edit.html")
async def serve_edit():
    """Serve the main Signal editor"""
    index_file = STATIC_BUILD_DIR / "edit.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html")
    else:
        return HTMLResponse(
            content="<h1>Signal build not found</h1><p>Run 'npm run build' to build the static files</p>",
            status_code=503
        )

# Redirect root to /edit
@app.get("/")
async def redirect_to_edit():
    """Redirect root to Signal editor"""
    index_file = STATIC_BUILD_DIR / "edit.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html")
    else:
        return HTMLResponse(
            content="<h1>Signal MCP Server</h1><p>MCP endpoint available at /mcp</p>",
            status_code=200
        )

# Serve auth page
@app.get("/auth")
@app.get("/auth.html")
async def serve_auth():
    """Serve the auth page"""
    auth_file = STATIC_BUILD_DIR / "auth.html"
    if auth_file.exists():
        return FileResponse(auth_file, media_type="text/html")
    return HTMLResponse(status_code=404)

# Serve community page
@app.get("/community")
@app.get("/community.html")
@app.get("/home")
@app.get("/profile")
async def serve_community():
    """Serve the community page"""
    community_file = STATIC_BUILD_DIR / "community.html"
    if community_file.exists():
        return FileResponse(community_file, media_type="text/html")
    return HTMLResponse(status_code=404)

# Serve manifest
@app.get("/manifest.webmanifest")
async def serve_manifest():
    manifest_file = STATIC_BUILD_DIR / "manifest.webmanifest"
    if manifest_file.exists():
        return FileResponse(manifest_file, media_type="application/manifest+json")
    return HTMLResponse(status_code=404)

# Serve favicon
@app.get("/favicon.svg")
async def serve_favicon():
    favicon_file = STATIC_BUILD_DIR / "favicon.svg"
    if favicon_file.exists():
        return FileResponse(favicon_file, media_type="image/svg+xml")
    return HTMLResponse(status_code=404)

# Serve service worker
@app.get("/service-worker.js")
async def serve_service_worker():
    sw_file = STATIC_BUILD_DIR / "service-worker.js"
    if sw_file.exists():
        return FileResponse(sw_file, media_type="application/javascript")
    return HTMLResponse(status_code=404)

# Serve workbox files
@app.get("/workbox-{filename}.js")
async def serve_workbox(filename: str):
    workbox_file = STATIC_BUILD_DIR / f"workbox-{filename}.js"
    if workbox_file.exists():
        return FileResponse(workbox_file, media_type="application/javascript")
    return HTMLResponse(status_code=404)

# Serve icon files
@app.get("/icon-{size}.png")
async def serve_icon(size: str):
    icon_file = STATIC_BUILD_DIR / f"icon-{size}.png"
    if icon_file.exists():
        return FileResponse(icon_file, media_type="image/png")
    return HTMLResponse(status_code=404)

# Serve cursor SVG
@app.get("/cursor-pencil.svg")
async def serve_cursor():
    cursor_file = STATIC_BUILD_DIR / "cursor-pencil.svg"
    if cursor_file.exists():
        return FileResponse(cursor_file, media_type="image/svg+xml")
    return HTMLResponse(status_code=404)

# Mount static assets if they exist
if STATIC_BUILD_DIR.exists() and (STATIC_BUILD_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_BUILD_DIR / "assets")), name="assets")

# Mount MCP server at root (must be last)
app.mount("/", mcp_app)


# =============================================================================
# Main Entry Point
# =============================================================================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    host = os.environ.get("HOST", "0.0.0.0")

    print(f"""
🎹 Signal MCP Server Starting on port {port}!

🌐 Web Interface: http://localhost:{port}/edit
🤖 MCP Endpoint:  http://localhost:{port}/mcp (Streamable HTTP)
⚡ WebSocket:     ws://localhost:{port}/ws
📊 Status:        http://localhost:{port}/api/status

📁 Serving static build from: {STATIC_BUILD_DIR}

Ready for both web browsers and Claude integration! 🎯
    """)

    uvicorn.run(app, host=host, port=port)
