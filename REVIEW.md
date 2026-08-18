# Code review — as-generated output (`original/index.html`)

Reviewed commit `234d249`, the state of the game after the 22-minute unattended run.
Findings are ranked by impact on playability. **Nothing here was auto-applied** — this is
written as an actionable spec so that the model, not a human, lands the changes.

The headline result: the model produced a **working, correctly-architected game** on the
first attempt. The state machine, render/update split, particle system, difficulty curve
and `localStorage` persistence all match the brief. The defects cluster in two places:
**unit conversion** and **state that was declared but never wired up**.

---

## 1. Gravity is 60x too weak — this is the "weird jump height"

```js
const GRAVITY = 27;
```

The brief specifies constants at a 60 FPS baseline:

| Quantity | Spec (per frame) | Correct per-second | In code | Verdict |
|---|---|---|---|---|
| Flap velocity | `-8.5 px/frame` | `-8.5 x 60 = -510` | `-510` | correct |
| Horizontal speed | `4.5 px/frame` | `4.5 x 60 = 270` | `270` | correct |
| Gravity | `0.45 px/frame^2` | `0.45 x 60^2 = 1620` | **`27`** | **wrong** |

The model correctly decided to convert the brief's per-frame constants into per-second
units for its `dt`-based loop, and got both **velocities** right. It then converted the
**acceleration** the same way — multiplying by 60 instead of 60². An acceleration in
`px/frame^2` needs `x fps^2`, because the frame unit appears twice in the denominator.

Using `h = v^2 / 2g`:

```
as generated:  510^2 / (2 x 27)   = 4816 px of jump height, 18.9 s to apex
correct:       510^2 / (2 x 1620) =   80 px of jump height, 0.32 s to apex
```

One tap launches the bird roughly **five screen-heights** upward on a 960 px canvas, so it
pins against the ceiling and drifts. There is no arc and no timing pressure. The
gravity-to-flap relationship reads as wrong because the ratio is off by that same factor
everywhere.

**Fix:** `const GRAVITY = 1620;`

Highest-value change in the file — most other physics complaints are downstream of it.

## 2. No spikes exist when the game starts

```js
function spawnSpikeWall(wallSpikes, x) {
  wallSpikes = [];        // rebinds the parameter; does not mutate the caller's array
  ...
  return wallSpikes;
}

// caller, in initWalls():
spawnSpikeWall(leftWallSpikes, WALL_BORDER + 15);   // return value discarded
```

`wallSpikes = []` rebinds the local parameter rather than clearing the caller's array, so
the function can only communicate through its return value. The two callers inside
`checkWallCollision` do use the return value; `initWalls` does not. The launch spike set
the brief asks for ("Wall B spawns a baseline set of random spikes") never appears, and
the first point is free.

Knock-on: the loop at lines 76–79 tests `wallSpikes.some(...)` against the array emptied
one line above, so the "slot already occupied" guard is unreachable code.

## 3. `leftWallSpikes` is dead state, and it corrupts candy placement

Both branches of `checkWallCollision` assign to `rightWallSpikes`:

```js
rightWallSpikes = spawnSpikeWall([], WALL_BORDER + 15);      // left-wall coordinates
rightWallSpikes = spawnSpikeWall([], W - WALL_BORDER - 15);  // right-wall coordinates
```

so `leftWallSpikes` stays empty forever. Rendering and collision survive this by unioning
both arrays. `spawnCandy` does not:

```js
const hasSpikes = rightWallHasSpikes ? rightWallSpikes : leftWallSpikes;
```

On alternating bounces this resolves to the permanently-empty `leftWallSpikes`, so **every
slot looks safe and candy spawns on top of a spike**. Candy is the only thing that pulls
the player off the safe line, so the game's sole reward becomes a coin-flip death.
Right-wall spawns pick the correct array, so it misbehaves roughly every other time —
exactly the pattern that is hard to catch by playing.

**Fix:** collapse to one `spikes` array plus a `spikeSide` flag. The two-array model
carries no information the flag doesn't, and every bug in this section comes from keeping
them in sync by hand.

## 4. Spike hitboxes don't match the drawn spikes

```
drawSpike:  vertical extent  y - SPIKE_H/2 ... y + SPIKE_H/2   (y-12 ... y+12)
collision:  vertical extent  y - SPIKE_H   ... y               (y-24 ... y)
```

The hitbox sits **12 px above** the sprite: the player dies to empty space above each
spike and passes through its visible lower half. In a game whose whole premise is precise
gap-threading, that is the difference between hard and broken.

Related: `drawSpike` builds a triangle with a *horizontal* 30 px base and a *vertical*
24 px apex offset — an up/down-pointing spike. These are **wall** spikes; the base should
run vertically along the wall face with the apex protruding horizontally into the play
area. As drawn they read as flat chevrons stuck to the wall.

Because the triangle tapers, a fair test is cheap:

