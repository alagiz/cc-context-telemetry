# examples

Small, complete, runnable examples for cc-context-telemetry. Each requires the
lib via a relative path (`../index.js`) so it runs straight from this repo; an
npm-installed consumer would use `require('cc-context-telemetry')` instead.

These examples are NOT shipped to npm (the package `files` allowlist ships only
`index.js`, `bin/`, `README.md`, and `LICENSE`).

Note: `bin/telemetry.js` is the same on-demand reader as `print-telemetry.js` (it
also reads `readTelemetry`), exposed as a shipped CLI; the example is kept here as a
copy-pasteable standalone.

## pretooluse-warn.js

A complete PreToolUse hook. It reads the hook payload from stdin, extracts the
session id, reads the latest telemetry, and if the reading is fresh and the
context percentage is at or over a threshold (85 by default) it writes a one-line
warning to stderr (visible to the user). It never blocks: it always exits 0. The
file's top comment has the exact `settings.json` hooks block to wire it.

Run it by hand with a stub payload:

```sh
echo '{"session_id":"my-session"}' | node examples/pretooluse-warn.js
```

(The warning only appears when there is fresh telemetry for `my-session` at or
over the threshold; otherwise it prints nothing and exits 0.)

## print-telemetry.js

Prints the latest telemetry object for a session as pretty JSON, or
`no telemetry for <id>` when there is none. Handy for the manual live check.

```sh
node examples/print-telemetry.js <session-id>
# or from a hook-style stdin payload:
echo '{"session_id":"<id>"}' | node examples/print-telemetry.js
```

Point `CCT_DIR` at a directory with a seeded `telemetry-raw-<id>.json` (the raw
statusline payload) to try it without a live session.
