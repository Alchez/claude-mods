import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, SessionUsage, TurnStepResult } from 'claude-code'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-05T12:00:00Z')

const GREEN = '#00ff00'
const YELLOW_GREEN = '#87ff00'
const YELLOW = '#ffff00'
const ORANGE = '#ff8700'
const RED = '#ff0000'
const ACCOUNT = '#87d7ff'
const ELAPSED = '#bcbcbc'

const SURFACES = ['terminal', 'desktop'] as const

const band = (bodyColumns: number, maxRows = 10) => ({
  plugin: 'barometer',
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows,
    bodyColumns,
    scroll: { offset: 0, bodyRows: maxRows },
    view: {},
  },
})

const fiveHour = (percentUsed: number, resetsInMs: number) => ({
  kind: 'five_hour',
  percentUsed,
  resetsAt: new Date(NOW + resetsInMs).toISOString(),
})

const sevenDay = (percentUsed: number, resetsInMs: number) => ({
  kind: 'seven_day',
  percentUsed,
  resetsAt: new Date(NOW + resetsInMs).toISOString(),
})

const TYPICAL: SessionUsage = {
  startedAt: NOW - HOUR,
  context: { tokens: 62_000, window: 200_000, percent: 31 },
  rateLimits: [fiveHour(48, 2 * HOUR + 7 * MINUTE), sevenDay(21, 4 * DAY + 3 * HOUR)],
}

const AUTH_STATUS = 'Login method: Claude Max account\nOrganization: Example\nEmail: someone@example.com\n'

function world(
  on: On,
  usage: SessionUsage | (() => SessionUsage),
  drawBelow?: (text: (children: string) => RenderElement) => RenderElement,
  authStatus = AUTH_STATUS,
) {
  const clock = mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: typeof usage === 'function' ? usage() : usage }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    if (!drawBelow) return { type: 'engine', ref: 0 }
    const { Text } = $.ui.resolve(e)
    return drawBelow(children => Text({ children: [children] }))
  })
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: authStatus,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  return clock
}

async function textColor($: Engine, surface: (typeof SURFACES)[number], shown: string) {
  const ui = await $.ui.mount({ ...band(120), surface })
  const found = await ui.find({ type: 'Text', text: shown })
  await ui.unmount()
  return found?.props.color
}

function barAfter(texts: readonly string[], label: string): string {
  const afterLabel = texts.slice(texts.indexOf(label) + 1)
  const barEnd = afterLabel.findIndex(text => !/^[━╾─╂╋]+$/.test(text))
  return afterLabel.slice(0, barEnd === -1 ? undefined : barEnd).join('')
}

async function step($: Engine, request: { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number; agentId?: string } = {}) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...request })
  for await (const _chunk of stream) {
    // drained so the plugin's hook sees the finished result
  }
}

function answerSteps(on: On) {
  on('turn.step', async function* (_$, e): AsyncGenerator<never, TurnStepResult> {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 9_000 },
    }
  })
}

function thinkingMode(on: On, isOn: boolean) {
  on('config.list', () => ({
    value: [{ key: 'thinking', label: 'Thinking mode', kind: 'boolean' as const, value: isOn, provider: { plugin: 'engine', tier: 'core' as const }, isLocked: false }],
  }))
}

