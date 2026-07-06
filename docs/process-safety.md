# Process safety: why the wrapper is safe to run every render

The README has the short version. This is the complete reasoning behind cct's per-render
design, kept for reviewers and the curious.

Claude Code runs the statusLine command on every render, in every open session, and keeps
it bounded by killing that per-render process. So a wrapper around your existing statusline
must let Claude Code manage your statusline's lifecycle exactly as it would directly - or
the wrapped command piles up.

This entry `exec`s your `CCT_WRAP` command: the entry process **becomes** your statusline,
so the process Claude Code spawns and later kills IS your statusline. It is torn down each
render just like running it directly - no extra long-lived process, no pile-up.

It does NOT spawn your statusline as a child and babysit it. Spawning a child (detached or
not) from a per-render process is unsafe: when Claude Code kills the wrapper, the spawned
statusline can survive, and a heavy statusline (one that itself shells out) then leaks an
instance every render until the machine is overloaded. `exec`, not spawn, is what makes
wrapping safe. (Versions before 0.2.0 spawned; do not use them.)

A corollary: do NOT make YOUR wrapped statusline background a helper (a trailing `&` or a
detached child that outlives the front process). Such a statusline leaks that helper on
every render-kill - but it leaks IDENTICALLY whether you run it directly or through this
wrapper. Because `exec` makes your command BECOME the process Claude Code kills, the process
tree is the same as running it directly, so the wrapper introduces no extra orphan; the leak
is the forking statusline's own foot-gun. `test/loadrepro` proves this with a forking callee
run both ways and asserts the orphan counts are EQUAL.

There is also NO Node process on the per-render path. An earlier design ran a small `node`
telemetry writer every render. When Claude Code killed the statusline's front process while
that node child was still running, the node child reparented to init and SURVIVED - one
orphan per render, times many concurrent sessions, times a high render rate, which piled up.
The rewrite moved all JSON parsing off the hot path (the shell entry only writes the raw
payload; `index.js` parses on demand), so the per-render path is pure shell and spawns
nothing that can outlive the render. `test/loadrepro` is a synthetic, self-cleaning harness
that reproduces the old node-per-render orphan pile-up and asserts the current exec-through
wrapper leaves nothing behind.

The entry reads stdin with a plain `cat` and NO timeout, relying on Claude Code closing the
statusLine's stdin after a single bounded write (the same contract a direct statusLine
command sees). This is not an assumption: the `adtention` statusLine binary reads its stdin
with `io.ReadAll(os.Stdin)` (which blocks until EOF) and runs flat as a DIRECT statusLine
with no pile-up, so if Claude Code did not close the statusLine stdin a direct `adtention`
would hang every render - it does not, so Claude Code closes it, and our `cat` (reading the
identical stdin) gets the identical EOF. We deliberately avoid a per-render timeout
subprocess because that would reintroduce the per-render spawn this rewrite removed. If a
future Claude Code build ever held statusLine stdin open, the `cat` would block - so confirm
the EOF behavior on your Claude Code version with a cheap session (see "Verify it works" in
the README) before trusting it in long autonomous runs.
