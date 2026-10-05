# claude-mods

- Claude Code mods by Rohan Bansal, installable as a plugin marketplace.

## barometer

- Context and plan-limit gauges in a framed band above the prompt.

```
  ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
  │ Context ━───────────╂───────   4%  45k/1M                                    you@example.com · Claude Max │
  │ 5h      ━╂──────────────────   3%  resets in 4h43m                                               Opus 5.5 │
  │ Week    ━━━━━────╂──────────  26%  resets in 3d15h                             xhigh effort · thinking on │
  ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

### What it shows

- **Context**: how full the context window is, as a bar that goes from green to red, with a red line where it is time to compact.
  - The figure beside it is tokens used of the window, such as `45k/1M`, or `?/1M` before Claude Code has taken a reading.
  - Right after a compaction it shows the compacted size until the next reading.
- **5h** and **Week**: how much of each plan window you have used, for Claude subscriptions.
  - The grey notch marks how far through the window you are; a fill past the notch means you are using it faster than it refills.
  - "resets in" counts down to the reset, and an orange "out in ~X at this pace" appears when you are on track to run out first.
  - Once a window resets, its row drops to 0% straight away rather than waiting for your next message.
- **On the right**: the signed-in account and plan, the model, and the effort level and thinking mode.
  - Effort reads `?` until the first request of the session, and again after `/effort` or `/model` until the next one.
- **Compact button**: appears beside the context figure once context reaches the red line, between replies, and compacts the conversation when pressed.
- **Narrow terminals**: below about 70 columns the gauges fold into one line of text.
- **Hiding it**: the `[-]` at the top right, or ctrl+x ctrl+a, collapses the band for the session.

### Install

- Requires a Claude Code version with mods; tested on 2.1.289 in the terminal.
- Add the marketplace and install the plugin:
  ```
  claude plugin marketplace add Alchez/claude-mods
  claude plugin install barometer@alchez
  ```
- Start a new session, or run `/reload-plugins` in an open one.
- If you already show the same figures in a status line, you may want to remove the `statusLine` entry from your settings.

### Settings

- Each person sets these for themselves in `/config`, or with `/config barometer.<key>=<value>`.

| Key | Default | What it does |
|---|---|---|
| `redLine1M` | 60 | Context % where the bar turns red and the Compact button appears, for 1M-token windows; 0 turns it off |
| `redLine200k` | 80 | The same for every window under 1M (today, 200k); 0 turns it off |
| `alwaysShowCompact` | false | Show the Compact button whenever no reply is running, not only past the red line |

- The colours scale with the red line: green, yellow-green, yellow and orange end at half, three quarters and seven eighths of it, then red.
- With a red line turned off, that window's bar and percent stay in your terminal's plain text colour.

### Update

- Fetch the new version, then run `/reload-plugins` or start a new session:
  ```
  claude plugin marketplace update alchez
  claude plugin update barometer@alchez
  ```

### Uninstall

- Remove it with:
  ```
  claude plugin uninstall barometer@alchez
  ```

## Development

- `claude plugin test barometer` runs the tests.
- `claude plugin validate barometer` checks the manifest and the hooks module.
- To try local changes, add this folder as a marketplace with `claude plugin marketplace add <path to this folder>`; Claude Code then reads the plugin from the folder, and `/reload-plugins` picks up edits.

## License

- MIT, see [LICENSE](LICENSE).