```js
function spikeHit(s) {
  const depth = (bird.x - s.x) * s.dir;          // distance inward from the wall face
  if (depth - BIRD_R > SPIKE_H || depth + BIRD_R < 0) return false;
  const d = Math.max(0, depth - BIRD_R);         // shallowest point the bird reaches
  const halfH = (SPIKE_W / 2) * (1 - d / SPIKE_H);
  return Math.abs(bird.y - s.y) < halfH + BIRD_R;
}
```

## 5. The ceiling and floor are trampolines, not spikes

The brief calls for "continuous, uniform rows of static spikes completely lining the
absolute top and absolute bottom". Neither row is drawn, and contact bounces:

```js
if (bird.y - BIRD_R < SPIKE_H) { bird.y = SPIKE_H + BIRD_R; bird.vy = Math.abs(bird.vy) * 0.5; }
```

The two surfaces that should be instant death are the two safest places on the board.
Combined with finding #1, the emergent strategy is "hold the ceiling and win", which is
most of why the game currently has no failure pressure.

**Fix:** draw 18 spikes per row (`540 / 30`, exact) and make contact call `gameOver()`.

## 6. Screen shake sticks permanently after death

`update()` returns early in the `GAME_OVER` branch, before the block that decrements
`screenShake.frames`. Dying within 8 frames of scoring — the common case, since scoring
happens at the wall and the spikes are at the wall — latches the shake offset forever, so
the game-over card renders permanently off-centre by up to 5 px.

`gameOver()` also never calls `shakeScreen()`, though the brief asks for shake on damage.
The offset is randomised once and held for 8 frames, which is a lean rather than a shake;
re-rolling per frame is what sells the effect.

## 7. The death animation is invisible

Two independent causes:

- `gameOverAnim.birdY += 8 * dt` is **8 px per second**. The brief asks the bird to
  "plunge rapidly off the bottom screen boundary"; at this rate clearing 480 px takes a
  full minute. The `10 * dt` spin has the same problem.
- `flap()` restarts on *any* input in `GAME_OVER` with no time gate, so the animation is
  skipped before it ever renders. There is also no hit-test for the "Play Again" button,
  and no screen-to-canvas coordinate mapping anywhere in the file — which is what
  hit-testing on a CSS-scaled canvas requires.

`gameOverAnim.whiteFlash` is computed and decayed every frame but **never read by
`draw()`**, so the specified white flash does not exist.

## 8. Background colour is invalid CSS — inherited from the brief

```js
ctx.fillStyle = '#ecef1';   // five hex digits
```

Not a valid colour. Per the canvas spec an invalid `fillStyle` assignment is *ignored*,
leaving the previous value in place — so the background is painted with whatever colour
the last draw call used, and the intended pastel theme never appears.

This one is not really the model's fault. `mission.md` itself says
``light gray background `#ecef1` ``. The model reproduced the typo faithfully rather than
recognising it as malformed. Intended value is almost certainly `#ecf0f1`.

## 9. Frame-rate dependence remains in the effects layer

The main integrator is correctly `dt`-scaled; the particle and flash code was left on
per-frame arithmetic:

```js
p.x += p.vx;  p.y += p.vy;  p.life -= p.decay;   // no dt
scoreFlash *= 0.9;                               // no dt
```

On a 144 Hz display particles fly 2.4x faster and fade 2.4x sooner. Also
`if (p.type === 'candy') p.vy -= 0.05;` **subtracts** from an already-negative velocity, so
candy sparks accelerate upward forever; the brief asks them to drift downward.

## 10. Smaller items

- `gameTime` is incremented twice per frame — once in `gameLoop`, once at the end of
  `update` — so every sine-driven pulse runs at 2x speed, and only during gameplay.
- The first tap is consumed by the `START_MENU -> GAMEPLAY` transition without applying a
  flap, so the bird begins by falling.
- `spawnCandy` early-returns while an uncollected candy exists, and regeneration never
  clears the old one, so a stale candy lingers on the wall behind the bird.
- The score watermark at `rgba(0,0,0,0.04)` is effectively invisible; the brief asks for a
  faint but readable gray.
- Dead locals: `wallX` (twice) and `oppositeWallX` are assigned and never read.

---

## What this says about the run

Ten findings sounds severe; the distribution matters more than the count. Nine of the ten
are **local** — a constant, a sign, a discarded return value — and none require rethinking
the design. The model chose a sound architecture, correctly recognised that a
fixed-timestep brief should become a `dt`-based loop, and implemented every subsystem the
brief named. What it did not do is *verify*: not one of these findings survives thirty
seconds of actually playing the result.

That is a fair characterisation of this weight class at this quantisation — strong on
structure and API recall, weak at self-checking numerical work, and entirely un-grounded
without execution feedback. It is also precisely the gap that
[`mission_rl.md`](mission_rl.md) is designed to close: a training loop cannot be
self-deceived about whether the physics feel right, because an agent that cannot score
is measurable in a way that "looks plausible" is not.
