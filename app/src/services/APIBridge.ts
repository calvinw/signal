/**
 * API Bridge for Signal MCP Integration
 *
 * This module creates a WebSocket connection between the React app
 * and the MCP server. It generates a session ID that users can share
 * with Claude to control this specific browser instance.
 */

import RootStore from "../stores/RootStore"
import { emptyTrack, NoteEvent, programChangeMidiEvent, TrackId } from "@signal-app/core"

export interface NoteInput {
  midi: number          // MIDI note number (0-127)
  duration: number      // Duration in quarter notes
  time: number          // Start time in quarter notes
  velocity?: number     // Velocity 0.0-1.0 (default 0.8)
}

export interface AddNotesRequest {
  notes: NoteInput[]
  trackId?: number      // Optional track ID, uses selected track if not specified
  mode?: "add" | "replace"  // "replace" clears existing notes first
}

export interface DeleteNotesRequest {
  notes: { midi: number; time: number }[]
  trackId?: number
}

interface DeleteTrackRequest {
  trackId?: number
}

export interface APIResponse {
  success: boolean
  data?: unknown
  error?: string
}

interface WSMessage {
  id: string
  action: string
  payload?: unknown
}

/**
 * Generate a memorable 4-character session ID (3 letters + 1 digit)
 */
function generateSessionId(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const digits = '0123456789'
  let id = ''
  for (let i = 0; i < 3; i++) {
    id += letters[Math.floor(Math.random() * letters.length)]
  }
  id += digits[Math.floor(Math.random() * digits.length)]
  return id
}

/**
 * API Bridge class that handles WebSocket communication with the MCP server
 */
export class APIBridge {
  private rootStore: RootStore
  private ws: WebSocket | null = null
  private wsUrl: string
  private reconnectInterval: number = 3000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // Session management
  public readonly sessionId: string
  private _connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  private statusListeners: Set<(status: string) => void> = new Set()

  constructor(rootStore: RootStore, wsUrl?: string) {
    this.rootStore = rootStore
    this.sessionId = generateSessionId()

    // Determine WebSocket URL
    if (wsUrl) {
      this.wsUrl = wsUrl
    } else {
      // Auto-detect based on current location
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      let host = window.location.host

      // For local development: if on localhost:3000 (dev server), connect to MCP on 8080
      if (host === 'localhost:3000' || host === '127.0.0.1:3000') {
        host = 'localhost:8080'
      }

      this.wsUrl = `${protocol}//${host}/ws`
    }

    console.log(`[Signal API Bridge] Session ID: ${this.sessionId}`)
    console.log(`[Signal API Bridge] WebSocket URL: ${this.wsUrl}`)
  }

  get connectionStatus(): string {
    return this._connectionStatus
  }

