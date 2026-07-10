### tldr:

statusline before:
```
~/code/myapp  main
```

statusline after:
```
ctx 48% | 5h 14% ~1h20m | 7d 21% ~5d10h | opus-4.8   ~/code/myapp  main
```

showing: context used %, 5h/7d usage each with a reset countdown, and the current model.

[https://npmjs.com/package/cc-context-telemetry](https://npmjs.com/package/cc-context-telemetry)

### setup:

1. install 
    ```
    npm i -g cc-context-telemetry
    ```
2. set it as your statusLine in ~/.claude/settings.json:
    ```json
    {
        "statusLine": {
            "type": "command",
            "command": "cc-context-telemetry-statusline"
        }
    }
    ```
3. start a new Claude Code session   

### details: 

Claude Code hooks and plugins can't see context fullness or rate-limit usage - the only place Claude Code exposes context % and the 5h/7d rate_limits is the statusLine input. this wraps your statusline to show them:
```
ctx 48% | 5h 14% ~1h20m | 7d 21% ~5d10h | opus-4.8   ~/code/myapp  main
```
context %, 5h/7d usage each with a reset countdown, and the current model - all toggleable and reorderable via `CCT_SEGMENTS`. the 5h/7d numbers are account-wide, so it shows the freshest reading across your open sessions instead of each one showing a different stale number.

it also writes the telemetry to a per-session file so your hooks can finally read it:
```
const t = require('cc-context-telemetry').readTelemetry(sessionId);
if (t?.fresh && t.contextPct >= 85) { /* near the wall: checkpoint / pause */ }
```

to keep your existing bar instead of replacing it, add `"env": { "CCT_WRAP": "<your bar command>" }` next to `command` in the config above. pure shell on the render path, execs-through so it can't pile up. Free, MIT, zero deps, cross-platform (Linux, macOS, Windows via Git Bash).

every number is only as fresh as your most-recently-active session's last API call.

feedback is welcome.

npm: [https://npmjs.com/package/cc-context-telemetry](https://npmjs.com/package/cc-context-telemetry)

GitHub: [https://github.com/alagiz/cc-context-telemetry](https://github.com/alagiz/cc-context-telemetry)
