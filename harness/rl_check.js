#!/usr/bin/env node
//
// Headless verification harness for the RL build in ../index.html
//
// The point of this file: the model cannot verify its own work by reading, and
// "the file parses" is not evidence that anything runs. Every bug in Block E of
// TASKS_NEXT.md was found by running this, not by inspection.
//
//   npm install               (once, in this directory)
//   node rl_check.js          smoke test + persistence round-trip
//   node rl_check.js curve    learning curve by decile
//   node rl_check.js features state-feature variety + flap wiring check
//   node rl_check.js sweep    reward-scale sweep (needs prompts/E6 applied)
//
// It loads index.html in jsdom, stubs the 2D canvas context, and drives
// gameLoop by hand instead of through requestAnimationFrame, so a run that
// would take minutes in a browser finishes in seconds.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// QWENGAME_HTML lets a variant be measured without touching the working copy,
// which is how the sweep path itself was tested before E6 existed.
const GAME = process.env.QWENGAME_HTML || path.join(__dirname, '..', 'index.html');
const noop = () => {};

// A 2D context that accepts every call and returns something harmless. jsdom has
// no canvas backend, and installing node-canvas just to throw the pixels away
// would be a native build for no benefit.
const makeCtx = () => new Proxy({}, {
  get(t, p) {
    if (p in t) return t[p];
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop: noop });
    if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
    return noop;
  },
  set(t, p, v) { t[p] = v; return true; }
});

// url must be a real http origin: localStorage throws on opaque file:// origins,
// which would fail every persistence assertion below for the wrong reason.
function boot() {
  const dom = new JSDOM(fs.readFileSync(GAME, 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://harness.test/',
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = makeCtx;
      w.__errors = [];
      w.addEventListener('error', e => w.__errors.push(String(e.message)));
      // Capture the callback instead of scheduling it, so the caller owns time.
      w.requestAnimationFrame = cb => { w.__cb = cb; return 1; };
      w.cancelAnimationFrame = noop;
    }
  });
  const w = dom.window;
  // Top-level let in a classic script lives in global lexical scope, not on
  // window, so the internals are only reachable through eval.
  const q = expr => { try { return w.eval(expr); } catch (e) { return 'ERR: ' + e.message; } };
  return { w, q };
}

function startTraining(w, stepsPerFrame) {
  w.document.getElementById('mode-ai-train').click();
  w.document.getElementById('start-learn-btn').click();
  w.document.getElementById('turbo-check').checked = true;
  w.document.getElementById('turbo-steps').value = String(stepsPerFrame);
}