  private setConnectionStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
    this._connectionStatus = status
    this.statusListeners.forEach(listener => listener(status))
  }

  onStatusChange(listener: (status: string) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /**
   * Convert quarter notes to ticks based on the song's timebase
   */
  private quarterNotesToTicks(quarterNotes: number): number {
    const timebase = this.rootStore.songStore.song.timebase
    return Math.round(quarterNotes * timebase)
  }

  /**
   * Convert ticks to quarter notes
   */
  private ticksToQuarterNotes(ticks: number): number {
    const timebase = this.rootStore.songStore.song.timebase
    return ticks / timebase
  }

  /**
   * Get the currently selected track or a specific track by ID
   */
  private getTrack(trackId?: number) {
    const song = this.rootStore.songStore.song

    if (trackId !== undefined) {
      return song.getTrack(trackId as TrackId)
    }

    // Get the first non-conductor track as default
    return song.tracks.find(t => !t.isConductorTrack)
  }

  /**
   * Get piano roll state - all notes and metadata
   */
  getState(): APIResponse {
    try {
      const song = this.rootStore.songStore.song
      const tracks = song.tracks
        .filter(t => !t.isConductorTrack)
        .map(track => {
          const notes = track.events
            .filter((e): e is NoteEvent => e.type === "channel" && (e as any).subtype === "note")
            .map(note => ({
              id: note.id,
              midi: note.noteNumber,
              time: this.ticksToQuarterNotes(note.tick),
              duration: this.ticksToQuarterNotes(note.duration),
              velocity: note.velocity
            }))

          return {
            id: track.id,
            name: track.name,
            channel: track.channel,
            programNumber: track.getProgramNumber(0) ?? 0,
            noteCount: notes.length,
            notes
          }
        })

      return {
        success: true,
        data: {
          timebase: song.timebase,
          name: song.name,
          trackCount: tracks.length,
          tracks
        }
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to get state: ${error}`
      }
    }
  }

  /**
   * Add notes to a track
   */
  addNotes(request: AddNotesRequest): APIResponse {
    try {
      const track = this.getTrack(request.trackId)
      if (!track) {
        return { success: false, error: "Track not found" }
      }

      // If replace mode, clear existing notes first
      if (request.mode === "replace") {
        const noteEvents = track.events.filter(
          (e): e is NoteEvent => e.type === "channel" && (e as any).subtype === "note"
        )
        track.removeEvents(noteEvents.map(n => n.id))
      }

      // Add new notes
      const addedNotes: number[] = []
      for (const note of request.notes) {
        // Convert velocity from 0.0-1.0 to 0-127 (MIDI standard)
        const velocity = Math.round((note.velocity ?? 0.8) * 127)
        const newNote = track.addEvent<NoteEvent>({
          type: "channel",
          subtype: "note",
          noteNumber: note.midi,
          tick: this.quarterNotesToTicks(note.time),
          duration: this.quarterNotesToTicks(note.duration),
          velocity: velocity
        })
        addedNotes.push(newNote.id)
      }

      return {
        success: true,
        data: {
          notesAdded: addedNotes.length,
          noteIds: addedNotes
        }
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to add notes: ${error}`
      }
    }
  }

  /**
   * Delete specific notes from a track
   */
  deleteNotes(request: DeleteNotesRequest): APIResponse {
    try {
      const track = this.getTrack(request.trackId)
      if (!track) {
        return { success: false, error: "Track not found" }
      }

      let deletedCount = 0
      for (const noteToDelete of request.notes) {
        const targetTick = this.quarterNotesToTicks(noteToDelete.time)

        // Find matching note
        const noteEvent = track.events.find(
          (e): e is NoteEvent =>
            e.type === "channel" &&
            (e as any).subtype === "note" &&
            (e as NoteEvent).noteNumber === noteToDelete.midi &&
            e.tick === targetTick
        )

        if (noteEvent) {
          track.removeEvent(noteEvent.id)
          deletedCount++
        }
      }

      return {
        success: true,
        data: { notesDeleted: deletedCount }
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to delete notes: ${error}`
      }
    }
  }

  /**
   * Clear all notes from a track
   */
  clearNotes(trackId?: number): APIResponse {
    try {
      const track = this.getTrack(trackId)
      if (!track) {
        return { success: false, error: "Track not found" }
      }

      const noteEvents = track.events.filter(
        (e): e is NoteEvent => e.type === "channel" && (e as any).subtype === "note"
      )
      const count = noteEvents.length
      track.removeEvents(noteEvents.map(n => n.id))

      return {
        success: true,
        data: { notesCleared: count }
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to clear notes: ${error}`
      }
    }
  }

  /**
   * Create a new track with an optional name and GM program number
   */
  createTrack(name?: string, programNumber?: number): APIResponse {
    try {
      const song = this.rootStore.songStore.song
      const usedChannels = new Set(
        song.tracks.map(t => t.channel).filter((c): c is number => c !== undefined)
      )
      let channel = 0
      for (let i = 0; i <= 15; i++) {
        if (i !== 9 && !usedChannels.has(i)) { channel = i; break }
      }
      const track = emptyTrack(channel)
      if (name) track.setName(name)
      if (programNumber !== undefined) {
        track.createOrUpdate({ ...programChangeMidiEvent(0, channel, programNumber), tick: 0 })
      }
      song.addTrack(track)
      return {
        success: true,
        data: {
          trackId: track.id,
          channel,
          name: track.name ?? "",
          programNumber: track.getProgramNumber(0) ?? 0
        }
      }
    } catch (error) {
      return { success: false, error: `Failed to create track: ${error}` }
    }
  }

  /**
   * Set the GM instrument (program number 0-127) on a track
   */
  setInstrument(trackId: number, programNumber: number): APIResponse {
    try {
      const track = this.getTrack(trackId)
      if (!track) return { success: false, error: "Track not found" }
      if (track.channel === undefined) return { success: false, error: "Cannot set instrument on conductor track" }
      track.createOrUpdate({ ...programChangeMidiEvent(0, track.channel, programNumber), tick: 0 })
      return { success: true, data: { trackId, programNumber } }
    } catch (error) {
      return { success: false, error: `Failed to set instrument: ${error}` }
    }
  }

  /**
   * Delete a track by ID
   */
  deleteTrack(trackId?: number): APIResponse {
    try {
      if (trackId === undefined) return { success: false, error: "trackId is required" }

      const song = this.rootStore.songStore.song
      const track = song.getTrack(trackId as TrackId)
      if (!track) return { success: false, error: "Track not found" }
      if (track.isConductorTrack) return { success: false, error: "Cannot delete conductor track" }

      const trackCount = song.tracks.filter(t => !t.isConductorTrack).length
      if (trackCount <= 1) {
        return { success: false, error: "Cannot delete the last track" }
      }

      song.removeTrack(track.id)
      return { success: true, data: { trackId: track.id } }
    } catch (error) {
      return { success: false, error: `Failed to delete track: ${error}` }
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: WSMessage): APIResponse {
    switch (message.action) {
      case "getState":
        return this.getState()
      case "addNotes":
        return this.addNotes(message.payload as AddNotesRequest)
      case "deleteNotes":
        return this.deleteNotes(message.payload as DeleteNotesRequest)
      case "clearNotes":
        return this.clearNotes((message.payload as { trackId?: number })?.trackId)
      case "createTrack":
        return this.createTrack(
          (message.payload as any)?.name,
          (message.payload as any)?.programNumber
        )
      case "setInstrument":
        return this.setInstrument(
          (message.payload as any)?.trackId,
          (message.payload as any)?.programNumber
        )
      case "deleteTrack":
        return this.deleteTrack((message.payload as DeleteTrackRequest)?.trackId)
      case "health":
        return { success: true, data: { status: "connected" } }
      default:
        return { success: false, error: `Unknown action: ${message.action}` }
    }
  }

  /**
   * Connect to the MCP server via WebSocket with session ID
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log("[Signal API Bridge] Already connected")
      return
    }

    this.setConnectionStatus('connecting')

    try {
      // Append session_id to WebSocket URL
      const url = new URL(this.wsUrl)
      url.searchParams.set('session_id', this.sessionId)

      this.ws = new WebSocket(url.toString())

      this.ws.onopen = () => {
        console.log(`[Signal API Bridge] Connected with session ${this.sessionId}`)
        this.setConnectionStatus('connected')
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WSMessage

          // Handle ping/pong
          if ((message as any).type === 'pong') {
            return
          }

          const response = this.handleMessage(message)

          // Send response back with the same ID
          this.ws?.send(JSON.stringify({
            id: message.id,
            response
          }))
        } catch (error) {
          console.error("[Signal API Bridge] Error handling message:", error)
        }
      }

      this.ws.onclose = () => {
        console.log("[Signal API Bridge] Disconnected, will retry...")
        this.setConnectionStatus('disconnected')
        this.scheduleReconnect()
      }

      this.ws.onerror = (error) => {
        console.error("[Signal API Bridge] WebSocket error:", error)
        this.setConnectionStatus('error')
      }
    } catch (error) {
      console.error("[Signal API Bridge] Failed to connect:", error)
      this.setConnectionStatus('error')
      this.scheduleReconnect()
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectInterval)
  }

  /**
   * Disconnect from the API server
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.setConnectionStatus('disconnected')
  }
}

// Global instance
let bridgeInstance: APIBridge | null = null

/**
 * Initialize and start the API bridge
 */
export function initializeAPIBridge(rootStore: RootStore, wsUrl?: string): APIBridge {
  if (bridgeInstance) {
    console.log("[Signal API Bridge] Already initialized")
    return bridgeInstance
  }

  bridgeInstance = new APIBridge(rootStore, wsUrl)
  bridgeInstance.connect()
  return bridgeInstance
}

/**
 * Get the current bridge instance
 */
export function getAPIBridge(): APIBridge | null {
  return bridgeInstance
}

/**
 * Stop and cleanup the API bridge
 */
export function stopAPIBridge(): void {
  if (bridgeInstance) {
    bridgeInstance.disconnect()
    bridgeInstance = null
  }
}
