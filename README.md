# claude-mods

- Claude Code mods, installable as a plugin marketplace.

## barometer

- Context and plan-limit gauges above the prompt.

```
╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Context ━━━━━━━━━━━━╋───────  63%  630k/1M [ Compact ]                       you@example.com · Claude Max │
│ 5h      ━━━━━━━━─╂──────────  38%  resets in 2h35m                                               Opus 5.5 │
│ Week    ━━━━━────╂──────────  27%  resets in 3d14h                             xhigh effort · thinking on │
╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

- **Context** fills green to red; past the red line, a Compact button appears between replies.
- **5h** and **Week** show plan usage; the grey notch is how far through the window you are.

### Install

```
claude plugin marketplace add Alchez/claude-mods
claude plugin install barometer@alchez
```

- Then start a new session, or run `/reload-plugins`.
- Needs a Claude Code version with mods (tested on 2.1.289).

### Settings

- Set these in `/config`.

| Key | Default | What it does |
|---|---|---|
| `redLine1M` | 60 | Red line, as a context %, for 1M-token windows; 0 turns it off |
| `redLine200k` | 80 | Red line for smaller windows; 0 turns it off |
| `alwaysShowCompact` | false | Show the Compact button at any time, not only past the red line |

### Update or remove

```
claude plugin marketplace update alchez && claude plugin update barometer@alchez
claude plugin uninstall barometer@alchez
```

## License

- MIT, see [LICENSE](LICENSE).
