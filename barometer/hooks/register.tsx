import { atom, read, update } from 'claude-code'
import type { ConfigRow, EngineInterface, PluginOptions, Register, RenderElement, SessionCompactResult, SessionRateLimit, SessionUsage } from 'claude-code'

import type { Account, Effort, RememberedLimit } from '../types'

const account = atom({ plugin: 'barometer', key: 'account' } as const, null as Account)
const isCompacting = atom({ plugin: 'barometer', key: 'isCompacting' } as const, false)
const compactedTokens = atom({ plugin: 'barometer', key: 'compactedTokens' } as const, null as number | null)
const effort = atom({ plugin: 'barometer', key: 'effort' } as const, null as Effort)
const lastLimits = atom({ plugin: 'barometer', key: 'lastLimits' } as const, [] as RememberedLimit[])

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// xterm-256 colors 46, 118, 226, 208, 196, 117 and 250, as hex
const GREEN = '#00ff00'
const YELLOW_GREEN = '#87ff00'
const YELLOW = '#ffff00'
const ORANGE = '#ff8700'
const RED = '#ff0000'
const ACCOUNT = '#87d7ff'
const ELAPSED = '#bcbcbc'

const FILLED = '━'
// Heavy left half, light right half: a fill that ends mid-cell
const HALF_FILLED = '╾'
const EMPTY = '─'
const MARK_ON_FILLED = '╋'
const MARK_ON_EMPTY = '╂'

const REFRESH_MS = 5_000
const LABEL_COLUMNS = 8
const PERCENT_COLUMNS = 5
const COMPACT_BELOW_COLUMNS = 60
const FOLDED_GAP_COLUMNS = 3
const PAD_FROM_ROWS = 5
const FRAME_FROM_ROWS = 6
const FRAME_ROWS = 2
const FRAME_MARGIN_LEFT = 2
const FRAME_PADDING_X = 1
const FRAME_COLUMNS = FRAME_MARGIN_LEFT + 2 + 2 * FRAME_PADDING_X
const IDENTITY_COLUMN_FROM = 100
const PROJECT_AFTER_ELAPSED_PERCENT = 5

const PLAN_WINDOWS = [
  { kind: 'five_hour', label: '5h', lengthMs: 5 * HOUR },
  { kind: 'seven_day', label: 'Week', lengthMs: 7 * DAY },
] as const

type Style = { color?: string; dimColor?: true }
type Cell = Style & { glyph: string }
type Marker = { atPercent: number; color: string }
type Pace = { resetsInMs?: number; elapsedPercent?: number; runsOutInMs?: number }
type Plan = (typeof PLAN_WINDOWS)[number] & { limit: SessionRateLimit; pace: Pace }
// null: the person set 0, which turns that red line off
type RedLines = { million: number | null; standard: number | null }

const GRADIENT = [GREEN, YELLOW_GREEN, YELLOW, ORANGE]
const PLAN_LIMITS = [50, 70, 85, 94] as const
// Each context colour ends at this share of the red line: 60 gives 30/45/52/60, 80 gives 40/60/70/80
const CONTEXT_STEPS_OF_RED_LINE = [0.5, 0.75, 0.875, 1] as const

function gradient(percent: number, limits: readonly number[]): string {
  const step = limits.findIndex(limit => Math.round(percent) <= limit)
  return GRADIENT[step] ?? RED
}

function redLineOption(options: PluginOptions, name: string): number | null {
  const value = options[name]
  if (typeof value !== 'number') throw new Error(`barometer: option ${name} should be a number, got ${JSON.stringify(value)}`)
  return value === 0 ? null : value
}

function booleanOption(options: PluginOptions, name: string): boolean {
  const value = options[name]
  if (typeof value !== 'boolean') throw new Error(`barometer: option ${name} should be true or false, got ${JSON.stringify(value)}`)
  return value
}

