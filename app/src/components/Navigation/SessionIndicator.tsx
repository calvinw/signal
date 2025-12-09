/**
 * Session Indicator - Displays the MCP session ID and connection status
 *
 * Shows a small indicator that users can copy to share with Claude
 * for controlling this browser instance.
 */

import styled from "@emotion/styled"
import { FC, useCallback, useState } from "react"
import { useMCP } from "../../hooks/useMCP"
import { Tooltip } from "../ui/Tooltip"

const Container = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 0 0.75rem;
  font-size: 0.7rem;
  color: var(--color-text-secondary);
  cursor: pointer;
  -webkit-app-region: none;
  user-select: none;

  &:hover {
    background: var(--color-highlight);
  }
`

const SessionId = styled.span`
  font-family: monospace;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text);
  margin-left: 0.3rem;
  letter-spacing: 0.05rem;
`

const StatusDot = styled.span<{ status: string }>`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 0.4rem;
  background-color: ${({ status }) => {
    switch (status) {
      case "connected":
        return "#4ade80" // green
      case "connecting":
        return "#facc15" // yellow
      case "error":
        return "#f87171" // red
      default:
        return "#6b7280" // gray
    }
  }};
`

const CopiedMessage = styled.span`
  font-size: 0.65rem;
  color: #4ade80;
  margin-left: 0.5rem;
`

export const SessionIndicator: FC = () => {
  const { sessionId, connectionStatus, isConnected } = useMCP()
  const [copied, setCopied] = useState(false)

  const handleClick = useCallback(() => {
    navigator.clipboard.writeText(sessionId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [sessionId])

  const tooltipContent = isConnected
    ? "Click to copy session ID. Share this with Claude to control Signal."
    : `Connection status: ${connectionStatus}. Click to copy session ID.`

  return (
    <Tooltip title={tooltipContent} delayDuration={300}>
      <Container onClick={handleClick}>
        <span>Session:</span>
        <SessionId>{sessionId.toUpperCase()}</SessionId>
        <StatusDot status={connectionStatus} />
        {copied && <CopiedMessage>Copied!</CopiedMessage>}
      </Container>
    </Tooltip>
  )
}
