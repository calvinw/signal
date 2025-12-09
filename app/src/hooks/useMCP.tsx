/**
 * MCP Hook - React context for MCP session management
 *
 * Provides access to the MCP session ID and connection status
 * throughout the application.
 */

import React, { createContext, useContext, useState, useEffect } from "react"
import { APIBridge } from "../services/APIBridge"

interface MCPContextValue {
  sessionId: string
  connectionStatus: string
  isConnected: boolean
}

const MCPContext = createContext<MCPContextValue | null>(null)

interface MCPProviderProps {
  bridge: APIBridge
  children: React.ReactNode
}

export function MCPProvider({ bridge, children }: MCPProviderProps) {
  const [connectionStatus, setConnectionStatus] = useState(bridge.connectionStatus)

  useEffect(() => {
    // Subscribe to status changes
    const unsubscribe = bridge.onStatusChange((status) => {
      setConnectionStatus(status)
    })

    return unsubscribe
  }, [bridge])

  const value: MCPContextValue = {
    sessionId: bridge.sessionId,
    connectionStatus,
    isConnected: connectionStatus === 'connected'
  }

  return (
    <MCPContext.Provider value={value}>
      {children}
    </MCPContext.Provider>
  )
}

export function useMCP(): MCPContextValue {
  const context = useContext(MCPContext)
  if (!context) {
    throw new Error("useMCP must be used within an MCPProvider")
  }
  return context
}