describe('the gauges', () => {
  test('show context and both plan windows with the status line labels', async ($, on) => {
    world(on, TYPICAL)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '31%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /62k\/200k/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '48%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /resets in 2h07m/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Week' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '21%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /resets in 4d3h/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /at this pace/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('color context by the window-size thresholds', async ($, on) => {
    let usage: SessionUsage = TYPICAL
    world(on, () => usage)
    const expected = [
      [200_000, 40, GREEN],
      [200_000, 41, YELLOW_GREEN],
      [200_000, 75, ORANGE],
      [200_000, 81, RED],
      [1_000_000, 30, GREEN],
      [1_000_000, 45, YELLOW_GREEN],
      [1_000_000, 52, YELLOW],
      [1_000_000, 53, ORANGE],
      [1_000_000, 60, ORANGE],
      [1_000_000, 61, RED],
    ] as const
    for (const [window, percent, color] of expected) {
      usage = { ...TYPICAL, context: { tokens: (window * percent) / 100, window, percent } }
      expect(await textColor($, 'terminal', `${percent}%`), `${percent}% of ${window}`).toBe(color)
    }
  })

  test('draw the red line where context turns red', async ($, on) => {
    let usage: SessionUsage = TYPICAL
    world(on, () => usage)
    for (const [window, redLine] of [[1_000_000, 60], [200_000, 80]] as const) {
      usage = { ...TYPICAL, context: { tokens: window / 100, window, percent: 1 } }
      const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
      await ui.unmount()
      const cells = barAfter(texts, 'Context')
      expect(cells.length, 'bar drawn').toBeGreaterThan(0)
      expect(cells.search(/[╂╋]/), `red line on a ${window} window`).toBe(Math.floor((redLine / 100) * cells.length))
    }
  })

  test('draw the bars as thin lines', async ($, on) => {
    world(on, { ...TYPICAL, rateLimits: [fiveHour(60, 3 * HOUR), sevenDay(21, 4 * DAY + 3 * HOUR)] })
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    await ui.unmount()
    const context = barAfter(texts, 'Context')
    expect(context, '31% filled, red line at 80% in the empty part').toMatch(/^━+╾?─+╂─+$/)
    expect(context.indexOf('─')).toBe(Math.ceil(Math.round(0.31 * context.length * 2) / 2))
    expect(barAfter(texts, '5h'), '60% used with 40% of the window gone: the clock mark inside the fill').toMatch(/^━+╋━+╾?─+$/)
  })

  test('end a fill on a half cell when the reading falls between cells', async ($, on) => {
    let usage: SessionUsage = TYPICAL
    world(on, () => usage)
    let halfCells = 0
    for (const percent of [31, 32, 33, 34, 35, 47, 48]) {
      usage = { ...TYPICAL, context: { tokens: percent * 2_000, window: 200_000, percent } }
      const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
      await ui.unmount()
      const bar = barAfter(texts, 'Context')
      const halves = Math.round((percent / 100) * bar.length * 2)
      const fill = '━'.repeat(Math.floor(halves / 2)) + (halves % 2 === 1 ? '╾' : '')
      if (halves % 2 === 1) halfCells += 1
      expect(bar.slice(0, fill.length + 1), `${percent}% of a ${bar.length}-cell bar`).toBe(`${fill}─`)
    }
    expect(halfCells, 'some of these readings end mid-cell').toBeGreaterThan(0)
  })

  test('turn the clock mark orange once usage has passed it', async ($, on) => {
    let usage: SessionUsage = TYPICAL
    world(on, () => usage)
    for (const [used, color, what] of [
      [60, ORANGE, '60% used with 40% of the window gone'],
      [41, ORANGE, '41% used with 40% gone'],
      [39, ELAPSED, '39% used with 40% gone'],
      [20, ELAPSED, '20% used with 40% gone'],
    ] as const) {
      usage = { ...TYPICAL, rateLimits: [fiveHour(used, 3 * HOUR), sevenDay(21, 4 * DAY + 3 * HOUR)] }
      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...band(120), surface })
        const found = await ui.findAll({ type: 'Text' })
        await ui.unmount()
        const afterLabel = found.slice(found.findIndex(text => text.text === '5h') + 1)
        const mark = afterLabel.find(text => /^[╂╋]$/.test(text.text))
        expect(mark?.props.color, `${what} on ${surface}`).toBe(color)
      }
    }
  })

  test('keep the label, bar and percent whole when the text beside them is too long', async ($, on) => {
    const clock = world(on, { ...TYPICAL, rateLimits: [fiveHour(60, 3 * HOUR), sevenDay(25, 3 * DAY + 16 * HOUR)] })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      const boxes = await ui.findAll({ type: 'Box' })
      await ui.unmount()
      const bars = boxes.filter(box => /^[━╾─╂╋]+$/.test(box.text))
      const fixedColumns = boxes.filter(box => box.props.width === 8 || box.props.width === 5)
      const resetTimes = boxes.filter(box => /^resets in \S+$/.test(box.text) && box.props.flexGrow === undefined)
      expect(bars, `${surface}: one bar per row`).toHaveLength(3)
      expect(fixedColumns, `${surface}: a label and a percent column per row`).toHaveLength(6)
      expect(resetTimes, `${surface}: the reset time of each plan row, which the pace warning gives way to`).toHaveLength(2)
      for (const box of [...bars, ...fixedColumns, ...resetTimes]) {
        expect(box.props.flexShrink, `${surface}: "${box.text}" must not shrink`).toBe(0)
      }
    }
  })

  test('color plan windows red only from 95%', async ($, on) => {
    world(on, { ...TYPICAL, rateLimits: [fiveHour(94, HOUR), sevenDay(95, DAY)] })
    expect(await textColor($, 'terminal', '94%')).toBe(ORANGE)
    expect(await textColor($, 'terminal', '95%')).toBe(RED)
  })

  test('warn when a plan window runs out before it resets at the current pace', async ($, on) => {
    world(on, { ...TYPICAL, rateLimits: [fiveHour(60, 3 * HOUR), sevenDay(21, 4 * DAY + 3 * HOUR)] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      expect(await ui.find({ type: 'Text', text: /out in ~1h20m at this pace/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('show the status line hint before the first response', async ($, on) => {
    world(on, { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      expect(await ui.find({ type: 'Text', text: /Rate: populates after first API call/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '5h' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('fold into one status-line row when narrow', async ($, on) => {
    world(on, TYPICAL)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(50), surface })
      expect(await ui.find({ type: 'Text', text: 'Context: 31%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '5h: 48%' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('fold without | separators, which dangle at the end of a wrapped line', async ($, on) => {
    const clock = world(on, TYPICAL)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    for (const surface of SURFACES) {
      for (const [columns, maxRows] of [[50, 10], [120, 2]] as const) {
        const ui = await $.ui.mount({ ...band(columns, maxRows), surface })
        const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
        await ui.unmount()
        const where = `${columns} columns, ${maxRows} rows on ${surface}`
        expect(texts, where).toContain('Context: 31%')
        expect(texts.filter(text => text.includes('|')), where).toEqual([])
      }
    }
  })

  test('name the account and the model beside the gauges', async ($, on) => {
    const clock = world(on, TYPICAL)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      expect((await ui.find({ type: 'Text', text: 'someone@example.com' }))?.props.color).toBe(ACCOUNT)
      expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('name the plan next to the email', async ($, on) => {
    const clock = world(on, TYPICAL)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    for (const surface of SURFACES) {
      for (const columns of [120, 80]) {
        const ui = await $.ui.mount({ ...band(columns), surface })
        const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
        await ui.unmount()
        const where = `${columns} columns on ${surface}`
        expect(texts.filter(text => /Claude Max/.test(text)), `${where}: once`).toHaveLength(1)
        expect(texts[texts.indexOf('someone@example.com') + 1], `${where}: right after the email`).toBe(' · Claude Max')
      }
    }
  })

  test('leave the plan out when Claude Code does not say it', async ($, on) => {
    const clock = world(on, TYPICAL, undefined, 'Organization: Example\nEmail: someone@example.com\n')
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    await ui.unmount()
    expect(texts).toContain('someone@example.com')
    expect(texts.filter(text => text.startsWith(' · '))).toHaveLength(0)
  })

  test('refresh the figures every five seconds', async ($, on) => {
    let usage: SessionUsage = TYPICAL
    const clock = world(on, () => usage)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
    usage = { ...TYPICAL, context: { tokens: 64_000, window: 200_000, percent: 32 } }
    expect(await ui.find({ type: 'Text', text: '31%' }), 'drawn before the change').toBeDefined()
    await clock.advance(5_000)
    expect(await ui.find({ type: 'Text', text: '32%' }), 'redrawn five seconds after the change').toBeDefined()
    await ui.unmount()
  })

  test('draw no context chart, however many requests have run', async ($, on) => {
    world(on, TYPICAL)
    on('turn.step', async function* (_$, e): AsyncGenerator<never, TurnStepResult> {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [],
        stopReason: 'end_turn',
        usage: { model: e.model, input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 9_000 },
      }
    })
    await step($)
    await step($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      expect(await ui.findAll({ type: 'Text', text: /[▁▂▃▄▅▆▇]/ })).toHaveLength(0)
      await ui.unmount()
    }
  })
})

describe("each person's red line", () => {
  const OWN_RED_LINES = { options: { redLine1M: 50, redLine200k: 70 } }
  const filled = (window: number, percent: number): SessionUsage => ({
    ...TYPICAL,
    context: { tokens: (window * percent) / 100, window, percent },
  })

  test('draw the red mark where each person set it', OWN_RED_LINES, async ($, on) => {
    let usage: SessionUsage = TYPICAL
    world(on, () => usage)
    for (const [window, redLine] of [[1_000_000, 50], [200_000, 70]] as const) {
      usage = filled(window, 1)
      const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
      await ui.unmount()
      const cells = barAfter(texts, 'Context')
      expect(cells.search(/[╂╋]/), `red line on a ${window} window`).toBe(Math.floor((redLine / 100) * cells.length))
    }
  })

  test('scale the colours to the red line', OWN_RED_LINES, async ($, on) => {
    let usage: SessionUsage = TYPICAL
    world(on, () => usage)
    const expected = [
      [1_000_000, 25, GREEN],
      [1_000_000, 26, YELLOW_GREEN],
      [1_000_000, 43, YELLOW],
      [1_000_000, 50, ORANGE],
      [1_000_000, 51, RED],
      [200_000, 35, GREEN],
      [200_000, 36, YELLOW_GREEN],
      [200_000, 61, YELLOW],
      [200_000, 70, ORANGE],
      [200_000, 71, RED],
    ] as const
    for (const [window, percent, color] of expected) {
      usage = filled(window, percent)
      expect(await textColor($, 'terminal', `${percent}%`), `${percent}% of ${window}`).toBe(color)
    }
  })

  test('turn the red line off at 0: no mark, no Compact, one plain colour', { options: { redLine1M: 0, redLine200k: 80 } }, async ($, on) => {
    let usage: SessionUsage = TYPICAL
    world(on, () => usage)
    for (const surface of SURFACES) {
      for (const percent of [10, 59, 75, 99]) {
        usage = filled(1_000_000, percent)
        const where = `${percent}% of 1M on ${surface}`
        const ui = await $.ui.mount({ ...band(120), surface })
        const found = await ui.findAll({ type: 'Text' })
        const afterLabel = found.slice(found.findIndex(text => text.text === 'Context') + 1)
        const bar = afterLabel.slice(0, afterLabel.findIndex(text => !/^[━╾─╂╋]+$/.test(text.text)))
        expect(bar.map(text => text.text).join(''), `${where}: no red mark`).toMatch(/^━+╾?─*$/)
        expect(bar.filter(text => text.text.startsWith('━')).map(text => text.props.color), `${where}: plain fill`).toEqual([undefined])
        expect(found.find(text => text.text === `${percent}%`)?.props.color, `${where}: plain percent`).toBeUndefined()
        expect(await ui.find({ type: 'Button', key: 'compact' }), `${where}: no Compact`).toBeUndefined()
        await ui.unmount()
        const folded = await $.ui.mount({ ...band(50), surface })
        expect((await folded.find({ type: 'Text', text: `Context: ${percent}%` }))?.props.color, `${where}, folded: plain`).toBeUndefined()
        expect(await folded.find({ type: 'Button', key: 'compact' }), `${where}, folded: no Compact`).toBeUndefined()
        await folded.unmount()
      }
    }
    usage = filled(200_000, 80)
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
    expect(await ui.find({ type: 'Button', key: 'compact' }), 'the 200k red line still stands').toBeDefined()
    await ui.unmount()
  })

  test('show Compact whenever no reply is running, for someone who asked', { options: { alwaysShowCompact: true, redLine1M: 0 } }, async ($, on) => {
    let usage: SessionUsage = TYPICAL
    world(on, () => usage)
    for (const surface of SURFACES) {
      for (const columns of [120, 50]) {
        const readings: Array<[string, SessionUsage]> = [
          ['5% of 1M with its red line off', filled(1_000_000, 5)],
          ['5% of 200k', filled(200_000, 5)],
          ['before the first reading', { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] }],
        ]
        for (const [what, reading] of readings) {
          usage = reading
          const where = `${what}, ${columns} columns on ${surface}`
          const idle = await $.ui.mount({ ...band(columns), surface })
          expect(await idle.find({ type: 'Button', key: 'compact' }), `${where}: shown`).toBeDefined()
          await idle.unmount()
          const working = await $.ui.mount({ ...band(columns), surface, props: { ...band(columns).props, isWorking: true } })
          expect(await working.find({ type: 'Button', key: 'compact' }), `${where}: hidden mid-reply`).toBeUndefined()
          await working.unmount()
        }
      }
    }
  })

  test('offer Compact from the red line each person set', OWN_RED_LINES, async ($, on) => {
    let usage: SessionUsage = TYPICAL
    world(on, () => usage)
    for (const [window, percent, isShown] of [
      [1_000_000, 49, false],
      [1_000_000, 50, true],
      [200_000, 69, false],
      [200_000, 70, true],
    ] as const) {
      usage = filled(window, percent)
      const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
      expect((await ui.find({ type: 'Button', key: 'compact' })) !== undefined, `${percent}% of ${window}`).toBe(isShown)
      await ui.unmount()
    }
  })
})

describe('effort and thinking', () => {
  const reasoningAt = async ($: Engine, columns: number, surface: (typeof SURFACES)[number] = 'terminal') => {
    const ui = await $.ui.mount({ ...band(columns), surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    await ui.unmount()
    return { texts, line: texts.find(text => /effort|thinking/.test(text)) }
  }

  test('name the effort and thinking mode under the model', async ($, on) => {
    world(on, TYPICAL)
    answerSteps(on)
    thinkingMode(on, true)
    await step($, { effort: 'xhigh' })
    for (const surface of SURFACES) {
      for (const columns of [120, 80]) {
        const { texts, line } = await reasoningAt($, columns, surface)
        const where = `${columns} columns on ${surface}`
        expect(line, where).toBe('xhigh effort · thinking on')
        expect(texts.indexOf('Opus 5.5'), `${where}: after the model`).toBeLessThan(texts.indexOf('xhigh effort · thinking on'))
      }
    }
  })

  test('say when thinking mode is off', async ($, on) => {
    world(on, TYPICAL)
    answerSteps(on)
    thinkingMode(on, false)
    await step($, { effort: 'high' })
    expect((await reasoningAt($, 120)).line).toBe('high effort · thinking off')
  })

  test('show ? for the effort before the first request', async ($, on) => {
    world(on, TYPICAL)
    thinkingMode(on, true)
    expect((await reasoningAt($, 120)).line).toBe('? effort · thinking on')
  })

  test("follow the main conversation's requests, not a subagent's", async ($, on) => {
    world(on, TYPICAL)
    answerSteps(on)
    thinkingMode(on, true)
    await step($, { effort: 'xhigh' })
    await step($, { effort: 'low', agentId: 'a1' })
    expect((await reasoningAt($, 120)).line, 'a subagent at low effort').toBe('xhigh effort · thinking on')
    await step($, { effort: 'medium' })
    expect((await reasoningAt($, 120)).line, 'the next main request').toBe('medium effort · thinking on')
  })

  test('show ? after /effort or /model until the next request', async ($, on) => {
    world(on, TYPICAL)
    answerSteps(on)
    thinkingMode(on, true)
    on('command.run', () => ({}))
    for (const command of ['effort', 'model']) {
      await step($, { effort: 'xhigh' })
      await $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
      expect((await reasoningAt($, 120)).line, `after /${command}`).toBe('? effort · thinking on')
    }
    await step($, { effort: 'high' })
    expect((await reasoningAt($, 120)).line, 'the next request').toBe('high effort · thinking on')
  })

  test('leave the effort out for a model that takes none', async ($, on) => {
    world(on, TYPICAL)
    answerSteps(on)
    thinkingMode(on, true)
    await step($)
    expect((await reasoningAt($, 120)).line).toBe('thinking on')
  })
})

describe('readings Claude Code has not taken yet', () => {
  const SUMMARY = [{ role: 'user' as const, text: 'Summary of the conversation so far', toolUses: [] }]

  test('show ?/1M before the first reading', async ($, on) => {
    world(on, { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [fiveHour(17, 3 * HOUR)] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      expect(await ui.find({ type: 'Text', text: '?/1M' }), surface).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\b0\/1M/ }), surface).toBeUndefined()
      await ui.unmount()
    }
  })

  test('show the compacted size until the next reading', async ($, on) => {
    let usage: SessionUsage = { ...TYPICAL, context: { tokens: 625_000, window: 1_000_000, percent: 63 } }
    world(on, () => usage)
    on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 625_000, tokensAfter: 3_127 }))
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    usage = { ...TYPICAL, context: { window: 1_000_000 } }
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      expect(await ui.find({ type: 'Text', text: '3k/1M' }), `compacted size on ${surface}`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '0%' }), `compacted percent on ${surface}`).toBeDefined()
      await ui.unmount()
    }
    usage = { ...TYPICAL, context: { tokens: 41_000, window: 1_000_000, percent: 4 } }
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '41k/1M' }), 'the fresh reading wins').toBeDefined()
    await ui.unmount()
  })

  test('forget the compacted size once a fresh reading has arrived', async ($, on) => {
    let usage: SessionUsage = { ...TYPICAL, context: { tokens: 625_000, window: 1_000_000, percent: 63 } }
    world(on, () => usage)
    on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 625_000, tokensAfter: 3_127 }))
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    await $.session.measure({ context: { tokens: 41_000, window: 1_000_000, percent: 4 }, rateLimits: [], changed: ['context'] })
    usage = { ...TYPICAL, context: { window: 1_000_000 } }
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '?/1M' })).toBeDefined()
    await ui.unmount()
  })

  test('show the compacted size after the Compact button too', async ($, on) => {
    let usage: SessionUsage = { ...TYPICAL, context: { tokens: 700_000, window: 1_000_000, percent: 70 } }
    world(on, () => usage)
    on('session.compact', () => {
      usage = { ...TYPICAL, context: { window: 1_000_000 } }
      return { messages: SUMMARY, tokensBefore: 700_000, tokensAfter: 4_400 }
    })
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
    await ui.press({ key: 'compact' })
    expect(await ui.find({ type: 'Text', text: '4k/1M' })).toBeDefined()
    await ui.unmount()
  })

  test('draw a plan window as 0% once its reset time has passed, with the next reset one window later', async ($, on) => {
    world(on, { ...TYPICAL, rateLimits: [fiveHour(85, -10 * MINUTE), sevenDay(21, 4 * DAY + 3 * HOUR)] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
      expect(texts, surface).not.toContain('85%')
      expect(texts, surface).toContain('0%')
      expect(texts, surface).toContain('resets in 4h50m')
      const bar = barAfter(texts, '5h')
      expect(bar, `empty 5h bar on ${surface}`).toMatch(/^─*╂─+$/)
      expect(bar.indexOf('╂'), `clock mark 10 minutes into the fresh window on ${surface}`).toBe(Math.floor((10 / 300) * bar.length))
      await ui.unmount()
    }
  })

  test('keep a plan row at 0% when Claude Code drops its window at the reset', async ($, on) => {
    let usage: SessionUsage = { ...TYPICAL, rateLimits: [fiveHour(96, 10 * MINUTE), sevenDay(25, 3 * DAY)] }
    const clock = world(on, () => usage)
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await clock.advance(15 * MINUTE)
    usage = { ...TYPICAL, rateLimits: [sevenDay(25, 3 * DAY - 15 * MINUTE)] }
    await $.session.measure({ context: TYPICAL.context, rateLimits: usage.rateLimits, changed: ['rateLimits'] })
    for (const surface of SURFACES) {
      for (const columns of [120, 50]) {
        const ui = await $.ui.mount({ ...band(columns), surface })
        const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
        await ui.unmount()
        const where = `${columns} columns on ${surface}`
        if (columns === 120) {
          expect(texts, where).toContain('5h')
          expect(texts, where).toContain('0%')
          expect(texts, where).toContain('resets in 4h55m')
        } else {
          expect(texts, where).toContain('5h: 0%')
        }
      }
    }
  })

  test('leave a plan row out when Claude Code drops its window before the reset', async ($, on) => {
    let usage: SessionUsage = { ...TYPICAL, rateLimits: [fiveHour(40, 2 * HOUR), sevenDay(25, 3 * DAY)] }
    const clock = world(on, () => usage)
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
    usage = { ...TYPICAL, rateLimits: [sevenDay(25, 3 * DAY)] }
    await $.session.measure({ context: TYPICAL.context, rateLimits: usage.rateLimits, changed: ['rateLimits'] })
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    await ui.unmount()
    expect(texts).not.toContain('5h')
    expect(texts).toContain('Week')
  })
})

