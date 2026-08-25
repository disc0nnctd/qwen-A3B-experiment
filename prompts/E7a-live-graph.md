# E7a — make the training graph move in real time

Apply these three exact edits to `index.html`. Do not look for other bugs. Do not
change any physics constant, reward value, or Q-learning hyperparameter. Do not
touch `updateAI`, `chooseAction`, or `updateQ`.

## The problem

`drawSparkline` is already called every frame, so this is not a refresh bug. It
has three separate defects that together make it look frozen.

**1. It only ever has one data point per episode.** `aiScores.push(...)` happens
in the `done` branch of `updateAI`. With turbo off that is roughly one point per
second, so for 59 out of every 60 frames the graph redraws identical data.
Nothing tracks the agent *within* an episode.

**2. It plots every episode across a fixed-width canvas.** After 4,500 episodes
`step = w / (aiScores.length - 1)` is about 0.06 px, so each new episode moves
the line by less than a pixel and the whole history is compressed into a flat
smear. Worse, `maxScore` is computed from `aiScores.slice(-200)` while the loop
draws *all* of `aiScores`, so any older episode above the recent maximum is drawn
off the top of the canvas.

**3. The moving average is O(n x 50) and runs every frame.** The inner
`for (let j = i - window + 1; j <= i; j++)` recomputes each 50-episode mean from
scratch. At 4,500 episodes that is about 225,000 additions per frame, 60 times a
second, and it grows without bound as training continues. The graph is actively
slowing down the training it is supposed to be showing.

---

## EDIT 1 — a live per-step trace

Next to the other `ai*` state variables (near `let aiLearning = false;`), add:

```js
// Per-step trace so the graph moves every frame instead of once per episode.
const LIVE_TRACE_MAX = 240;
let aiLiveTrace = [];
```

In `updateAI`, in the `else` branch that already runs `aiCurrentScore++`, append
the current score to the trace:

```js
  } else {
    aiCurrentScore++;
    aiLiveTrace.push(aiCurrentScore);
    if (aiLiveTrace.length > LIVE_TRACE_MAX) aiLiveTrace.shift();
    aiTotalSteps++;
```

Keep everything else in that branch exactly as it is.

## EDIT 2 — replace the whole of `drawSparkline`

Replace the entire existing function with:

```js
function drawSparkline() {
  const el = document.getElementById('sparkline-canvas');
  if (!el) return;
  const c = el.getContext('2d');
  const w = el.width, h = el.height;
  c.clearRect(0, 0, w, h);

  // Window to the most recent episodes. Plotting the entire history compressed
  // every new episode into well under a pixel, which is why it looked frozen.
  const VIEW = 200;
  const view = aiScores.slice(-VIEW);

  // Live per-step trace along the bottom third: this is what moves every frame.
  if (aiLiveTrace.length > 1) {
    const lmax = Math.max(5, ...aiLiveTrace);
    const lstep = w / (LIVE_TRACE_MAX - 1);
    c.strokeStyle = 'rgba(255,235,59,0.55)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i < aiLiveTrace.length; i++) {
      const x = i * lstep;
      const y = h - (aiLiveTrace[i] / lmax) * h * 0.30;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }

  if (view.length < 2) return;

  const maxScore = Math.max(5, ...view);
  const step = w / Math.max(1, view.length - 1);

  // Raw per-episode scores over the window.
  c.strokeStyle = 'rgba(79,195,247,0.25)';
  c.lineWidth = 1;
  c.beginPath();
  for (let i = 0; i < view.length; i++) {
    const x = i * step;
    const y = h - (view[i] / maxScore) * h * 0.9;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.stroke();

  // Moving average, computed with a running sum in a single pass instead of
  // recomputing each window from scratch every frame.
  const window = 50;
  if (view.length >= window) {
    c.strokeStyle = 'rgba(79,195,247,0.95)';
    c.lineWidth = 2;
    c.beginPath();
    let sum = 0;
    for (let i = 0; i < window; i++) sum += view[i];
    for (let i = window - 1; i < view.length; i++) {
      if (i >= window) sum += view[i] - view[i - window];
      const avg = sum / window;
      const x = i * step;
      const y = h - (avg / maxScore) * h * 0.9;
      if (i === window - 1) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }
}
```

## EDIT 3 — say whether learning is actually on

With learning off, episodes still tick, steps still tick and "States visited"
still grows, so the metrics panel looks identical either way. The only thing the
Start Learning button changes is whether the Q-table is written, and that is the
one number not on screen.

In `updateMetrics`, replace this line:

```js
    ['States visited', aiStatesVisited.size],
```

with:

```js
    ['States visited', aiStatesVisited.size],
    ['Learning', aiLearning ? 'ON' : 'OFF (not updating Q)'],
    ['Q updates', aiQUpdates],
```

Declare `let aiQUpdates = 0;` next to `aiLearning`, and increment it inside
`updateQ` on the line immediately after the `qTable[stateIdx] += ...` assignment.

---

## Verify

```
cd harness && node rl_check.js curve
```

The decile curve must be unchanged — none of these edits touch the learning rule.
The last-200 mean should still be around 200 and `best` in the high hundreds. If
the curve regresses, an edit went into the wrong function.
