#!/usr/bin/env node
/**
 * Signal MCP API Server
 *
 * A standalone HTTP server that bridges external API requests to Signal's
 * React app via WebSocket.
 *
 * Run this server alongside the Signal app:
 *   node api-server/server.js
 *
 * Endpoints:
 *   GET  /api/health       - Check server status
 *   GET  /api/state        - Get piano roll state
 *   POST /api/notes        - Add notes to a track
 *   DELETE /api/notes      - Delete specific notes
 *   POST /api/notes/clear  - Clear all notes from a track
 */

const http = require("http")
const { WebSocketServer } = require("ws")
const { URL } = require("url")

const HTTP_PORT = process.env.API_PORT || 3001
const HOST = process.env.API_HOST || "localhost"

// Store connected Signal app client
let signalClient = null
const pendingRequests = new Map()
let requestIdCounter = 0

/**
 * Generate a unique request ID
 */
function generateRequestId() {
  return `req_${++requestIdCounter}_${Date.now()}`
}

/**
 * Send a request to Signal and wait for response
 */
function sendToSignal(action, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!signalClient || signalClient.readyState !== 1) {
      reject(new Error("Signal app not connected. Make sure Signal is running and the API bridge is initialized."))
      return
    }

    const id = generateRequestId()
    const timeout = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error("Request timeout - Signal app did not respond"))
    }, 10000)

    pendingRequests.set(id, { resolve, reject, timeout })

    signalClient.send(JSON.stringify({ id, action, payload }))
  })
}

/**
 * Parse request body as JSON
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", chunk => body += chunk)
    req.on("end", () => {
      if (!body) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (e) {
        reject(new Error("Invalid JSON body"))
      }
    })
    req.on("error", reject)
  })
}

/**
 * Send JSON response
 */
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  })
  res.end(JSON.stringify(data, null, 2))
}

/**
 * Handle HTTP requests
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${HTTP_PORT}`)
  const path = url.pathname
  const method = req.method

  // Handle CORS preflight
  if (method === "OPTIONS") {
    sendJSON(res, 200, {})
    return
  }

  try {
    // Health check (doesn't require Signal connection)
    if (path === "/api/health" && method === "GET") {
      sendJSON(res, 200, {
        success: true,
        data: {
          status: "ok",
          signalConnected: signalClient?.readyState === 1,
          port: HTTP_PORT
        }
      })
      return
    }

    // All other endpoints require Signal connection
    if (!signalClient || signalClient.readyState !== 1) {
      sendJSON(res, 503, {
        success: false,
        error: "Signal app not connected. Start Signal and wait for connection."
      })
      return
    }

    // Route handling
    if (path === "/api/state" && method === "GET") {
      const result = await sendToSignal("getState")
      sendJSON(res, result.success ? 200 : 400, result)
    }
    else if (path === "/api/notes" && method === "POST") {
      const body = await parseBody(req)
      const result = await sendToSignal("addNotes", body)
      sendJSON(res, result.success ? 200 : 400, result)
    }
    else if (path === "/api/notes" && method === "DELETE") {
      const body = await parseBody(req)
      const result = await sendToSignal("deleteNotes", body)
      sendJSON(res, result.success ? 200 : 400, result)
    }
    else if (path === "/api/notes/clear" && method === "POST") {
      const body = await parseBody(req)
      const result = await sendToSignal("clearNotes", body)
      sendJSON(res, result.success ? 200 : 400, result)
    }
    else {
      sendJSON(res, 404, {
        success: false,
        error: `Unknown endpoint: ${method} ${path}`
      })
    }
  } catch (error) {
    sendJSON(res, 500, {
      success: false,
      error: error.message
    })
  }
}

/**
 * Start the server
 */
function startServer() {
  // Create HTTP server
  const httpServer = http.createServer(handleRequest)

  // Create WebSocket server on the same port
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" })

  wss.on("connection", (ws) => {
    console.log("[API Server] Signal app connected")
    signalClient = ws

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString())
        const { id, response } = message

        // Handle response to pending request
        if (id && pendingRequests.has(id)) {
          const pending = pendingRequests.get(id)
          clearTimeout(pending.timeout)
          pendingRequests.delete(id)
          pending.resolve(response)
        }
      } catch (error) {
        console.error("[API Server] Error parsing message:", error)
      }
    })

    ws.on("close", () => {
      console.log("[API Server] Signal app disconnected")
      if (signalClient === ws) {
        signalClient = null
      }
    })

    ws.on("error", (error) => {
      console.error("[API Server] WebSocket error:", error)
    })
  })

  httpServer.listen(HTTP_PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           Signal MCP API Server                             ║
╠════════════════════════════════════════════════════════════╣
║  HTTP API: http://${HOST}:${HTTP_PORT}                          ║
║  WebSocket: ws://${HOST}:${HTTP_PORT}/ws                        ║
╠════════════════════════════════════════════════════════════╣
║  Endpoints:                                                 ║
║    GET  /api/health       - Server status                   ║
║    GET  /api/state        - Get piano roll state            ║
║    POST /api/notes        - Add notes                       ║
║    DELETE /api/notes      - Delete notes                    ║
║    POST /api/notes/clear  - Clear all notes                 ║
╠════════════════════════════════════════════════════════════╣
║  Waiting for Signal app to connect...                       ║
╚════════════════════════════════════════════════════════════╝
    `)
  })
}

// Start the server
startServer()
