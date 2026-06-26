# Integrating when another plugin owns your statusLine

cc-context-telemetry is non-invasive and host-agnostic: it never edits your
`settings.json`, never seizes the statusLine, and knows nothing about any specific
statusline tool. You wire it yourself (README Quick start), and that is its whole
footprint. It works with ANY statusline via `CCT_WRAP`.

Some statusline plugins, however, take over the statusLine themselves: on each session
they rewrite `settings.json` `statusLine` to their own command. If you wire
cc-context-telemetry directly as the `statusLine`, such a host overwrites it on the next
session. The general fix is NOT to fight over `settings.json`, but to let the host wrap
cc-context-telemetry through the host's own "wrap a previous statusline" mechanism (most
such plugins have one). The pattern below is generic; it applies to any host of that
kind.

## General pattern: be the statusline the host wraps

Set your `statusLine` to the cct command in standalone mode (no `CCT_WRAP`):

```json
{ "statusLine": { "type": "command", "command": "cc-context-telemetry-statusline" } }
```

A host that captures the previous statusLine on takeover will then render cct as part
of its own bar, automatically, with no host-specific configuration from you. If the host
exposes its wrapped command as a file or config value instead, point that at the same
cct command. Either way you only ever set your own statusLine or the host's own
documented setting - you never patch the host's internals, and nothing here is specific
to one tool.

## Worked example (one host: adtention)

`adtention` takes over the statusLine in its SessionStart `setup` and wraps the previous
command it finds, stored at `~/.claude/adtention/wrapped_cmd`. So either set your
statusLine to `cc-context-telemetry-statusline` (adtention captures it on the next
session), or point adtention's wrapped-command file at cct directly:

```sh
echo 'cc-context-telemetry-statusline' > ~/.claude/adtention/wrapped_cmd
```

adtention runs it each render with the statusLine JSON on stdin and shows its output as
the prefix, ahead of its own segment, persisting across sessions while adtention stays
the registered statusLine. (Substitute the equivalent mechanism for whatever host you
use; the steps are the same shape.)

## Note on duplicated readouts

If your host already shows a context/usage readout, cct's `ctx %` may duplicate it. In
that case cct's distinct value is the separate 5h and 7d rate-limit windows; decide
whether you want the full `ctx % | 5h % | 7d %` segment, or to rely on the host for
context and use cct only for the telemetry file your hooks read.
