# Next task list — post-review of the physics/RL build

**How to use this file.** Work **one task at a time, top to bottom.** Each task is
self-contained: it states the symptom, the exact code location, the root cause, the
required change, and a check you can run to prove it is done. After finishing a task,
change its `- [ ]` to `- [x]` in this file and commit that together with the code change.

If your context was compacted and you have lost the earlier discussion, **you do not need
it.** Everything required is in this file. Read the task, read the named function in
`index.html`, make the change, verify, tick the box, commit, move on.

Priority tags: **P0** = the game is broken without it. **P1** = the feature does not work
at all. **P2** = correctness/polish.

---

## Evaluation of the current build

Credit where it is due: the previous pass landed a large amount of `mission_rl.md`
correctly, and the structure is sound.

**Working:**

- `PHYSICS_DEFAULTS` + live `config` object, `localStorage` persistence, `hashConfig`.
- The full slider panel with the required ranges, all six presets, derived readouts.
- `drawWallSpike` now draws a **vertical base with a horizontally protruding apex** —
  the spike rotation from Phase 0.1 is correct.
- Ceiling/floor spike rows exist as a separate `capSpikes` array with their own hit test.
- Three-mode switch, turbo stepping, sparkline, export/import, the physics-hash banner.
- `GRAVITY` is gone; gravity is now a config value in the right units.

**Broken:** the game is not fair to play, and the RL harness does not train. The details
are the tasks below. The two the user reported directly are **T1** and **T2**.

---

## Status as of the 2026-08-25 session

T1–T11 and T13–T16 are **done** and verified by running `harness/rl_check.js`,
not by inspection. T12 remains open. Note that several of these were already
fixed in the working tree before this session started while their boxes were
still unticked — this file drifts, so confirm against the code.

The RL harness now trains: over 7,139 episodes the mean score rises from ~60 to a
peak of ~108 before sagging back to ~74–90. It is genuinely learning and
genuinely unstable. Block E below is the new work, found by execution.

---

## Block A — the reported bug: dying the instant you touch a wall

### - [x] T1 (P0) Spikes must spawn on the **opposite** wall, not the wall just hit

**Symptom (user-reported):** *"hitting a wall still spawns the spikes too fast that the
bird dies if a spike immediately spawns at contact."*

**Location:** `updatePhysics`, the two wall-collision branches; and `resetState`.

**Root cause.** On hitting the left wall the code does:

```js
bird.x = WALL_BORDER + config.birdRadius;   // 28
...
spawnSpikeWall(WALL_BORDER + 15);           // spikes at x = 27 — the SAME wall
```

The new spikes are generated on the wall the bird is **currently touching**, centred one
pixel from the bird. The spike-collision loop runs later in the *same frame*, so if any
spawned slot happens to sit at the bird's height, it is an unavoidable death with zero
reaction time.

This is not a tuning problem. `mission.md` §3 specifies the opposite behaviour:

> *"The exact millisecond the bird hits Wall B, all spikes on Wall B vanish. Wall A
> immediately rolls a random uniform selection to spawn a new set of spikes."*
> *"Spawn 2 to 3 random spikes **on the opposite wall**."*

The bird must always fly *toward* the new spikes across the full width of the screen, and
the wall it is touching must always be clear.

**How bad it is now.** Death band around a spike is
`spikeWidth/2 + birdRadius = 15 + 16 = 31 px` either side. Slot pitch is
`960 / 11 = 87.3 px`, so the band covers `62 / 87.3 = 71%` of a slot. With a mean of 3.5
spikes over 11 slots, the chance of an instant unavoidable death is
`0.71 x 3.5 / 11 = ~23%` — roughly **one wall hit in four**.

**Required change.**

- Hitting the **left** wall clears all wall spikes and spawns the new set on the **right**
  wall. Hitting the **right** wall spawns on the **left**.