const planColor = (percent: number) => gradient(percent, PLAN_LIMITS)
const redLine = (window: number, redLines: RedLines) => (window >= 1_000_000 ? redLines.million : redLines.standard)
// undefined with the red line off: the bar and percent keep the terminal's own text colour
function contextColor(percent: number, window: number, redLines: RedLines): string | undefined {
  const line = redLine(window, redLines)
  if (line === null) return undefined
  return gradient(
    percent,
    CONTEXT_STEPS_OF_RED_LINE.map(share => Math.floor(line * share)),
  )
}
const colorOf = (color: string | undefined) => (color === undefined ? {} : { color })
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

function duration(ms: number): string {
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

function tokenCount(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

function modelName(raw: string): string {
  if (/\s/.test(raw)) return raw
  const [family, ...version] = raw
    .replace(/^claude-/, '')
    .replace(/\[1m\]$/i, '')
    .split('-')
    .filter(part => !/^\d{8}$/.test(part))
  if (!family) return raw
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return version.length > 0 ? `${name} ${version.join('.')}` : name
}

function reasoningLine(reading: Effort, isThinking: boolean | undefined): string | null {
  const parts: string[] = []
  if (reading === null) parts.push('? effort')
  else if (reading.level !== null) parts.push(`${reading.level} effort`)
  if (isThinking !== undefined) parts.push(`thinking ${isThinking ? 'on' : 'off'}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function pace(limit: SessionRateLimit, lengthMs: number, now: number): Pace {
  const resetsAt = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return {}
  const startedAt = resetsAt - lengthMs
  const elapsedMs = Math.max(0, now - startedAt)
  const elapsedPercent = Math.min(100, (elapsedMs / lengthMs) * 100)
  const known = { resetsInMs: resetsAt - now, elapsedPercent }
  const canProject = elapsedPercent >= PROJECT_AFTER_ELAPSED_PERCENT && limit.percentUsed > 0 && limit.percentUsed < 100
  if (!canProject) return known
  const runsOutAt = startedAt + (elapsedMs / limit.percentUsed) * 100
  return runsOutAt < resetsAt ? { ...known, runsOutInMs: runsOutAt - now } : known
}

function meterCells(columns: number, percent: number | undefined, color: string | undefined, marker?: Marker): Cell[] {
  const filledHalves = percent === undefined ? 0 : Math.round((clamp(percent, 0, 100) / 100) * columns * 2)
  const markerAt = marker === undefined ? -1 : Math.min(columns - 1, Math.floor((marker.atPercent / 100) * columns))
  return Array.from({ length: columns }, (_, index): Cell => {
    const halvesHere = clamp(filledHalves - index * 2, 0, 2)
    if (marker !== undefined && index === markerAt) {
      return { glyph: halvesHere > 0 ? MARK_ON_FILLED : MARK_ON_EMPTY, color: marker.color }
    }
    if (halvesHere === 2) return { glyph: FILLED, ...colorOf(color) }
    if (halvesHere === 1) return { glyph: HALF_FILLED, ...colorOf(color) }
    return { glyph: EMPTY, dimColor: true }
  })
}

function runs(cells: readonly Cell[]): Array<{ style: Style; glyphs: string }> {
  const grouped: Array<{ style: Style; glyphs: string }> = []
  for (const { glyph, ...style } of cells) {
    const last = grouped.at(-1)
    const isSameStyle = last !== undefined && last.style.color === style.color && last.style.dimColor === style.dimColor
    if (isSameStyle) last.glyphs += glyph
    else grouped.push({ style, glyphs: glyph })
  }
  return grouped
}

function nextReset(resetsAt: number, lengthMs: number, now: number): number {
  let next = resetsAt
  while (next <= now) next += lengthMs
  return next
}

// A window past its reset is drawn as the fresh one, starting where the old one ended: what a new
// session reads from Claude Code then. A long-running session stops reporting the window instead.
function plansOf(usage: SessionUsage, remembered: readonly RememberedLimit[], now: number): Plan[] {
  return PLAN_WINDOWS.flatMap(window => {
    const reported = usage.rateLimits.find(candidate => candidate.kind === window.kind)
    const known = reported ?? remembered.find(candidate => candidate.kind === window.kind)
    if (known === undefined) return []
    const resetsAt = known.resetsAt === undefined ? Number.NaN : Date.parse(known.resetsAt)
    const hasReset = Number.isFinite(resetsAt) && resetsAt <= now
    if (reported === undefined && !hasReset) return []
    const limit: SessionRateLimit = hasReset
      ? { kind: known.kind, percentUsed: 0, resetsAt: new Date(nextReset(resetsAt, window.lengthMs, now)).toISOString() }
      : known
    return [{ ...window, limit, pace: pace(limit, window.lengthMs, now) }]
  })
}

async function rememberLimits($: EngineInterface, reported: readonly SessionRateLimit[]) {
  if (reported.length === 0) return
  const known = await read($, lastLimits)
  const merged = [...known.filter(limit => !reported.some(fresh => fresh.kind === limit.kind)), ...reported]
  if (JSON.stringify(merged) !== JSON.stringify(known)) await update($, lastLimits, () => merged)
}

async function rememberCompaction($: EngineInterface, result: SessionCompactResult) {
  if (result.skip !== undefined) return
  await update($, compactedTokens, () => result.tokensAfter ?? null)
}

async function refreshAccount($: EngineInterface) {
  try {
    const status = await $.process.run(['claude', 'auth', 'status', '--text'], { timeoutMs: 10_000 })
    const email = /^Email: (.+)$/m.exec(status.stdout)?.[1]?.trim() ?? null
    // "Login method: Claude Max account" names the plan as Claude Code's welcome banner does ("Claude Max")
    const plan = /^Login method: (.+?)(?: account)?$/m.exec(status.stdout)?.[1]?.trim() ?? null
    await update($, account, () => ({ email, plan }))
  } catch {
    // claude missing from PATH or the call timed out: the band leaves the account out
  }
}

async function compactNow($: EngineInterface) {
  if (await read($, isCompacting)) return
  await update($, isCompacting, () => true)
  try {
    await rememberCompaction($, await $.session.compact())
  } catch (error) {
    $.ui.toast(`Compact failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await update($, isCompacting, () => false)
  }
}

export const register: Register = (on, options) => {
  const redLines: RedLines = { million: redLineOption(options, 'redLine1M'), standard: redLineOption(options, 'redLine200k') }
  const alwaysShowCompact = booleanOption(options, 'alwaysShowCompact')

  on('session.start', async ($, e, next) => {
    $.clock.after(0, () => void refreshAccount($))
    $.clock.every(REFRESH_MS, async () => {
      await rememberLimits($, (await $.session.usage()).rateLimits)
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    $.clock.after(0, () => void refreshAccount($))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.context.tokens !== undefined && (await read($, compactedTokens)) !== null) {
      await update($, compactedTokens, () => null)
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Effort comes off the main conversation's requests: it has no /config row, and $.process.run's env carries no CLAUDE_EFFORT
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const level = e.effort === undefined ? null : typeof e.effort === 'number' ? tokenCount(e.effort) : e.effort
      const known = await read($, effort)
      if (known === null || known.level !== level) await update($, effort, () => ({ level }))
    }
    return yield* next(e)
  })

  on('command.run', { command: ['effort', 'model'] }, async ($, e, next) => {
    const result = await next(e)
    await update($, effort, () => null)
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute') await rememberCompaction($, result)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const [usage, rawModel, identity, compacting, compacted, effortReading, remembered, configRows, now] = await Promise.all([
      $.session.usage(),
      $.session.model(),
      read($, account),
      read($, isCompacting),
      read($, compactedTokens),
      read($, effort),
      read($, lastLimits),
      $.config.list().catch((): ConfigRow[] => []),
      $.clock.now(),
    ])
    const { Box, Button, Text } = $.ui.resolve(e)
    const { bodyColumns, isWorking, maxRows } = e.props
    const model = modelName(rawModel)
    const email = identity?.email ?? null
    const plan = identity?.plan ?? null
    const accountLength = (email?.length ?? 0) + (plan === null ? 0 : plan.length + (email === null ? 0 : 3))
    const accountTexts: RenderElement[] = []
    if (email !== null) accountTexts.push(<Text color={ACCOUNT}>{email}</Text>)
    if (plan !== null) accountTexts.push(<Text dimColor>{email === null ? plan : ` · ${plan}`}</Text>)
    const thinkingValue = configRows.find(row => row.key === 'thinking')?.value
    const reasoning = reasoningLine(effortReading, typeof thinkingValue === 'boolean' ? thinkingValue : undefined)
    const contextWindow = usage.context.window
    const contextTokens = usage.context.tokens ?? compacted ?? undefined
    const contextPercent =
      usage.context.percent ?? (compacted === null ? undefined : Math.round((compacted / contextWindow) * 100))
    const plans = plansOf(usage, remembered, now)
    const showHint = plans.length === 0 && contextPercent === undefined
    const isFramed = maxRows >= FRAME_FROM_ROWS
    const columns = isFramed ? bodyColumns - FRAME_COLUMNS : bodyColumns
    const isCompact = columns < COMPACT_BELOW_COLUMNS || maxRows < 3
    const topPadding = maxRows - (isFramed ? FRAME_ROWS : 0) >= PAD_FROM_ROWS ? 1 : 0
    // No bottom margin: Claude Code already leaves a blank row between the band and the prompt
    const frame = (content: RenderElement) =>
      isFramed ? (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={FRAME_PADDING_X} marginLeft={FRAME_MARGIN_LEFT}>
          {content}
        </Box>
      ) : (
        content
      )

    // flexShrink 0 on the bar and its label and percent columns: only the detail text gives way when a row runs long
    const strip = (cells: readonly Cell[]) => (
      <Box flexDirection="row" flexShrink={0}>
        {runs(cells).map(run => (
          <Text {...run.style}>{run.glyphs}</Text>
        ))}
      </Box>
    )
    const separator = <Text dimColor>{' | '}</Text>
    const hint = <Text dimColor>Rate: populates after first API call</Text>
    const contextRedLine = redLine(contextWindow, redLines)
    const isPastRedLine = contextPercent !== undefined && contextRedLine !== null && contextPercent >= contextRedLine
    const compactButton =
      (alwaysShowCompact || isPastRedLine) && !isWorking && !compacting ? [<Button key="compact" label="Compact" onPress={() => void compactNow($)} />] : []

    if (isCompact) {
      const parts: RenderElement[][] = []
      if (columns >= IDENTITY_COLUMN_FROM) {
        if (accountTexts.length > 0) parts.push(accountTexts)
        parts.push([<Text dimColor>{model}</Text>])
        if (reasoning !== null) parts.push([<Text dimColor>{reasoning}</Text>])
      }
      if (contextPercent !== undefined) {
        parts.push([
          <Text {...colorOf(contextColor(contextPercent, contextWindow, redLines))}>{`Context: ${contextPercent}%`}</Text>,
          ...(compactButton.length > 0 ? [<Text> </Text>, ...compactButton] : []),
        ])
      } else if (compactButton.length > 0) {
        parts.push(compactButton)
      }
      for (const plan of plans) {
        const used = Math.round(plan.limit.percentUsed)
        const reset = plan.pace.resetsInMs === undefined ? [] : [<Text dimColor>{` (resets in ${duration(plan.pace.resetsInMs)})`}</Text>]
        parts.push([<Text color={planColor(used)}>{`${plan.label}: ${used}%`}</Text>, ...reset])
      }
      if (showHint) parts.push([hint])
      return (
        <Box flexDirection="column" paddingTop={topPadding}>
          {below}
          {frame(
            // Spaced, not " | "-separated: a separator ends up dangling at the end of a wrapped line
            <Box flexDirection="row" flexWrap="wrap" columnGap={FOLDED_GAP_COLUMNS}>
              {parts.map(part => (
                <Box flexDirection="row" flexShrink={0}>
                  {part}
                </Box>
              ))}
            </Box>,
          )}
        </Box>
      )
    }

    const showIdentityColumn = columns >= IDENTITY_COLUMN_FROM
    const identityColumns = showIdentityColumn ? Math.max(accountLength, model.length, reasoning?.length ?? 0) + 2 : 0
    const available = columns - LABEL_COLUMNS - PERCENT_COLUMNS - 2 - identityColumns
    const barColumns = clamp(Math.floor(available * 0.4), 10, 40)

    const gauge = (label: string, cells: readonly Cell[], percent: RenderElement, detail: RenderElement[]) => (
      <Box flexDirection="row">
        <Box width={LABEL_COLUMNS} flexShrink={0}>
          <Text>{label}</Text>
        </Box>
        {strip(cells)}
        <Box width={PERCENT_COLUMNS} justifyContent="flex-end" flexShrink={0}>
          {percent}
        </Box>
        <Box marginLeft={2} flexGrow={1} flexDirection="row" columnGap={1} overflow="hidden">
          {detail}
        </Box>
      </Box>
    )

    const contextFill = contextColor(contextPercent ?? 0, contextWindow, redLines)
    const tokensShown = contextTokens === undefined ? '?' : tokenCount(contextTokens)
    const contextRow = gauge(
      'Context',
      meterCells(barColumns, contextPercent, contextFill, contextRedLine === null ? undefined : { atPercent: contextRedLine, color: RED }),
      contextPercent === undefined ? <Text dimColor>–</Text> : <Text {...colorOf(contextFill)}>{`${contextPercent}%`}</Text>,
      [<Text dimColor wrap="truncate-end">{`${tokensShown}/${tokenCount(contextWindow)}`}</Text>, ...compactButton],
    )

    const planRows = plans.map(plan => {
      const used = Math.round(plan.limit.percentUsed)
      const color = planColor(used)
      const elapsed = plan.pace.elapsedPercent
      const marker = elapsed === undefined ? undefined : { atPercent: elapsed, color: plan.limit.percentUsed > elapsed ? ORANGE : ELAPSED }
      const detail: RenderElement[] = []
      if (plan.pace.resetsInMs !== undefined) {
        detail.push(
          <Box flexShrink={0}>
            <Text dimColor>{`resets in ${duration(plan.pace.resetsInMs)}`}</Text>
          </Box>,
        )
      }
      if (plan.pace.runsOutInMs !== undefined) {
        detail.push(<Text dimColor>·</Text>)
        detail.push(<Text color={ORANGE} wrap="truncate-end">{`out in ~${duration(plan.pace.runsOutInMs)} at this pace`}</Text>)
      }
      return gauge(plan.label, meterCells(barColumns, plan.limit.percentUsed, color, marker), <Text color={color}>{`${used}%`}</Text>, detail)
    })

    const gauges = (
      <Box flexDirection="column" flexGrow={1}>
        {contextRow}
        {planRows}
        {showHint ? hint : null}
      </Box>
    )
    const identityColumn = (
      <Box flexDirection="column" alignItems="flex-end" marginLeft={2} flexShrink={0}>
        {accountTexts.length === 0 ? null : <Box flexDirection="row">{accountTexts}</Box>}
        <Text dimColor>{model}</Text>
        {reasoning === null ? null : <Text dimColor>{reasoning}</Text>}
      </Box>
    )
    // One row, never two: the band's row budget counts it as one, so the tail truncates instead of wrapping
    const identityRow =
      !showIdentityColumn && maxRows >= 4 ? (
        <Box flexDirection="row" overflow="hidden">
          {accountTexts.length === 0 ? null : (
            <Box flexDirection="row" flexShrink={0}>
              {accountTexts}
              {separator}
            </Box>
          )}
          <Box flexDirection="row" flexShrink={0}>
            <Text dimColor>{model}</Text>
            {reasoning === null ? null : separator}
          </Box>
          {reasoning === null ? null : <Text dimColor wrap="truncate-end">{reasoning}</Text>}
        </Box>
      ) : null

    return (
      <Box flexDirection="column" paddingTop={topPadding}>
        {below}
        {frame(
          <Box flexDirection="column">
            {identityRow}
            <Box flexDirection="row">
              {gauges}
              {showIdentityColumn ? identityColumn : null}
            </Box>
          </Box>,
        )}
      </Box>
    )
  })
}
