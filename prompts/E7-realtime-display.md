# E7 — make AI_PLAY a real-time demonstration, and make the flap visible

Apply these six exact edits to `index.html`. Do not look for other bugs. Do not
change any physics constant, reward value, or Q-learning hyperparameter.

## The problem

Two complaints, one cause: `AI_PLAY` is not a separate mode at all. Every single
place that tests the mode does so as `gameMode === MODE.AI_TRAIN || gameMode ===
MODE.AI_PLAY`, so `AI_PLAY` runs the identical code path as training.

Measured against the current file in a headless harness, driving the real
buttons:

```
mode AI_PLAY, turbo 200:  118,329 agent steps in 600 frames, 1,671 episodes
mode AI_PLAY, turbo off:      591 agent steps in 600 frames,     9 episodes
```

That is the whole bug. In `AI_PLAY` the agent should be *demonstrating* its
learned policy at human speed — one decision per frame, greedy, no learning, and
a visible tap. Instead it is invisible: 200 physics steps collapse into one
rendered frame, so the bird teleports; it still explores randomly at whatever
epsilon training left behind; it still writes into the Q-table; and although
`aiLastAction` is assigned on line 739 it is **never read by `draw()`**, so
nothing on the canvas ever shows that the agent tapped.

The RL panel itself does update every frame — that was verified, the counters,
Q-values, TD error and step log all advance correctly. The reason it does not
look like anything is happening is that at turbo the panel is sampling one step
out of every 200 while the canvas is skipping 199 frames of motion.

---

## EDIT 1 — turbo applies to training only

In `gameLoop`, this block currently reads:

```js
    const turbo = document.getElementById('turbo-check') && document.getElementById('turbo-check').checked;
    const stepsPerFrame = turbo ? Math.max(1, Math.round(2 ** Math.log2(parseInt(document.getElementById('turbo-steps').value)))) : 1;
```

Replace with:

```js
    // AI_PLAY is a demonstration at human speed: exactly one decision per
    // rendered frame, so the tap is visible and the motion is continuous.
    // Turbo is a training accelerator and must not apply here.
    const turboEl = document.getElementById('turbo-check');
    const turbo = gameMode === MODE.AI_TRAIN && turboEl && turboEl.checked;
    const stepsPerFrame = turbo ? Math.max(1, parseInt(document.getElementById('turbo-steps').value) || 1) : 1;
```

Note this also removes the `2 ** Math.log2(x)` round-trip, which is the identity
function on any positive number and was doing nothing.

## EDIT 2 — no exploration and no learning while demonstrating

In `chooseAction`, replace this line:

```js
  const isExplore = aiEpsilon > Math.random();
```

with:

```js
  // Greedy in AI_PLAY: the point of the mode is to show the learned policy,
  // not to keep sampling random actions.
  const isExplore = gameMode === MODE.AI_TRAIN && aiEpsilon > Math.random();
```

Then in `updateAI`, find the line that writes the new value back into the table
(the `qTable[base + action] = ...` assignment that applies the TD update) and
guard the write so a demonstration cannot corrupt a trained policy:

```js
  if (gameMode === MODE.AI_TRAIN) {
    qTable[base + action] = <keep the existing right-hand side exactly as it is>;
  }
```

Leave the TD error calculation itself outside the guard — `aiStepTdError` should
still be computed and displayed in `AI_PLAY`, because seeing the agent be
surprised is informative. Only the write is suppressed.

## EDIT 3 — record when a tap happened

Next to the other `ai*` state variables near line 586, add:

```js
let aiTapFlash = 0;   // frames remaining on the on-screen tap indicator
```

In `updateAI`, in the block that applies the flap, extend it:

```js
    if (action === 1 && bird.alive) {
      bird.vy = config.flapVelocity;
      aiTapFlash = 12;
    }
```

## EDIT 4 — draw the tap

At the end of `draw()`, after everything else is drawn, add:

```js
  // Visible tap indicator: an expanding ring at the bird plus a corner badge,
  // so an observer can see the agent acting rather than inferring it.
  if (aiTapFlash > 0 && (gameMode === MODE.AI_TRAIN || gameMode === MODE.AI_PLAY)) {
    const t = aiTapFlash / 12;
    ctx.save();
    ctx.globalAlpha = t * 0.9;
    ctx.strokeStyle = '#ffeb3b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(bird.x, bird.y, config.birdRadius + (1 - t) * 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = t;
    ctx.fillStyle = '#ffeb3b';
    ctx.font = 'bold 14px Segoe UI';
    ctx.textAlign = 'left';
    ctx.fillText('TAP', 12, 24);
    ctx.restore();
    aiTapFlash--;
  }
```

## EDIT 5 — show the mode honestly in the inspector

In `renderRLInspector`, replace:

```js
    modeEl.textContent = gameMode === MODE.AI_TRAIN ? 'TRAIN' : 'PLAY';
```

with:

```js
    modeEl.textContent = gameMode === MODE.AI_TRAIN
      ? ('TRAIN' + (stepsPerFrameLast > 1 ? ' x' + stepsPerFrameLast : ''))
      : 'PLAY (greedy, not learning)';
```

and declare `let stepsPerFrameLast = 1;` alongside the other `ai*` variables,
assigning it in `gameLoop` right after `stepsPerFrame` is computed. Without this
the panel claims to be showing you a step when it is showing you one sample out
of two hundred, which is the thing that made the display untrustworthy.

## EDIT 6 — log every step at low turbo

In `gameLoop`, `pushStepLog()` is called once per frame outside the step loop, so
at turbo 200 it records 1 step in 200. Move the call inside the loop but keep it
cheap at high turbo:

```js
    for (let s = 0; s < stepsPerFrame; s++) {
      updateAI();
      if (stepsPerFrame <= 8 || s === stepsPerFrame - 1) pushStepLog();
    }
```

At turbo off, or low turbo, every decision now appears in the log. At high turbo
it stays one line per frame, which is all the DOM can absorb anyway.

---

## Verify

```
cd harness && node rl_check.js features
node rl_check.js curve
```

The curve must not regress — none of these edits touch the learning rule, only
when it is allowed to run.

Then check the mode split by hand: switch to `AI_PLAY`, enable Turbo, and confirm
the bird still moves at normal speed and the yellow TAP ring appears each time it
flaps. Switch to `AI_TRAIN` and confirm Turbo speeds it up again.
