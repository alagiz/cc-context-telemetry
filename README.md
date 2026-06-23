# cc-context-telemetry

Claude Code hooks and plugins cannot see context fullness or rate limits. The ONLY
place Claude Code exposes the authoritative `context_window` (used percentage,
window size) and Pro/Max `rate_limits` is the `statusLine` command. This tiny,
zero-dependency library bridges that gap: it is a statusLine wrapper that captures
Claude Code's authoritative telemetry, writes it to a per-session file your hooks
can read, and passes through to your existing statusline so you keep your bar.

One job, two pieces:

- `bin/statusline.js` - the wrapper Claude Code calls as its statusLine. Writes
  `telemetry-<session>.json`, then runs your original statusline (env `CCT_WRAP`)
  and forwards its output verbatim. If no wrapper is set (or it fails), it prints
  a minimal standalone bar so the segment is never blank.
- `index.js` - `readTelemetry(sessionId)` for your hooks to read the latest
  reading, with a freshness check.

Zero third-party dependencies. Node >= 18. CommonJS. Never throws, never blanks
the bar, never calls `claude`.

## Wiring

Add this to `~/.claude/settings.json` (use an absolute path to the installed bin,
or the `cc-context-telemetry-statusline` command if installed globally):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/cc-context-telemetry/bin/statusline.js"
  }
}
```

To keep your existing bar, point `CCT_WRAP` at your original statusline command.
The wrapper runs it with the same stdin and forwards its output verbatim:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/cc-context-telemetry/bin/statusline.js",
    "env": {
      "CCT_WRAP": "node /absolute/path/to/your/original-statusline.js"
    }
  }
}
```

(If your Claude Code version does not support an `env` block on `statusLine`,
export `CCT_WRAP` in your shell profile instead.)

## Consumer API (hooks)

In any hook (PreToolUse, PreCompact, etc.), read the latest reading:

```js
const { readTelemetry } = require('cc-context-telemetry');
const d = require('fs').readFileSync(0, 'utf8'); // hook stdin
const sessionId = JSON.parse(d).session_id;
const t = readTelemetry(sessionId);
if (t && t.fresh && t.contextPct >= 85) { /* near the wall: act */ }
```

`readTelemetry(sessionId, opts)` returns `null` when absent, otherwise:

```js
{
  sessionId,      // string
  contextPct,     // number or null (context window used %)
  usedPercentage, // number or null (alias of contextPct)
  windowSize,     // number or null (context_window_size)
  fiveHourPct,    // number, OMITTED when Claude Code did not report it
  sevenDayPct,    // number, OMITTED when Claude Code did not report it
  model,          // string or null (model id)
  ts,             // ISO timestamp string or null
  source,         // "statusline"
  fresh           // true when contextPct is a finite number AND ts is within the TTL
}
```

`fresh` rejects both stale and far-future timestamps (it checks the absolute age
against the TTL). When `fresh` is false, treat it as "no signal" and stay
observe-only. `opts.ttlSec` (or env `CCT_TTL_SEC`) overrides the default 120s TTL.
An override is honored only when it is a finite number greater than 0; a blank,
zero, negative, or non-numeric value falls back to the default.

The module also exports `DEFAULT_TTL_SEC` (the 120s default, a number),
`writeTelemetry(sessionId, obj)`, `telemetryDir()`, `telemetryPath(sessionId)`,
and `nowIso()`. `telemetryPath` sanitizes the session id (everything outside
`[A-Za-z0-9_-]` becomes `_`), so a reading is always confined to the telemetry
directory.

## Telemetry file

One file per session at `<dir>/telemetry-<session>.json`:

```json
{
  "session_id": "abc123",
  "context_pct": 47.2,
  "used_percentage": 47.2,
  "context_window_size": 200000,
  "model": "claude-opus-4-1",
  "ts": "2026-06-22T12:00:00.000Z",
  "source": "statusline",
  "five_hour_pct": 12,
  "seven_day_pct": 30
}
```

`five_hour_pct` / `seven_day_pct` are present only when Claude Code reported them
(Pro/Max OAuth). They are omitted (never written as 0) for API-key / Bedrock /
Vertex. `context_pct` is `null` before the first API response and right after a
compaction.

## Environment variables

- `CCT_WRAP` - your original statusline command. The wrapper runs it with the same
  stdin and forwards its output verbatim. When unset, the wrapper prints its own
  minimal bar (`ctx 47% | 5h 12% | 7d 30%`).
- `CCT_WRAP_TIMEOUT_MS` - SIGKILL-bounded timeout for the wrapped command (default
  5000). If it hangs, it is killed and the bar still prints.
- `CCT_DIR` - telemetry directory (default `~/.claude/cc-context-telemetry/`).
- `CCT_TTL_SEC` - freshness window for `readTelemetry` in seconds (default 120).

## License

MIT