- At launch (`resetState`), the bird starts mid-screen moving right, so the baseline set
  belongs on the **right** wall; the left wall starts clear.
- Keep the single `spikes` array — the `dir` field already encodes the side.

**Check:** bounce off a wall 20 times in HUMAN mode. You must never die on the frame of
contact, and the wall you are touching must be visibly empty of spikes every time.

---

### - [x] T2 (P0) Spike bases must sit flush against the wall face

**Symptom (user-reported):** *"the spikes are still slightly away from the real wall."*

**Location:** the `spawnSpikeWall(...)` call sites, which pass the base x.

**Root cause.** Callers pass `WALL_BORDER + 15` (= 27) and `W - WALL_BORDER - 15`
(= 513). The wall's inner faces are at `x = 12` and `x = 528`. The base is therefore
floating **15 px inside the play area**, leaving a visible gap between the wall and the
spike, and the apex stops 15 px short of where it should reach.

The `15` is a leftover from the old up/down triangle layout, where the spike was centred
on that x. After the Phase 0.1 rotation the base *is* `s.x`, so the offset is pure error.

**Required change.** Pass the wall face itself:

- left wall: base `x = WALL_BORDER` (12), apex at `12 + spikeHeight` = 36
- right wall: base `x = W - WALL_BORDER` (528), apex at `528 - spikeHeight` = 504

`drawWallSpike` and `wallSpikeHit` already derive everything from `s.x` and `s.dir`, so
neither needs editing — only the two literals.

**Check:** no gap between any wall and its spike bases at any `spikeWidth`/`spikeHeight`.
Drag both sliders end to end and confirm the bases stay welded to the wall.

---

### - [x] T3 (P0) Never spawn a spike in the slot the bird occupies

**Location:** `spawnSpikeWall`.

**Rationale.** T1 removes the same-frame death, but a safety net is still required: the
bird can arrive at the far wall exactly level with a spike with no room to move. This is
also the guard `mission.md` §3 asks for under "mathematical fairness".

**Required change.** `spawnSpikeWall` must take the set of forbidden slots and never
choose them:

- Forbid any slot `k` whose centre satisfies
  `|birdY - (SLOT_H * k + SLOT_H/2)| < spikeWidth/2 + birdRadius + 8`
  where `birdY` is the bird's y at spawn time. The `+8` is clearance margin.
- Also forbid **slot 0 and slot 10** unconditionally — `mission.md` §3 requires the
  top-most and bottom-most slots to always stay clear to prevent corner traps. The current
  `Math.floor(Math.random() * SLOT_COUNT)` picks `0..10` inclusive and violates this.
- Clamp the spike count so at least one slot always remains free:
  `count = Math.min(count, SLOT_COUNT - forbidden.size - 1)`.
- Replace the `do/while` + `attempts < 50` retry loop with an explicit array of allowed
  slots, shuffled, sliced to `count`. The retry loop can silently emit fewer spikes than
  requested, which makes the difficulty curve non-deterministic.

**Check:** set `Min Spikes` and `Max Spikes` both to 9 and bounce for a minute. The game
must remain survivable, slots 0 and 10 must stay empty, and the count must be exactly the
number of free slots minus one.

---

## Block B — geometry still wrong

### - [x] T4 (P1) Ceiling and floor spikes are detached from their surfaces

**Location:** `spawnCapSpikes`.

**Root cause.** Ceiling spikes are created at `y = WALL_BORDER + config.spikeHeight`
(= 36) with `dir = 1`, and `drawCapSpike` draws the base at `s.y` with the apex at
`s.y + dir * height` (= 60). So the ceiling row's base floats 24 px *below* the ceiling
and points down into open space. The floor row has the mirror bug: base at
`H - WALL_BORDER - spikeHeight` (= 924), apex at 900, leaving a 24 px gap above the floor.

**Required change.** The base belongs **on the surface**:

