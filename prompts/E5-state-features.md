# E5 — repair the state bucketing so the agent can see more than three situations

Apply these six exact edits to `index.html`. Do not look for other bugs. Do not
change any physics constant, reward value, or hyperparameter.

## The bug

`clampBucket(val, thresholds)` is meant to place a signed distance into one of
several bands. It returns on the **first** threshold it tests, and the threshold
list is ascending, so only the smallest threshold is ever consulted:

```js
for (let i = 0; i < thresholds.length; i++) {
  if (val < -thresholds[i]) return thresholds.length - i;      // any val < -8  -> 8
  if (val > thresholds[i]) return thresholds.length + i + 1;   // any val >  8  -> 9
}
return thresholds.length;                                       // |val| <= 8   -> 8
```

With `Q_BUCKETS.dyBuckets = [8,24,48,80,128,192,288,480]` the whole function
collapses to three outputs. Measured over every integer input from -960 to 960:

```
current outputs: [0, 8, 9]        3 of a possible 17
```

The other fourteen bands are unreachable by construction. Sampled, the failure is
plain — every negative distance from -10 to -300 is the same state:

```
current:  -300->8  -100->8  -30->8  -10->8  0->8  10->9  30->9  100->9  300->9
wanted:   -300->1  -100->4  -30->6  -10->7  0->8  10->9  30->10 100->12 300->15
```

The consequence: `dy` and `ds` each take exactly two values in practice, the
agent conditions on **323 states out of 36,720**, and it cannot distinguish
"slightly below the gap" from "far below the gap".

## What the dimensions should be

The declared sizes in `Q_SIZES` are already correct for a working bucketer, which
is good evidence of the original intent:

| feature | bucketer | thresholds | correct size |
|---|---|---|---|
| `dy` | signed | 8 | `2*8+1` = **17** |
| `vy` | signed | 4 | `2*4+1` = **9** |
| `ds` | unsigned (a distance, never negative) | 8 | `8+1` = **9** |

Note `ds` is currently declared as **10**. That was a patch for the broken
function and must go back to 9 once the function is fixed. Do not leave it at 10.

---

## EDIT 1 — replace `clampBucket` entirely

Replace the whole existing function with:

```js
// Signed band index for a distance that can be either side of a target.
// Returns 0 .. 2*thresholds.length inclusive: the centre band is
// thresholds.length, negative distances index below it, positive above.
function clampBucket(val, thresholds) {
  const n = thresholds.length;
  const a = Math.abs(val);
  let band = n;
  for (let i = 0; i < n; i++) {
    if (a <= thresholds[i]) { band = i; break; }
  }
  return val < 0 ? n - band : n + band;
}
```

## EDIT 2 — add an unsigned bucketer next to it

Immediately after `clampBucket`, add:

```js
// Band index for a magnitude that is never negative, such as a distance to the
// nearest spike. Returns 0 .. thresholds.length inclusive.
function magnitudeBucket(val, thresholds) {
  const n = thresholds.length;
  const a = Math.abs(val);
  for (let i = 0; i < n; i++) {
    if (a <= thresholds[i]) return i;
  }
  return n;
}
```

## EDIT 3 — `dySpikeBucket` must use the unsigned bucketer

It computes `minDist` with `Math.abs`, so the value is never negative and the
signed bucketer would waste half its range. Replace this line:

```js
  return clampBucket(minDist, Q_BUCKETS.spikeBuckets);
```

with:

```js
  return magnitudeBucket(minDist, Q_BUCKETS.spikeBuckets);
```

Leave the rest of the function alone. Note that when `spikes` is empty `minDist`
stays `Infinity`, which correctly lands in the top band.

## EDIT 4 — `vyBucket` currently throws away the sign

Rising and falling are the two most decisive situations in this game and the
agent cannot currently tell them apart: the function takes `Math.abs` of the
velocity, so a bird climbing at 300 px/s and one plummeting at 300 px/s are the
same state. Replace the entire body of `vyBucket` with:

```js
function vyBucket() {
  return clampBucket(Math.max(-900, Math.min(900, bird.vy)), Q_BUCKETS.vyBuckets);
}
```

## EDIT 5 — derive `Q_SIZES` from the threshold lists

Replace this line:

```js
const Q_SIZES = [Q_BUCKETS.dxBuckets, 17, 9, 10, 2];
```

with:

```js
// Derived, never hardcoded: a signed bucketer over n thresholds yields 2n+1
// values and an unsigned one yields n+1. Editing a threshold list above now
// resizes the table correctly instead of silently overflowing it.
const Q_SIZES = [
  Q_BUCKETS.dxBuckets,                    // dx, linear, 12
  2 * Q_BUCKETS.dyBuckets.length + 1,     // dy, signed,   17
  2 * Q_BUCKETS.vyBuckets.length + 1,     // vy, signed,    9
  Q_BUCKETS.spikeBuckets.length + 1,      // ds, unsigned,  9
  2                                       // dir
];
```

This is the point of the edit: the previous overflow happened because a bucket
function's output range and its dimension were maintained by hand in two places
and drifted apart. After this they cannot.

## EDIT 6 — slot 0 is a legitimate target

In `dyBucket`, replace:

```js
  const target = aiTargetBucket || 0;
```

with:

```js
  const target = aiTargetBucket ?? 0;
```

`||` treats slot 0 as absent. It happens to be harmless today because slot 0 is
never chosen as a spike slot, but it is wrong and it will bite the moment that
changes.

---

## Verify

Changing `Q_SIZES` changes the table size, which invalidates saved policies. That
is expected and already handled — `loadRun` and `loadQTable` compare against
`expectedSize` and call `initQTable` when it does not match.

Run:

```
cd harness && node rl_check.js features
```

Required afterwards:

- `clampBucket spike` reports far more than the current `[0,8,9]`
- `dy` spans well beyond two distinct values, toward its 17
- `vy` shows values on both sides of its centre band 4, proving the sign survives
- `mixRadixKey max` still equals `max legal index`
- `statesVisited` is in the thousands, not the hundreds

Then `node rl_check.js curve` and record whether the decile curve improves.
