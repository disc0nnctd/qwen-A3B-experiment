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
80 px tall — that is the spec-literal value and confirms the conversion is right. Phase 1
then retunes it deliberately to 58 px for feel; see 1.1b.

---

## Phase 1 — Physics configuration panel

### 1.1 Parameter model

Replace every hard-coded physics constant with a single mutable config object, and make
every consumer read from it at use time so changes apply live without a reload:

```js
const PHYSICS_DEFAULTS = {
  gravity:      4200,   // px/s^2   \
  flapVelocity: -700,   // px/s      | tuned set — derived in 1.1b, not the
  maxFallSpeed:  850,   // px/s      | literal spec values. Ship these.
  horizontalSpeed: 290, // px/s     /
  jumpStyle: 'instant', // 'instant' | 'impulse' — see 1.3
  impulseFrames:   9,   // only used when jumpStyle === 'impulse'
  birdRadius:    16,    // px
  spikeWidth:    30,    // px, base of the triangle along the wall
  spikeHeight:   24,    // px, protrusion into the play area
  spikeAngle:     0,    // degrees, apex tilt along the wall — see 1.4
  spikeCountMin:  2,
  spikeCountMax:  5,
  candyChance:  0.5,    // 0..1
};
```

### 1.1b Where the tuned defaults come from

Do not ship the literal spec constants. `gravity 1620 / flap -510 / vx 270` is the correct
*conversion* of the original brief, but it produces a game that plays slack: 2.85 taps per
wall crossing, which is mostly waiting. The values above are derived from the playfield
geometry instead, and every one is reproducible from these four constraints:

**Geometry.** The canvas is 540x960. With a 12 px wall border and a 16 px bird radius, the
bird's centre travels `540 - 2(12) - 2(16) = 484 px` per crossing. The 11 spike slots are
`960 / 11 = 87.3 px` tall.

**1. Crossing time — 1.6 to 2.0 s.** Long enough to read the next wall's spike layout,
short enough to stay urgent. `484 / 290 = 1.67 s`.

**2. Taps per crossing — 5.** This genre lives at 4–6; below 3 the player is idling
between inputs. `1.67 s / 5 = 0.334 s` per full jump cycle.

**3. Jump height — below one slot.** A tap should reposition the bird meaningfully without
skipping a whole gap, so target ~60 px against the 87.3 px slot.

Solving the parabolic relations `h = v^2/2g` and `T = 2v/g` (equivalently `h = vT/4`) for
`h = 60, T = 0.334` gives `v = 719, g = 4305`. Rounded to **`flap -700, gravity 4200`**,
which lands at 58.3 px and 0.333 s — 5.01 taps per crossing.

**4. Fall cap — 850 px/s.** At `g = 4200` an uncapped fall the height of the screen reaches
**2768 px/s**, three screen-heights per second and entirely unrecoverable. A cap of 850
engages 0.202 s after apex, having fallen 86 px. Since a normal hop only rises 58 px, the
cap never touches routine play — it exists purely to make a genuine long fall survivable.
That is what a terminal velocity should do: bound the worst case without altering the
normal loop.

**Sanity check on the gap.** Adjacent spikes leave `87.3 - 30 = 57.3 px` of vertical space
against a 32 px bird — 25.3 px of clearance, tight but fair. This also bounds `birdRadius`:
above `(87.3 - spikeWidth)/2 = 28.6 px` the bird physically cannot pass a single-slot gap,
even though the slider allows 40. See the clearance readout in 1.6.

### 1.2 Terminal velocity — the highest-value addition

Clamp downward velocity every step:

```js
bird.vy = Math.min(bird.vy + gravity * dt, maxFallSpeed);
```

Without a cap, a fall from the ceiling to the floor at the tuned `gravity = 4200` reaches
`sqrt(2 * 4200 * 912) = 2768 px/s` — nearly three screen-heights per second, and
unrecoverable long before the player can react. Even at the slack spec value of 1620 it
still hits 1708 px/s. Every game in this genre caps fall
speed; the arc is parabolic on the way up and effectively linear once the cap is hit, which
is what makes a long fall readable rather than a stone drop.

This single parameter is the difference between "floaty and unfair" and "tight". Treat it
as a first-class control, not an afterthought.

### 1.3 Jump style

Two selectable models, because they feel materially different:

- **`instant`** — `vy = flapVelocity` in one step. Snappy, perfectly consistent, and what
  the current brief specifies.
- **`impulse`** — apply an upward velocity spread over `impulseFrames` steps, during which
  gravity still applies. Produces a short powered *rise* rather than an instantaneous
  velocity swap, and reads as a visible wing-beat. A new flap cancels and restarts the
  impulse rather than stacking.

Under `impulse`, derive the per-step velocity so that total rise matches the `instant`
model's `flapVelocity^2 / (2 * gravity)`, so switching modes does not silently change the
difficulty.

### 1.4 Spike angle

Spikes are currently symmetric triangles whose apex points straight into the play area.
Add `spikeAngle` (degrees, -45 to +45) which slides the apex **along the wall** while the
base stays fixed:

```js
apexX = wallFaceX + dir * spikeHeight;
apexY = s.y + Math.tan(spikeAngle * Math.PI / 180) * spikeHeight;
```

At 0 the spike is symmetric. Positive values tilt the tip downward, negative upward. This
changes the shape of the survivable gap asymmetrically — a downward-tilted spike is
forgiving to a rising bird and punishing to a falling one — which gives the RL agent a
genuinely different problem to solve without changing the spike count.