- ceiling: `y = WALL_BORDER` (12), `dir = +1`, apex at `12 + spikeHeight` = 36
- floor: `y = H - WALL_BORDER` (948), `dir = -1`, apex at `948 - spikeHeight` = 924

**Also in the same function:** the row length is `Math.floor(W / config.spikeWidth)` = 18,
starting at `WALL_BORDER`, so the last spike is centred at 537 and overhangs the right edge
of the canvas. Use the playable width: `Math.floor((W - 2 * WALL_BORDER) / spikeWidth)`
= 17 at defaults.

**Check:** ceiling and floor spike rows are visually welded to their borders and neither
row extends past the side walls, at `spikeWidth` = 10 and = 60.

---

### - [x] T5 (P2) Candy can still spawn on top of a spike

**Location:** `spawnCandy`.

**Root cause.** Spikes are placed at slot centres, `y = SLOT_H * slot + SLOT_H/2`. The
occupancy set is built with `Math.round(s.y / SLOT_H)`, and `s.y / SLOT_H` is exactly
`slot + 0.5`, which `Math.round` sends **up** to `slot + 1`. Every entry in the set is
off by one, so candy is excluded from an innocent slot and permitted in the occupied one.

**Required change.** Use `Math.floor(s.y / SLOT_H)`. Better: have `spawnSpikeWall` record
the slot indices it used and reuse that set directly, so the two never drift apart.

While here: `mission.md` §4 asks for candy **40 px inward** from the wall border and
rendered as a rotating diamond. It is currently 15 px inward and drawn as a circle.

**Check:** force `candyChance` to 1.0, `Max Spikes` to 9, and bounce 30 times. Candy must
never overlap a spike.

---

## Block C — the RL harness does not train

These are all in the Q-learning section. Each one alone is enough to prevent learning.

### - [x] T6 (P0) The Q-table has no action dimension — every state is corrupted

**Location:** `initQTable`, `mixRadixKey`, `getBestAction`, `updateQ`.

**Root cause.** The table is allocated with one slot per **state**:

```js
const sizes = [12, 17, 9, 9, 2];          // 12*17*9*9*2 = 33,048 states
qTable = new Float32Array(total);          // 33,048 entries
```

but it is read as though each state owned two adjacent entries:

```js
const a0 = qTable[base];
const a1 = qTable[base + 1];
```

So **action 1 of state `s` is physically the same memory as action 0 of state `s + 1`.**
Every update to one state silently overwrites its neighbour. The table cannot converge —
it is not a bug in the learning rate, the geometry is wrong.

**Required change.**

- Allocate `numStates * 2` = **66,096** entries.
- Index as `state * 2 + action` everywhere: `getBestAction`, `chooseAction`, `updateQ`.
- Keep `mixRadixKey` returning the *state* index; do the `* 2` at the point of access so
  there is exactly one place that knows the layout.

**Check:** after 200 training episodes, `qTable` must contain both positive and negative
values, and re-running `getBestAction` on the same state twice must agree.

---

### - [x] T7 (P0) Training stops permanently after the first death

**Location:** `updateAI`, and `initGame`.

**Root cause.** `updateAI` opens with:

```js
if (!bird.alive) return;
```

and on `done` it increments the episode counter but **never restarts the episode**. Once
the bird dies, `bird.alive` stays `false` forever and every subsequent call returns
immediately. Training runs exactly one episode and then silently idles — which looks like
"the agent never improves".

`initGame()` cannot be used as-is to restart, because its last lines force
`gameMode = MODE.HUMAN`, which would kick the user out of AI_TRAIN on every death.

**Required change.**

- Split the reset: `initGame()` keeps the mode assignment for first boot; add a
  `resetEpisode()` that re-creates the bird and calls `resetState()` **without** touching
  `gameMode`.
- Call `resetEpisode()` in the `done` branch of `updateAI`.

**Check:** enter AI_TRAIN and leave it for 30 seconds. The episode counter must climb
continuously into the hundreds, not stop at 1.

