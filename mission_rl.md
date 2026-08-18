# Role & Goal

You are an expert game developer and reinforcement-learning engineer. Building on the
existing "Don't Touch The Spikes" clone in `index.html`, your task is to extend that same
single self-contained HTML file into a **combined physics laboratory and RL training
harness**: one UI in which a human can retune the game's physics live, and an agent can
learn to play the retuned game by tapping, improving its score as it trains.

Everything must remain in **one self-contained HTML file**, vanilla JavaScript (ES6+),
Canvas only. **No external libraries, no CDN links, no build step, no network calls.**
The machine learning must be implemented by hand — there is no TensorFlow.js here.

---

## Phase 0 — Correctness pass (do this first)

`REVIEW.md` in this repository documents ten defects in the current implementation.
Read it and fix all of them before building anything new. Tuning physics on top of a
gravity constant that is wrong by a factor of 60, or training an agent against hitboxes
that do not match the sprites, will produce meaningless results.

The two that block everything downstream:

- `GRAVITY` must be `1620`, not `27`. An acceleration given in `px/frame^2` converts to
  `px/s^2` by multiplying by `fps^2`, not by `fps`.
- Spike collision bounds must be derived from the same numbers `drawSpike` uses, so the
  hitbox and the sprite are the same shape.

Do not begin Phase 1 until the game is playable by a human and the jump arc is roughly
80 px tall.

---

## Phase 1 — Physics configuration panel

### 1.1 Parameter model

Replace every hard-coded physics constant with a single mutable config object, and make
every consumer read from it at use time so changes apply live without a reload:

```js
const PHYSICS_DEFAULTS = {
  gravity:      1620,   // px/s^2
  flapVelocity: -510,   // px/s, absolute reset (not additive)
  horizontalSpeed: 270, // px/s
  birdRadius:    16,    // px
  spikeWidth:    30,    // px, base of the triangle along the wall
  spikeHeight:   24,    // px, protrusion into the play area
  spikeCountMin:  2,
  spikeCountMax:  5,
  candyChance:  0.5,    // 0..1
};
```

### 1.2 Panel UI

Render the panel as **HTML DOM alongside the canvas** — not drawn into the canvas.
Use a flex row: canvas on the left, a fixed ~320 px control column on the right that
scrolls independently. Collapse to a single column below 900 px viewport width. The
canvas must keep its 540x960 internal resolution and its `object-fit: contain` scaling.

Each parameter gets a labelled `<input type="range">` plus a live numeric readout and a
matching `<input type="number">` for exact entry. Ranges:

| Parameter | Min | Max | Step |
|---|---|---|---|
| `gravity` | 200 | 5000 | 10 |
| `flapVelocity` | -1200 | -100 | 5 |
| `horizontalSpeed` | 60 | 900 | 5 |
| `birdRadius` | 6 | 40 | 1 |
| `spikeWidth` | 10 | 60 | 1 |
| `spikeHeight` | 8 | 60 | 1 |
| `spikeCountMin` | 0 | 9 | 1 |
| `spikeCountMax` | 0 | 9 | 1 |
| `candyChance` | 0 | 1 | 0.05 |

Clamp so `spikeCountMin <= spikeCountMax` whenever either moves.

### 1.3 Derived-values readout (important)

Directly beneath the gravity and flap sliders, display continuously-updated derived
quantities. These are what make a bad parameter pair visible *before* playing:

- **Jump height** = `flapVelocity^2 / (2 * gravity)` px
- **Time to apex** = `|flapVelocity| / gravity` s
- **Horizontal travel per jump** = `horizontalSpeed * 2 * timeToApex` px
- **Wall-to-wall crossing time** = `(540 - 2*12) / horizontalSpeed` s
- **Jumps per crossing** = crossing time / (2 * time to apex)

Colour the jump-height readout amber when it exceeds 300 px and red when it exceeds
960 px (the bird can reach the ceiling from the floor in one tap — the exact failure the
original build shipped with).

### 1.4 Presets and persistence

Provide preset buttons: **Spec Default**, **Floaty** (gravity 800, flap -380),
**Twitchy** (gravity 3000, flap -700), and **Broken (original)** (gravity 27) kept
deliberately as a demonstration of the bug. Persist the live config to `localStorage`
under `dtts_physics` and restore on load. Include a **Reset to Spec Default** button.

---

## Phase 2 — Reinforcement learning agent

### 2.1 Algorithm

Implement **tabular Q-learning** with a discretised state space. Do not attempt a neural
network for the baseline: the state space here is small enough that a table converges in
a few thousand episodes and, unlike a hand-rolled net, is debuggable when it fails.

Update rule, applied on every decision step:

```
Q[s][a] <- Q[s][a] + alpha * ( r + gamma * max_a' Q[s'][a'] - Q[s][a] )
```

Defaults: `alpha = 0.15`, `gamma = 0.98`, `epsilon` annealed `1.0 -> 0.02` over the first
1500 episodes (exponential decay), then held. Every one of these must be exposed as a
slider in the training panel.

### 2.2 State discretisation

The agent observes five features, bucketed into a single integer key. Use exactly this
encoding — it is the smallest representation that is sufficient, and the bucketing is
deliberately finer near zero where precision matters:

