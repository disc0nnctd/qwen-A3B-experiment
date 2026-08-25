# E6 — make the reward scale visible, adjustable and measurable

Apply these five exact edits to `index.html`. Do not look for other bugs. Do not
change any physics constant or Q-learning hyperparameter.

## The problem

The reward values are hardcoded inside `updateAI` as bare literals: `0.1` per
surviving step, `-100` on death, `10` on reaching a wall, `+5` for candy. After
7,139 training episodes the Q-table held **9 positive values against 620
negative** ones. The terminal penalty swamps everything else, so the agent is not
choosing between good and bad outcomes, it is choosing between degrees of bad.
That is the most likely reason the learning curve rises to a mean of ~108 by
mid-training and then sags back to ~74–90 instead of converging.

The fix is **not** to guess better numbers. This project already has a cautionary
tale about plausible unverified numerical work. The fix is to lift the rewards
out of the code and into the panel, exactly as the physics constants already are,
so they can be swept and measured. The harness has a `sweep` mode waiting for
this.

Everything below is mechanical. Choosing the values comes after, from
measurement.

---

## EDIT 1 — add the defaults

Immediately after the `PHYSICS_DEFAULTS` object, add:

```js
// Reward scale. Hardcoded literals inside updateAI until now, which made the
// balance between surviving, scoring and dying impossible to sweep.
const REWARD_DEFAULTS = {
  stepAlive: 0.1,    // per surviving step
  wallHit: 10,       // reaching the opposite wall
  candy: 5,          // collecting a candy
  death: -100,       // terminal, on hitting a spike
};
```

## EDIT 2 — add the live object

Next to wherever the live `config` object is created from `PHYSICS_DEFAULTS`, add
a matching live object:

```js
let rewards = Object.assign({}, REWARD_DEFAULTS);
```

## EDIT 3 — use it in `updateAI`

In `updateAI`, replace the four hardcoded literals with the config values. The
block currently reads:

```js
  let reward = 0.1;
  let done = false;

  if (!bird.alive) {
    reward = -100;
```

and further down `reward = 10;` in both wall branches, `reward += 5;` in the
candy branch, and the `aiStepReward` assignments that mirror each of them.

Replace every one of those literals with `rewards.stepAlive`, `rewards.death`,
`rewards.wallHit` and `rewards.candy` respectively. Keep the structure of the
block, the order of the tests, and the `aiStepReward` bookkeeping exactly as they
are — this edit changes where the numbers come from and nothing else. With the
defaults above the behaviour must be bit-identical to today.

## EDIT 4 — four sliders in the AI Training panel

In the AI Training section, below the Gamma slider and above the turbo row, add
four sliders following the exact markup pattern the Alpha and Gamma rows already
use, with these ids and ranges:

| id | label | min | max | step |
|---|---|---|---|---|
| `rw-step` | Step alive | -1 | 2 | 0.05 |
| `rw-wall` | Wall reward | 0 | 100 | 1 |
| `rw-candy` | Candy reward | 0 | 50 | 1 |
| `rw-death` | Death penalty | -200 | 0 | 1 |

Wire each one with an `input` listener that writes the parsed float into the
matching `rewards` field and updates its `.val` span, exactly as the existing
Alpha and Gamma listeners do. Add a "Reset rewards" button, id
`reset-rewards-btn`, that restores `REWARD_DEFAULTS` and refreshes all four
sliders and their readouts.

## EDIT 5 — persist them with the run

The reward scale is part of what produced a policy, so a saved run is not
reproducible without it.

- In `saveRun`, add `rewards: Object.assign({}, rewards)` to the object it
  builds, and bump `version` from `2` to `3`.
- In `loadRun`, restore it when present: `if (run.rewards) Object.assign(rewards,
  run.rewards);` and refresh the four sliders so the panel matches what was
  loaded. A version 2 record has no `rewards` field — accept it and leave the
  defaults in place rather than rejecting it.
- Do the same in `exportPolicy` and `importPolicy`.

---

## Verify

With the defaults unchanged, behaviour must be identical to before this edit.
Confirm that first:

```
cd harness && node rl_check.js curve
```

The decile curve should look like the current one. If it does not, the literals
were not transcribed faithfully.

Then confirm the sliders actually reach the agent:

```
node rl_check.js sweep
```

That drives `rewards` directly and reports a decile curve per configuration. The
combination to look for is one where `q > 0` is a substantial fraction of visited
states and the curve rises and **holds** rather than rising and sagging.

Do not hardcode the winner into `REWARD_DEFAULTS` as part of this task. Report
the sweep output and leave the choice to a follow-up, so the decision is made
against measurements rather than in the same breath as the refactor.

## Where the sweep is likely to land

The sweep was run in advance against a scratch copy patched to simulate this
edit, purely to confirm the harness path works. Treat this as a hypothesis to
reproduce, not an answer to copy:

```
death  wall  step |  first200  last200   delta |   best |  q>0   q<0
 -100    10   0.1 |      59.9     72.9 +  13.0 |    303 |    7   611   <- today
  -50    10   0.1 |      59.7    104.3 +  44.6 |    255 |   14   558
  -20    10   0.1 |      59.7     74.2 +  14.4 |    267 |   29   509
  -10    10   0.1 |      59.9     76.4 +  16.5 |    242 |   60   464
 -100    50   0.1 |      59.7     77.7 +  18.0 |    269 |   18   572
  -20    20   0.5 |      59.8    112.0 +  52.2 |    295 |  294   222   <- promising
  -10    20     1 |      59.6     61.6 +   2.0 |    152 |  137    46
```

Softening the terminal penalty alone helps a little. The configuration that
moves the Q-value balance is the one that *also* raises the per-step and
per-wall rewards: at `-20 / 20 / 0.5` the table goes from 7 positive values to
294, and the delta roughly quadruples. The last row is a caution — push the
per-step reward too high and the agent is paid to survive without progressing,
and the curve flattens.

Reproduce this against the real edit before trusting it. If the numbers come out
differently, the numbers win.
