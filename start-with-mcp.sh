#!/bin/bash
# Start Signal with MCP API server

echo "Starting Signal with MCP integration..."
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Install API server dependencies if needed
if [ ! -d "$SCRIPT_DIR/api-server/node_modules" ]; then
    echo "Installing API server dependencies..."
    (cd "$SCRIPT_DIR/api-server" && npm install)
fi

# Start the API server in background
echo "Starting API server on port 3001..."
node "$SCRIPT_DIR/api-server/server.js" &
API_PID=$!

# Give it a moment to start
sleep 1

# Start Signal app (npm start runs turbo dev which starts the app)
echo "Starting Signal app..."
(cd "$SCRIPT_DIR" && npm start) &
SIGNAL_PID=$!

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Signal MCP Integration Started                            ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  Signal App:    http://localhost:3000/edit                 ║"
echo "║  API Server:    http://localhost:3001                      ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  Press Ctrl+C to stop all services                         ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Handle cleanup
cleanup() {
    echo ""
    echo "Stopping services..."
    kill $API_PID 2>/dev/null
    kill $SIGNAL_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for processes
wait
