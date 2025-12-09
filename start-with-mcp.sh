#!/bin/bash
# Start Signal with MCP API server

echo "Starting Signal with MCP integration..."
echo ""

# Check if we're in the signal directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Install API server dependencies if needed
if [ ! -d "api-server/node_modules" ]; then
    echo "Installing API server dependencies..."
    cd api-server && npm install && cd ..
fi

# Start the API server in background
echo "Starting API server on port 3001..."
node api-server/server.js &
API_PID=$!

# Give it a moment to start
sleep 1

# Start Signal app
echo "Starting Signal app..."
npm run dev &
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
