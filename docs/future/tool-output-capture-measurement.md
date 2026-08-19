# Measuring tool-output capture

A/B protocol for `docs/future/tool-output-capture.md` §7. Mirrors the
methodology of the earlier FALDA-vs-compaction evaluation: plant facts that
only exist in a place neither mechanism is known to preserve, then check
whether a later session can recall them.

The question this settles: does `FALDA_CAPTURE_TOOLS=1` make previously-lost
facts recallable, or does it just multiply row count and hand the
distillation LLM noise it turns into low-value atoms? Both are real
possibilities — see the failure mode named in "Reading the result" below —
which is why the flag ships opt-in rather than as a new default.

## Arms

| Arm | Configuration |
|---|---|
| control | `FALDA_CAPTURE=1`, `FALDA_CAPTURE_TOOLS` unset |
| treatment | `FALDA_CAPTURE=1`, `FALDA_CAPTURE_TOOLS=1` |

Everything else is pinned identically across arms: same agent model, same
distillation LLM (`FALDA_LLM_*`), same `FALDA_DISTILL_WINDOW_MAX_CHARS`,
same `FALDA_CAPTURE_TOOL_MAX_CHARS` and `FALDA_EMBED_MAX_CHARS` (moot for
control's own rows, but pin them anyway so a mid-run flag flip can't
silently change the comparison), same store starting empty.

The harness's own context-compaction trigger needs no separate pinning:
both arms run the identical scripted session (§ Protocol), so they reach
the same conversation length and cross the same compaction boundary at the
same point regardless of the flag. `FALDA_CAPTURE_TOOLS` changes what
FALDA's hook writes to T0, not what the model sees in-context.

**Isolation.** Run both arms under one `FALDA_ROOT`, as two distinct
tenants (e.g. `FALDA_TENANT=capture-control` / `capture-treatment`), each a
fresh self store with no prior history. Every read-only command below
accepts `--tenant=` to scope its report to one arm, which is what makes
side-by-side comparison convenient without juggling two `FALDA_ROOT` trees.

## Fact design

Plant facts that are reachable **only** through a tool result and never
restated in prose — the class the earlier evaluation showed both mechanisms
lose. Each fact is a distinctive token that cannot be guessed:

- a value inside a file read with `Read` and never quoted back
- a column type printed by a `Bash` command
- a version string from `--version` output
- an error string from a deliberately failing command

Do not mention any planted value in a user or assistant message. If it
appears in prose, the control arm can also recall it and the trial is void.

## Protocol

1. Start both arms against fresh, separate tenant stores (see Isolation
   above).
2. Run an identical scripted session against each arm that surfaces every
   planted fact through a tool call. The script must be byte-identical
   between arms — same commands, same files, same order — so the only
   variable is the flag.
3. Continue until at least one compaction boundary has passed.
4. Wait for distillation to finish before probing — recall reads distilled
   tiers, not raw T0. Do not assume a pass has finished because the session
   ended; confirm it:
   - `falda stats --tenant=<arm> --section=queue --json` — wait until
     `by_status.pending` and `by_status.running` are both `0` for the
     store's jobs.
   - `falda distill inspect --tenant=<arm> --status=running --json` —
     confirm it returns no passes.
5. Probe from a **new session**: in-context compression cannot carry
   information across a session boundary, so a same-session probe would
   mask the effect being measured. If a probe comes back negative,
   `falda show recall --tenant=<arm> --last --json` shows what the most
   recent recall actually retrieved — useful for distinguishing "the fact
   was never stored" from "it was retrieved but the atom was too weak to
   surface."

## Metrics

**Primary.** Cross-session recall rate on planted tool-only facts: planted
facts successfully recalled, divided by planted facts, per arm.

**Secondary.**

| Metric | How to obtain |
|---|---|
| rows written per session | `falda stats --tenant=<arm> --section=stores --json` reports a cumulative `stream_total` / `stream_head_seq`, not a per-session count. Read it once before the scripted session and once after; the delta is the count. |
| distillation pass wall time | `falda distill inspect --tenant=<arm> --json` — each pass in `passes[]` carries `started_at` and `completed_at`; the difference is the wall time. Not printed as a precomputed duration, so compute it from the two timestamps. |
| extraction candidates per pass | `falda distill inspect --tenant=<arm> --json` — `passes[].candidate_count` (also shown as `Candidates: N` in the default human-readable output). |
| atoms stored per pass | `falda distill inspect --tenant=<arm> --json` — `passes[].decision_counts`, broken out by `store`/`update`/`merge`/`skip`. "Stored" for this metric means `store + update + merge` (all three persist an atom); `skip` is the count that did not. |

All four secondary metrics come from `falda stats` and `falda distill
inspect`, both read-only and offline — no server needs to be running to
collect them, only to have run at some point during the session.

## Reading the result

A rise in candidates per pass with no rise in recall is the signal that tool
rows produce noise atoms rather than facts — the failure mode the README's
original rationale predicted, and the question this experiment exists to
settle. Report it as such rather than reporting only the primary metric.

Invalid runs (crashed session, distillation incomplete at probe time, a
planted value that leaked into prose) get an explicit footnote. They are
never quietly averaged into the results.