1. **`dxBucket`** — horizontal distance from the bird to the wall it is travelling toward,
   in 12 uniform buckets across `0..540`.
2. **`dyBucket`** — signed vertical offset from the bird to the centre of the *nearest
   safe slot* on that target wall, clamped to `+/-480`, in 17 non-uniform buckets with
   boundaries at `+/-{8, 24, 48, 80, 128, 192, 288, 480}`.
3. **`vyBucket`** — bird vertical velocity, clamped to `+/-900`, in 9 non-uniform buckets
   with boundaries at `+/-{60, 180, 360, 600}`.
4. **`dySpikeBucket`** — signed vertical offset to the nearest *spike* on the target wall,
   same boundaries as `dyBucket` but collapsed to 9 buckets.
5. **`dirBit`** — 0 if travelling left, 1 if travelling right.

Total table size is `12 * 17 * 9 * 9 * 2 = 33,048` states x 2 actions. Store as a flat
`Float32Array` indexed by a mixed-radix key, not nested objects — it must be cheap to
serialise and fast to index.

Actions: `0 = do nothing`, `1 = flap`. Decide once per simulation step.

### 2.3 Reward function

| Event | Reward |
|---|---|
| Survived one step | `+0.1` |
| Bounced off a wall (scored) | `+10` |
| Collected candy | `+5` |
| Died on any spike | `-100` |

Terminal transitions must bootstrap from zero, not from `max Q(s')`.

### 2.4 Simulation determinism

Training must not depend on display refresh rate. Refactor the update loop so the
simulation advances by a **fixed `dt` of `1/60`** during training, decoupled from
`requestAnimationFrame`. Rendering stays `rAF`-driven. The human-play path may keep
variable `dt`, but the physics integrator must be a single shared function so the agent
learns the same physics a human plays.

### 2.5 Turbo training mode

A `Turbo` toggle plus a **steps-per-frame** slider (1 to 20,000, log scale). When Turbo is
on, run that many simulation steps per animation frame with **rendering disabled**, and
draw only the metrics panel. Without this, training is bounded by 60 steps/second and will
take hours; with it, expect several thousand episodes per minute. Yield to the browser
every frame — never block the main thread in a `while` loop that spans frames.

---

## Phase 3 — Modes, metrics, and persistence

### 3.1 Three modes

A segmented control switches between:

1. **HUMAN** — current behaviour, keyboard and touch input.
2. **AI_TRAIN** — the agent plays with epsilon-greedy exploration and learns. Episodes
   auto-restart instantly on death with no game-over animation.
3. **AI_PLAY** — the agent plays greedily (`epsilon = 0`), learning disabled, rendered at
   normal speed with all juice intact so a human can watch it perform.

In both AI modes, visualise the agent's decision: flash a small ring around the bird on
the frame it chooses to flap, and draw a marker on the safe slot it is currently
targeting.

### 3.2 Metrics panel

Display live: episode count, total steps, current epsilon, current episode score, best
score ever, **rolling mean score over the last 50 episodes**, and states visited (count
of table entries touched at least once).

Draw a **sparkline of score over episodes** on a small secondary canvas, showing the raw
per-episode score faintly and the 50-episode moving average as a solid line. This is the
single most useful artefact for judging whether learning is actually happening.

### 3.3 Policy persistence

- Autosave the Q-table to `localStorage` (key `dtts_qtable`) every 100 episodes, together
  with the physics config it was trained under and the episode count.
- **Export Policy** downloads a JSON file; **Import Policy** loads one back.
- **Reset Policy** clears the table after a confirmation.

### 3.4 Invalidate the policy when physics change

This is the point of combining the two panels. Store a hash of the physics config
alongside the Q-table. When the live config no longer matches the config the table was
trained under, show a persistent amber banner in the training panel:

> Policy was trained under different physics — expect degraded play. Retrain or reset.

Do **not** auto-clear the table. Watching a policy trained under one gravity fail under
another, and then recover as it retrains, is the most instructive thing this tool can
show — that is the demonstration, not a side effect to be hidden.

---

## Acceptance criteria

The task is complete when all of the following hold:

1. A human can still play the game exactly as before, with a correct 80 px jump arc.
2. Moving the gravity slider changes the bird's arc immediately, mid-flight, without a
   reload, and the derived jump-height readout agrees with observed behaviour.
3. Starting from a cleared table under spec-default physics, AI_TRAIN reaches a
   **50-episode moving average above 15 points within 5,000 episodes**, and the sparkline
   shows a visibly rising trend rather than a flat line.
4. AI_PLAY with the trained policy visibly threads spike gaps rather than flapping
   randomly.
5. Turbo mode at 5,000 steps/frame keeps the page responsive — sliders still drag.
6. Exporting a policy, reloading the page, and importing it restores the same play
   quality.
7. The file remains a single self-contained `.html` with no external requests.

## Notes on approach

Build and verify in the phase order given; do not write the whole file and then test.
After Phase 0, play it. After Phase 1, sweep gravity from 200 to 5000 and confirm nothing
breaks at the extremes. After Phase 2, run 500 episodes and confirm the mean score is
rising before tuning anything.

If the agent plateaus near zero, the fault is almost always the state encoding rather than
the hyperparameters — verify first that `dyBucket` is signed and that the "nearest safe
slot" is computed against the wall the bird is actually flying toward.
