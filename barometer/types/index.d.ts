// From `claude auth status --text`; null until it answers
export type Account = { email: string | null; plan: string | null } | null

// null until the main conversation's next model request; level null for a model that takes no effort
export type Effort = { level: string | null } | null

// The last reading of each plan window, kept because Claude Code stops reporting a window once it resets
export type RememberedLimit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    barometer: {
      account: Account
      isCompacting: boolean
      compactedTokens: number | null
      effort: Effort
      lastLimits: RememberedLimit[]
    }
  }
}