describe('the Compact button', () => {
  const filled = (window: number, percent: number): SessionUsage => ({
    ...TYPICAL,
    context: { tokens: (window * percent) / 100, window, percent },
  })

  test('appear once context reaches the red line, between turns', async ($, on) => {
    let usage: SessionUsage = TYPICAL
    world(on, () => usage)
    const expected = [
      [1_000_000, 59, false],
      [1_000_000, 60, true],
      [1_000_000, 75, true],
      [200_000, 79, false],
      [200_000, 80, true],
    ] as const
    for (const surface of SURFACES) {
      for (const [window, percent, isShown] of expected) {
        usage = filled(window, percent)
        for (const columns of [120, 50]) {
          const ui = await $.ui.mount({ ...band(columns), surface })
          const button = await ui.find({ type: 'Button', key: 'compact' })
          expect(button !== undefined, `${percent}% of ${window} at ${columns} columns on ${surface}`).toBe(isShown)
          await ui.unmount()
        }
      }
    }
  })

  test('stay hidden while a turn runs', async ($, on) => {
    world(on, filled(1_000_000, 70))
    for (const surface of SURFACES) {
      for (const columns of [120, 50]) {
        const ui = await $.ui.mount({ ...band(columns), surface, props: { ...band(columns).props, isWorking: true } })
        expect(await ui.find({ type: 'Button', key: 'compact' }), `${columns} columns on ${surface}`).toBeUndefined()
        await ui.unmount()
      }
    }
  })

  test('compact the conversation once when pressed', async ($, on) => {
    world(on, filled(1_000_000, 70))
    let compactions = 0
    on('session.compact', () => {
      compactions += 1
      return { messages: [{ role: 'user', text: 'Summary of the conversation so far', toolUses: [] }] }
    })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      await ui.press({ key: 'compact' })
      expect(await ui.find({ type: 'Button', key: 'compact' }), `offered again after compacting on ${surface}`).toBeDefined()
      await ui.unmount()
    }
    expect(compactions).toBe(2)
  })

  test('hide the button while a compaction runs', async ($, on) => {
    const clock = world(on, filled(1_000_000, 70))
    let finish = () => {}
    on('session.compact', async () => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return { messages: [{ role: 'user', text: 'Summary of the conversation so far', toolUses: [] }] }
    })
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
    const pressing = ui.press({ key: 'compact' })
    await clock.settle()
    expect(await ui.find({ type: 'Button', key: 'compact' }), 'hidden mid-compaction').toBeUndefined()
    finish()
    await pressing
    expect(await ui.find({ type: 'Button', key: 'compact' }), 'back once it finished').toBeDefined()
    await ui.unmount()
  })

  test('say why when compacting fails', async ($, on) => {
    world(on, filled(1_000_000, 70))
    const toasts: string[] = []
    on('session.compact', () => {
      throw new Error('a turn is running')
    })
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
    await ui.press({ key: 'compact' })
    expect(await ui.find({ type: 'Button', key: 'compact' }), 'offered again after the failure').toBeDefined()
    await ui.unmount()
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/^Compact failed: \S/)
  })
})

