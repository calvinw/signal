"""
Signal MCP Server - Combined HTTP/WebSocket/MCP Server

A unified server that provides:
- MCP tools via Streamable HTTP (for Claude and other LLM clients)
- WebSocket connections (for Signal browser app)
- REST API endpoints (for other integrations)

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
from typing import Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
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
async def check_connection(session_id: str = None) -> str:
    """
    Check connection status. If session_id provided, checks that specific session.
    Otherwise returns list of all connected sessions.

    Args:
        session_id: Optional session ID to check specific connection

    Returns:
        Connection status information
    """
    if session_id:
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
                "error": f"Session '{session_id}' not found. Active sessions: {manager.get_session_ids()}"
            }, indent=2)
    else:
        return json.dumps({
            "success": True,
            "data": {
                "total_connections": len(manager.active_connections),
                "active_sessions": manager.get_session_ids()
            }
        }, indent=2)


# =============================================================================
# FastAPI Application
# =============================================================================

# Create MCP ASGI app
mcp_app = mcp.http_app(transport="streamable-http")

# Create main FastAPI app
app = FastAPI(title="Signal MCP Server")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# Health check endpoint
@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return JSONResponse({
        "success": True,
        "data": {
            "status": "ok",
            "total_connections": len(manager.active_connections),
            "active_sessions": manager.get_session_ids()
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
            "active_sessions": manager.get_session_ids()
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


# Mount MCP server at /mcp
app.mount("/mcp", mcp_app)


# =============================================================================
# Main Entry Point
# =============================================================================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3001))
    host = os.environ.get("HOST", "0.0.0.0")

    print(f"""
╔════════════════════════════════════════════════════════════╗
║              Signal MCP Server                             ║
╠════════════════════════════════════════════════════════════╣
║  MCP Endpoint:  http://{host}:{port}/mcp                      ║
║  WebSocket:     ws://{host}:{port}/ws                         ║
║  Health Check:  http://{host}:{port}/api/health               ║
╠════════════════════════════════════════════════════════════╣
║  For Claude Desktop or other MCP clients, add:             ║
║  URL: http://localhost:{port}/mcp                             ║
╠════════════════════════════════════════════════════════════╣
║  Waiting for Signal browser connections...                 ║
╚════════════════════════════════════════════════════════════╝
    """)

    uvicorn.run(app, host=host, port=port)
