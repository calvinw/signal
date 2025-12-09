/**
 * API Bridge for Signal MCP Integration
 *
 * This module creates a WebSocket connection between the React app
 * and an external API server. The API server handles HTTP requests
 * and forwards them to the React app via WebSocket.
 */

import RootStore from "../stores/RootStore"
import { NoteEvent, TrackId } from "@signal-app/core"

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
 * API Bridge class that handles WebSocket communication with the API server
 */
export class APIBridge {
  private rootStore: RootStore
  private ws: WebSocket | null = null
  private wsUrl: string
  private reconnectInterval: number = 3000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(rootStore: RootStore, wsPort = 3001) {
    this.rootStore = rootStore
    this.wsUrl = `ws://localhost:${wsPort}/ws`
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
        const newNote = track.addEvent<NoteEvent>({
          type: "channel",
          subtype: "note",
          noteNumber: note.midi,
          tick: this.quarterNotesToTicks(note.time),
          duration: this.quarterNotesToTicks(note.duration),
          velocity: note.velocity ?? 0.8
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
      case "health":
        return { success: true, data: { status: "connected" } }
      default:
        return { success: false, error: `Unknown action: ${message.action}` }
    }
  }

  /**
   * Connect to the API server via WebSocket
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log("[Signal API Bridge] Already connected")
      return
    }

    try {
      this.ws = new WebSocket(this.wsUrl)

      this.ws.onopen = () => {
        console.log("[Signal API Bridge] Connected to API server")
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WSMessage
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
        this.scheduleReconnect()
      }

      this.ws.onerror = (error) => {
        console.error("[Signal API Bridge] WebSocket error:", error)
      }
    } catch (error) {
      console.error("[Signal API Bridge] Failed to connect:", error)
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
  }
}

// Global instance
let bridgeInstance: APIBridge | null = null

/**
 * Initialize and start the API bridge
 */
export function initializeAPIBridge(rootStore: RootStore, wsPort = 3001): APIBridge {
  if (bridgeInstance) {
    console.log("[Signal API Bridge] Already initialized")
    return bridgeInstance
  }

  bridgeInstance = new APIBridge(rootStore, wsPort)
  bridgeInstance.connect()
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