describe('spacing', () => {
  const topPadding = (root: RenderElement) => ('props' in root ? (root.props as { paddingTop?: number }).paddingTop ?? 0 : 0)

  test('leave a blank row above the band when it has room, after the frame', async ($, on) => {
    world(on, TYPICAL)
    for (const surface of SURFACES) {
      for (const [columns, maxRows, expected] of [
        [120, 10, 1],
        [50, 10, 1],
        [120, 7, 1],
        [120, 6, 0],
        [120, 5, 1],
        [120, 4, 0],
        [120, 2, 0],
      ] as const) {
        const ui = await $.ui.mount({ ...band(columns, maxRows), surface })
        expect(topPadding(await ui.drawn()), `${columns} columns, ${maxRows} rows on ${surface}`).toBe(expected)
        await ui.unmount()
      }
    }
  })
})

describe('the frame', () => {
  type Mounted = Pick<Awaited<ReturnType<Engine['ui']['mount']>>, 'findAll'>
  const frameOf = async (ui: Mounted) => (await ui.findAll({ type: 'Box' })).find(box => box.props.borderStyle !== undefined)

  test('draw a thin dim border around the gauges with room around it', async ($, on) => {
    world(on, TYPICAL)
    for (const surface of SURFACES) {
      for (const [columns, maxRows, shown] of [[120, 10, /Context/], [120, 6, /Context/], [50, 10, /Context: 31%/]] as const) {
        const ui = await $.ui.mount({ ...band(columns, maxRows), surface })
        const frame = await frameOf(ui)
        const where = `${columns} columns, ${maxRows} rows on ${surface}`
        expect(frame?.props, where).toMatchObject({ borderStyle: 'round', borderDimColor: true, paddingX: 1, marginLeft: 2 })
        expect(frame?.props.marginBottom, `${where}: Claude Code already leaves a blank row under the band`).toBeUndefined()
        expect(frame?.text, where).toMatch(shown)
        await ui.unmount()
      }
    }
  })

  test('leave the frame off when the band is short', async ($, on) => {
    world(on, TYPICAL)
    for (const surface of SURFACES) {
      for (const maxRows of [5, 4, 2]) {
        const ui = await $.ui.mount({ ...band(120, maxRows), surface })
        const where = `${maxRows} rows on ${surface}`
        expect(await frameOf(ui), where).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: /^Context/ }), where).toBeDefined()
        await ui.unmount()
      }
    }
  })

  test('keep what the mods after this one draw outside the frame', async ($, on) => {
    world(on, TYPICAL, text => text('note from below'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      const frame = await frameOf(ui)
      expect(frame, surface).toBeDefined()
      expect(frame?.text, surface).not.toMatch(/note from below/)
      expect(await ui.find({ type: 'Text', text: 'note from below' }), surface).toBeDefined()
      await ui.unmount()
    }
  })

  test("give the frame's columns from the bars", async ($, on) => {
    world(on, TYPICAL)
    const contextBar = async (maxRows: number) => {
      const ui = await $.ui.mount({ ...band(80, maxRows), surface: 'terminal' })
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
      await ui.unmount()
      return barAfter(texts, 'Context')
    }
    const unframed = await contextBar(5)
    const framed = await contextBar(10)
    expect(unframed.length, 'bar drawn').toBeGreaterThan(0)
    expect(framed.length).toBeLessThan(unframed.length)
  })
})

describe('sharing the band', () => {
  test('keep what the mods after this one draw there', async ($, on) => {
    world(on, TYPICAL, text => text('note from below'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(120), surface })
      expect(await ui.find({ type: 'Text', text: 'note from below' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('keep them when folded into one row', async ($, on) => {
    world(on, TYPICAL, text => text('note from below'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...band(50), surface })
      expect(await ui.find({ type: 'Text', text: 'note from below' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Context: 31%' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('yield the band to a survey', async ($, on) => {
    world(on, TYPICAL)
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal', props: { ...band(120).props, hasSurvey: true } })
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeUndefined()
    await ui.unmount()
  })
})