The collision test in `REVIEW.md` §4 assumes a symmetric taper and must be generalised:
compute the half-height at a given depth from the two edges of the actual (possibly skewed)
triangle rather than from `(spikeWidth/2) * (1 - d/spikeHeight)`. Do not ship a tilted
spike whose hitbox is still symmetric — that reintroduces the exact class of bug that
finding #4 documents.

### 1.5 Panel UI

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
| `maxFallSpeed` | 150 | 2000 | 10 |
| `horizontalSpeed` | 60 | 900 | 5 |
| `impulseFrames` | 1 | 20 | 1 |
| `birdRadius` | 6 | 40 | 1 |
| `spikeWidth` | 10 | 60 | 1 |
| `spikeHeight` | 8 | 60 | 1 |
| `spikeAngle` | -45 | 45 | 1 |
| `spikeCountMin` | 0 | 9 | 1 |
| `spikeCountMax` | 0 | 9 | 1 |
| `candyChance` | 0 | 1 | 0.05 |

Clamp so `spikeCountMin <= spikeCountMax` whenever either moves.

**These ranges are mandatory, not suggestions.** A slider whose range cannot reach the
correct value is worse than no slider, because it makes a bug look like a deliberate
setting. `gravity` in particular must span 200–5000: any range topping out below ~1600
cannot express working physics at all.

### 1.6 Derived-values readout (important)

Directly beneath the gravity and flap sliders, display continuously-updated derived
quantities. These are what make a bad parameter pair visible *before* playing:

- **Jump height** = `flapVelocity^2 / (2 * gravity)` px
- **Time to apex** = `|flapVelocity| / gravity` s
- **Horizontal travel per jump** = `horizontalSpeed * 2 * timeToApex` px
- **Wall-to-wall crossing time** = `(540 - 2*12) / horizontalSpeed` s
- **Taps per crossing** = crossing time / (2 * time to apex) — the single best one-number
  summary of how busy the game feels. Below ~2 it is a waiting game; above ~8 it is
  button-mashing. Target 4–6.
- **Time to reach terminal velocity** = `maxFallSpeed / gravity` s, and the fall distance
  covered getting there. Flag when terminal velocity is never reached within the screen
  height, since the cap is then doing nothing.
- **Gap clearance** = `(960/11) - spikeWidth - 2 * birdRadius` px — the vertical room left
  for the bird between two adjacent spikes. Turn this red at or below 0: the bird cannot
  fit through a single-slot gap and the game is unwinnable, which `birdRadius` above
  ~28.6 px causes at the default spike width even though the slider permits 40.

Colour the jump-height readout amber when it exceeds 300 px and red when it exceeds
960 px (the bird can reach the ceiling from the floor in one tap — the exact failure the
original build shipped with).

### 1.7 Presets and persistence

Provide preset buttons:

| Preset | gravity | flap | maxFall | hSpeed | Jump | Taps/crossing |
|---|---|---|---|---|---|---|
| **Tuned** (default) | 4200 | -700 | 850 | 290 | 58 px | **5.0** |
| **Balanced** | 2600 | -600 | 750 | 280 | 69 px | 3.8 |
| **Floaty** | 1300 | -470 | 500 | 240 | 85 px | 2.8 |
| **Twitchy** | 5000 | -620 | 1000 | 350 | 38 px | 5.6 |
| **Spec Literal** | 1620 | -510 | 600 | 270 | 80 px | 2.9 |
| **Broken (as shipped)** | 27 | -510 | 600 | 270 | 4816 px | 0.05 |

**Tuned** is the default and the one to ship — derived in 1.1b.

**Spec Literal** is the faithful conversion of the original brief, kept for comparison. It
is not wrong, just slack; playing the two back to back is the clearest demonstration of
what "taps per crossing" measures.

**Broken (as shipped)** reproduces the defect the generated build actually had, and is the
reason the gravity slider must span 200–5000 while still resolving a value of 27.

Persist the live config to `localStorage` under `dtts_physics` and restore on load.
Include a **Reset to Tuned Default** button.

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
3. Every slider reaches its full mandated range, and the **Broken (original)** and
   **Spec Default** presets are both selectable — i.e. the gravity control resolves both 27
   and 1620 without clamping either away.
4. At `spikeAngle = 30`, the spike hitbox visibly tracks the tilted sprite: grazing the
   overhanging side kills, and the opened side does not.
5. Raising `gravity` with `maxFallSpeed` held constant makes the bird reach a *visibly
   constant* descent rate partway down, rather than accelerating all the way to the floor.
6. Starting from a cleared table under spec-default physics, AI_TRAIN reaches a
   **50-episode moving average above 15 points within 5,000 episodes**, and the sparkline
   shows a visibly rising trend rather than a flat line.
7. AI_PLAY with the trained policy visibly threads spike gaps rather than flapping
   randomly.
8. Turbo mode at 5,000 steps/frame keeps the page responsive — sliders still drag.
9. Exporting a policy, reloading the page, and importing it restores the same play
   quality.
10. The file remains a single self-contained `.html` with no external requests.

## Notes on approach

Build and verify in the phase order given; do not write the whole file and then test.
After Phase 0, play it. After Phase 1, sweep gravity from 200 to 5000 and confirm nothing
breaks at the extremes. After Phase 2, run 500 episodes and confirm the mean score is
rising before tuning anything.

If the agent plateaus near zero, the fault is almost always the state encoding rather than
the hyperparameters — verify first that `dyBucket` is signed and that the "nearest safe
slot" is computed against the wall the bird is actually flying toward.