---

### - [x] T8 (P0) Every episode is recorded as a score of zero

**Location:** `updateAI`, the `done` branch.

**Root cause.** The score is zeroed *before* it is recorded:

```js
aiCurrentScore = 0;
aiEpisode++;
aiScores.push(aiCurrentScore);              // always pushes 0
if (aiCurrentScore > aiBestScore) ...       // never true
```

so `aiScores` fills with zeros, best score never rises, and the sparkline is a flat line
regardless of how well the agent plays.

**Required change.** Record first, then reset:

```js
aiScores.push(aiCurrentScore);
if (aiCurrentScore > aiBestScore) aiBestScore = aiCurrentScore;
aiEpisode++;
aiEpsilon = computeEpsilon();
aiCurrentScore = 0;
```

Also: `aiCurrentScore++` currently counts **steps survived**, not walls cleared. Score the
agent on the same number the human sees — increment it where `score++` happens on a wall
hit, and keep the per-step survival term in the *reward* only.

**Check:** train for 300 episodes; the sparkline must show a visibly rising trend and
"Best" must exceed 0.

---

### - [x] T9 (P1) The agent has no idea where the gap is

**Location:** `dyBucket`, and `aiTargetBucket`.

**Root cause.** `dyBucket()` measures the bird's distance to `aiTargetBucket`, but
`aiTargetBucket` is only ever assigned `null` (in `resetAI` and in the `done` branch).
`const target = aiTargetBucket || 0` therefore always resolves to slot 0, so the feature
reports "distance to the top of the screen" — a value the agent cannot act on.

**Required change.** After each spawn, compute the safe slot the agent should aim for and
store it in `aiTargetBucket`: the free slot on the destination wall nearest to the bird's
current y. Recompute it whenever `spawnSpikeWall` runs. With T1 in place there is always
at least one such slot.

**Check:** log `aiTargetBucket` for a few episodes — it must change after every wall hit
and always name a slot with no spike in it.

---

### - [x] T10 (P2) Epsilon jumps discontinuously at episode 1500

**Location:** `computeEpsilon`.

**Root cause.** `Math.exp(-aiEpisode / 1500)` reaches only `e^-1 = 0.368` at episode 1500,
and is then hard-clamped to `0.02`. Exploration collapses by a factor of 18 in a single
episode instead of annealing.

**Required change.** Solve the decay constant so the curve *arrives* at 0.02 at 1500:

```js
const EPS_MIN = 0.02, EPS_EPISODES = 1500;
const k = Math.log(1 / EPS_MIN) / EPS_EPISODES;   // ~0.00261
return Math.max(EPS_MIN, Math.exp(-k * aiEpisode));
```

**Check:** epsilon at episode 0 = 1.0, at 750 = ~0.14, at 1500 = 0.02, with no step change.

---

### - [x] T11 (P2) The Q-table is written to `localStorage` many times per second

**Location:** `gameLoop`.

```js
if (gameMode === MODE.AI_TRAIN && aiEpisode % 100 === 0) saveQTable();
```

The condition is on the episode number but the check runs **every frame**, so for the
entire duration of episodes 0, 100, 200 … it serialises a 66,096-entry `Float32Array` to
JSON on every frame. In turbo mode this dominates the frame budget.

**Required change.** Save from the `done` branch of `updateAI`, guarded on the episode
having actually changed — so it fires exactly once per 100 episodes.

---

## Block D — smaller items

### - [ ] T12 (P2) Turbo step count is computed by a no-op

`Math.floor(2 ** Math.log2(stepsPerFrame))` returns `stepsPerFrame` unchanged. Either drop
the round trip or, if the intent was to snap to a power of two, use
`2 ** Math.round(Math.log2(stepsPerFrame))`.

### - [x] T13 (P2) Death animation is still 8 px per second