function runFrames(w, n) {
  for (let i = 0; i < n; i++) {
    try {
      w.__cb(i * 16.67);
    } catch (e) {
      return 'CRASHED on frame ' + i + ': ' + e.message + '\n' + e.stack.split('\n').slice(0, 4).join('\n');
    }
  }
  return null;
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

function smoke() {
  const { w, q } = boot();
  console.log('--- load ---');
  console.log('load errors      :', w.__errors.length ? w.__errors : 'none');
  console.log('gameLoop captured:', typeof w.__cb === 'function');

  startTraining(w, 200);
  console.log('mode (1=TRAIN)   :', q('gameMode'));
  console.log('aiLearning       :', q('aiLearning'));

  const crash = runFrames(w, 400);
  console.log('\n--- 400 frames x 200 steps ---');
  console.log(crash || 'no crash');
  console.log('runtime errors   :', w.__errors.length ? w.__errors.slice(0, 5) : 'none');
  console.log('episode          :', q('aiEpisode'));
  console.log('totalSteps       :', q('aiTotalSteps'));
  console.log('bestScore        :', q('aiBestScore'));
  console.log('statesVisited    :', q('aiStatesVisited.size'), 'of', q('Q_NUM_STATES'));
  console.log('qTable nonzero   :', q('Array.from(qTable).filter(x => x !== 0).length'), 'of', q('qTable.length'));

  // Assert on the DOM, not on the internals. A frozen panel next to a healthy
  // aiEpisode is exactly the failure that reads as "training never starts".
  console.log('\n--- rendered panel ---');
  console.log('metrics          :', w.document.getElementById('metrics').textContent);
  console.log('inspector display:', w.document.getElementById('rl-inspector').style.display);
  console.log('inspector        :', w.document.getElementById('rl-inspector').textContent.replace(/\s+/g, ' ').trim());
  const log = w.document.getElementById('rl-log');
  console.log('log lines in DOM :', log.childElementCount, '| ring buffer:', q('aiLogBuffer.length'), '| seq:', q('aiLogSeq'));

  console.log('\n--- persistence ---');
  const n = q('saveRunAndReport()');
  console.log('saveRunAndReport :', n);
  console.log('save-status      :', w.document.getElementById('save-status').textContent);
  const raw = w.localStorage.getItem('dtts_run');
  console.log('dtts_run bytes   :', raw ? raw.length : 'ABSENT');
  if (raw) {
    const o = JSON.parse(raw);
    console.log('fields           :', Object.keys(o).join(', '));
    console.log('episode', o.episode, '| best', o.bestScore, '| scores', o.scores.length, '| qtable', o.qtable.length);
  }
  console.log('lastSaveError    :', JSON.stringify(q('lastSaveError')));
}

function curve() {
  const { w, q } = boot();
  startTraining(w, 300);
  const crash = runFrames(w, 2000);
  if (crash) return console.log(crash);

  const s = q('aiScores');
  console.log('episodes:', s.length, '| steps:', q('aiTotalSteps'), '| states:', q('aiStatesVisited.size'));
  console.log('\nmean score per decile of training:');
  const B = Math.floor(s.length / 10);
  for (let d = 0; d < 10; d++) {
    const m = mean(s.slice(d * B, (d + 1) * B));
    console.log((d * 10 + '-' + (d * 10 + 10) + '%').padEnd(9), m.toFixed(1).padStart(7), '|' + '#'.repeat(Math.round(m / 4)));
  }
  console.log('\nfirst 200 mean:', mean(s.slice(0, 200)).toFixed(1));
  console.log('last  200 mean:', mean(s.slice(-200)).toFixed(1));
  console.log('best          :', q('aiBestScore'), '| epsilon:', q('aiEpsilon'));
  // A table that is almost entirely negative means the death penalty is
  // swamping the wall reward, which shows up as a curve that rises then sags.
  console.log('q > 0         :', q('Array.from(qTable).filter(x => x > 0).length'));
  console.log('q < 0         :', q('Array.from(qTable).filter(x => x < 0).length'));
}

function features() {
  const { w, q } = boot();
  startTraining(w, 1);

  // Flap wiring. If the agent's FLAP action is not applied to the bird, vy never
  // goes negative no matter how often the agent picks it, and the two actions
  // are silently identical. That bug survived several sessions unnoticed.
  let minVy = Infinity, maxVy = -Infinity, flaps = 0;
  const seen = { dx: new Set(), dy: new Set(), vy: new Set(), ds: new Set(), dir: new Set() };
  for (let i = 0; i < 4000; i++) {
    w.__cb(i * 16.67);
    const vy = q('bird.vy');
    if (typeof vy === 'number') { minVy = Math.min(minVy, vy); maxVy = Math.max(maxVy, vy); }
    if (q('aiStepAction') === 1) flaps++;
    const b = q('[dxBucket(), dyBucket(), vyBucket(), dySpikeBucket(), dirBit()]');
    if (Array.isArray(b)) {
      seen.dx.add(b[0]); seen.dy.add(b[1]); seen.vy.add(b[2]); seen.ds.add(b[3]); seen.dir.add(b[4]);
    }
  }
  console.log('--- flap wiring ---');
  console.log('FLAP chosen      :', flaps, 'of 4000 steps');
  console.log('bird.vy range    :', Math.round(minVy), '..', Math.round(maxVy));
  console.log('config.flapVel   :', q('config.flapVelocity'));
  console.log('vy ever negative :', minVy < 0, minVy < 0 ? '(flap is wired)' : '(FLAP IS A NO-OP)');

  console.log('\n--- state feature variety ---');
  // Each feature should span most of its declared dimension. A feature stuck on
  // two values contributes nothing the agent can condition on.
  const sizes = q('Q_SIZES');
  const row = (name, set, size) =>
    console.log(name.padEnd(5), ('distinct=' + set.size).padEnd(13), ('of ' + size).padEnd(7),
      JSON.stringify([...set].sort((a, b) => a - b)).slice(0, 60));
  row('dx', seen.dx, sizes[0]); row('dy', seen.dy, sizes[1]); row('vy', seen.vy, sizes[2]);
  row('ds', seen.ds, sizes[3]); row('dir', seen.dir, sizes[4]);
  console.log('\nstatesVisited    :', q('aiStatesVisited.size'), 'of', q('Q_NUM_STATES'));

  // Guards the class of bug where clampBucket's output range overflows the
  // dimension it feeds, silently corrupting every index past the boundary.
  console.log('\n--- index bounds ---');
  console.log('max legal index  :', q('Q_NUM_STATES - 1'));
  console.log('mixRadixKey max  :', q('mixRadixKey(Q_SIZES[0]-1, Q_SIZES[1]-1, Q_SIZES[2]-1, Q_SIZES[3]-1, Q_SIZES[4]-1)'));
  console.log('clampBucket spike:', q('JSON.stringify([...new Set(Array.from({length: 400}, function (_, i) { return clampBucket((i - 200) * 8, Q_BUCKETS.spikeBuckets); }))].sort(function (a, b) { return a - b; }))'));
}

// Sweep the reward scale. Requires the `rewards` object from prompts/E6; until
// that lands there is nothing to sweep and this says so rather than silently
// measuring the hardcoded literals.
function sweep() {
  const probe = boot();
  if (probe.q('typeof rewards') !== 'object') {
    console.log('No `rewards` object in index.html — apply prompts/E6-reward-config.md first.');
    console.log('Until then the reward literals are hardcoded inside updateAI and cannot be swept.');
    return;
  }

  // Vary the terminal penalty against the wall reward, holding the rest fixed.
  // These are the two that set whether surviving is positively valued at all.
  const configs = [
    { death: -100, wallHit: 10,  stepAlive: 0.1 },   // current defaults
    { death: -50,  wallHit: 10,  stepAlive: 0.1 },
    { death: -20,  wallHit: 10,  stepAlive: 0.1 },
    { death: -10,  wallHit: 10,  stepAlive: 0.1 },
    { death: -100, wallHit: 50,  stepAlive: 0.1 },
    { death: -20,  wallHit: 20,  stepAlive: 0.5 },
    { death: -10,  wallHit: 20,  stepAlive: 1.0 },
  ];

  console.log('reward sweep — 1200 frames x 300 steps each\n');
  console.log('death  wall  step |  first200  last200   delta |   best |  q>0   q<0 | curve');
  console.log('-'.repeat(96));

  for (const c of configs) {
    const { w, q } = boot();
    w.eval('Object.assign(rewards, ' + JSON.stringify(c) + ')');
    startTraining(w, 300);
    const crash = runFrames(w, 1200);
    if (crash) { console.log(JSON.stringify(c), crash.split('\n')[0]); continue; }

    const s = q('aiScores');
    const first = mean(s.slice(0, 200));
    const last = mean(s.slice(-200));
    const B = Math.floor(s.length / 6);
    // A compact shape, so rise-then-sag is visible at a glance next to the delta.
    const shape = Array.from({ length: 6 }, (_, d) => {
      const m = mean(s.slice(d * B, (d + 1) * B));
      return ' .:-=+*#%@'[Math.min(9, Math.round(m / 25))];
    }).join('');

    console.log(
      String(c.death).padStart(5),
      String(c.wallHit).padStart(5),
      String(c.stepAlive).padStart(5),
      '|', first.toFixed(1).padStart(9), last.toFixed(1).padStart(8),
      (last - first >= 0 ? '+' : '') + (last - first).toFixed(1).padStart(6),
      '|', String(q('aiBestScore')).padStart(6),
      '|', String(q('Array.from(qTable).filter(x => x > 0).length')).padStart(4),
      String(q('Array.from(qTable).filter(x => x < 0).length')).padStart(5),
      '|', shape
    );
  }

  console.log('\ncurve shape: low  .:-=+*#%@  high, six equal slices of training.');
  console.log('Want a rising delta AND a shape that holds at the right, not one that peaks mid-run.');
}

const mode = process.argv[2] || 'smoke';
({ smoke: smoke, curve: curve, features: features, sweep: sweep }[mode] || smoke)();
