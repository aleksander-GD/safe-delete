/** One file or folder safe-delete moved to the Trash. */
export type Trashed = {
  id: string
  /** Where it lived, absolute. */
  original: string
  /** Where it sits in the Trash now, absolute. */
  trashed: string
  kind: 'file' | 'folder'
  /** Epoch seconds. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'safe-delete': {
      /** Restorable items, oldest first. */
      items: Shaped<Trashed[]>
      /** How much of the session's log has been read, in characters. */
      logRead: number
      /** The band is hidden until something new is trashed. */
      isHidden: boolean
      /** The item id (or 'all') whose Delete was pressed once and waits for the confirming press. */
      armed: string | null
      /** The item id the preview pane shows, or null while it is closed. */
      previewing: string | null
    }
  }
}