`gameOverAnim.birdY += 8 * PHYSICS_DT` moves the bird 8 px **per second**; clearing the
screen takes a minute. `mission.md` §5 asks the bird to "plunge rapidly off the bottom
screen boundary". Use a real fall — `600` px/s accelerating — and the same for the `0.1`
spin. `gameOverAnim.whiteFlash` is still specified but not drawn.

### - [x] T14 (P2) Unreachable branch in the jump-height readout

```js
jumpH > 300 ? 'amber' : (jumpH > 960 ? 'red' : 'green')
```

Anything `> 960` is already `> 300`, so `red` can never render. Order the tests from the
most extreme downward.

### - [x] T15 (P2) Dead code in `dxBucket`

Both branches of the outer ternary are byte-identical, and the literal `12` inside them is
a stand-in for `config.birdRadius` that will not track the slider. Collapse the ternary and
use the config value.

### - [x] T16 (P2) Difficulty curve ignores the score

`mission.md` §3 asks for 2–3 spikes at score 0–5, 3–4 at 6–15, 4–5 at 16+. The current
count depends only on the sliders. Keep the sliders as the outer bounds and let the score
curve select within them, so the panel stays authoritative but the game still ramps.

---

## Definition of done

1. Twenty consecutive wall bounces in HUMAN mode with no death at the moment of contact.
2. Spike bases flush against all four surfaces, at both extremes of every size slider.
3. Slots 0 and 10 never occupied; at least one free slot on every generated wall.
4. Candy never overlaps a spike across 30 spawns at `candyChance` 1.0.
5. AI_TRAIN runs continuously for 1000+ episodes without stalling.
6. The score sparkline shows a clearly rising trend over those episodes.
7. Best score under AI_PLAY beats a random-action baseline by at least 3x.
8. Changing gravity raises the physics-mismatch banner and measurably degrades AI_PLAY.


---

## Block E — found by running the game, 2026-08-25

None of these were visible by reading the code. All four were found with
`harness/rl_check.js`. Three were fixed in this session; the analysis for the
remaining work is in E5 and E6.

### - [x] E1 (P0) The agent's FLAP action was a no-op

**Location:** `updateAI`.

**Root cause.** Every `bird.vy = config.flapVelocity` in the file sits inside a
human input handler — the keydown, click and touchstart listeners. Those handlers
apply the flap only when `gameMode === MODE.HUMAN`; in AI mode they set
`aiLastAction = 1`, which is a display variable. `updateAI` itself chose an
action, stored it, and went straight to `updatePhysics` without ever touching
`bird.vy`.

So both of the agent's actions were identical, and no policy could be better than
any other. Measured before the fix: the agent chose FLAP 1,950 times out of 4,000
steps and `bird.vy` stayed in the range 0..500 the entire run, against a
`flapVelocity` of -470. The bird was in permanent freefall.

**Fix.** Apply the flap in `updateAI` immediately after the action is chosen and
before `updatePhysics`, matching what the human handlers do.

**Effect.** States visited 21 → 323. Best score 62 → 280. Mean of the last 200
episodes 57.8 → 90.6.

**Check:** `node harness/rl_check.js features` must report `vy ever negative:
true (flap is wired)`.

---

### - [x] E2 (P0) `ds` bucket overflowed the Q-table and crashed the render loop

**Location:** `initQTable`, `mixRadixKey`, and the three `expectedSize` literals.

**Root cause.** `clampBucket(val, thresholds)` returns `0` below the low bound and
`thresholds.length + 1` above the high bound, so with the 8-entry
`Q_BUCKETS.spikeBuckets` it yields **ten** distinct values, 0 through 9. But the
`ds` dimension was declared as **9**. Whenever the feature bucketed to 9 the state
index ran past the end of the table:

```
mixRadixKey max legal   = 33047
mixRadixKey with ds = 9 = 34883   against a 33048-state table
```

Three consequences, in rising order of nastiness:

1. `qTable[state * 2]` read back `undefined`, so `pushStepLog` threw on
   `.toFixed` and killed `gameLoop` **before** `draw`, `updateMetrics` and
   `drawSparkline`. Because `requestAnimationFrame` is the first line of
   `gameLoop`, the next frame still scheduled — so training advanced while the
   entire UI stayed frozen at zero. This is what "the agent won't show me the
   RL steps" actually was.
2. `getBestAction` compared `undefined >= undefined` → false, silently always
   returning action 0 in those states.
3. `updateQ` wrote to an out-of-range typed-array index, which is a **silent
   no-op** — those updates were discarded.

**Fix.** One shared `Q_SIZES` / `Q_NUM_STATES` pair used by all five sites, with
the `ds` dimension corrected to 10, plus a clamp in `getStateKey` so a future
indexing mistake degrades instead of killing the render loop.

**Check:** `node harness/rl_check.js features` — `mixRadixKey max` must equal
`max legal index`.

---

### - [x] E3 (P1) The step log froze permanently after 200 lines

**Location:** `renderStepLog`.

Two independent causes, both of the same shape: a guard comparing
`aiLogBuffer.length` against `logEl.childElementCount`, which are permanently
equal once the ring buffer saturates at `LOG_MAX`. Replaced with an
`aiLogSeq` / `aiLogRendered` counter pair, and the full 200-node rebuild replaced
with an append-and-trim.

---

### - [x] E4 (P2) A quota failure in `saveRun` threw a second time

**Location:** `saveRun`.

The catch block called `localStorage.setItem('dtts_run_error', ...)`. Since the
only realistic reason `saveRun` fails is an exhausted quota, that second write
also threw, and the exception escaped the catch. Replaced with a `lastSaveError`
module variable surfaced through `#save-status`.

---

### - [ ] E5 (P1) `dy` and `ds` are stuck on two values each

**Location:** `clampBucket`, `dyBucket`, `dySpikeBucket`.

Measured over 4,000 steps after E1 and E2 were fixed:

```
dx    distinct=8    of 12   [0,1,2,3,4,5,10,11]
dy    distinct=2    of 17   [8,9]
vy    distinct=4    of 9    [0,1,2,3]
ds    distinct=2    of 10   [8,9]
```

`clampBucket` only ever emits `[0, 8, 9]` in practice — three of its ten possible
outputs. The threshold ladder is not being exercised: the inputs are almost
always either near zero or past the 480 clamp, so the eight intermediate bands
are dead. `dy` also has 17 declared slots for a function that can produce at most
10 values, so seven are unreachable by construction.

The agent is conditioning on 323 states out of 36,720. Fixing this is the largest
remaining lever on learning quality.

**Required change.** Re-derive the threshold ladders from the actual observed
distribution of each quantity rather than from a guessed geometric series, and
size each dimension to exactly the number of values its bucket function can
return. Do not change the dimension sizes without changing `Q_SIZES` — see E2.

**Check:** `node harness/rl_check.js features`. Each feature should span most of
its declared dimension, and `statesVisited` should be in the thousands.

---

### - [ ] E6 (P1) The reward scale pins the table negative

**Location:** the reward block in `updateAI`.

After 7,139 episodes: `q > 0` was **9** values against `q < 0` of **620**. The
`-100` death penalty swamps the `+10` per wall and the `+0.1` per step, so nearly
every state-action pair carries a negative value and the agent is choosing
between degrees of bad. This is the most likely cause of the curve rising to ~108
by mid-training and then sagging back to ~74–90 rather than converging.

**Required change.** Rebalance so that surviving and clearing walls is positively
valued, not merely less negative. Reducing the terminal penalty, or scaling the
per-wall reward up, or discounting the death penalty by episode length are all
reasonable; measure with `node harness/rl_check.js curve` and keep whichever
produces a monotone decile curve.

**Check:** the decile curve must rise and hold rather than rise and sag, and
`q > 0` must be a substantial fraction of the visited states.
