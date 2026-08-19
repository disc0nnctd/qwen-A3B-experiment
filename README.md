# qwen-A3B-experiment

**Can a 35B mixture-of-experts model, running entirely on an eight-year-old gaming laptop
with a 6 GB GTX 1060, build a complete arcade game unattended?**

Yes. It took 22 minutes, and the result runs.

This repository is the full artefact of that run: the prompt it was given, the code it
produced, the exact llama.cpp configuration that made it possible on this hardware, and an
honest review of what it got wrong.

---

## The result

`original/index.html` is the model's output, unedited — a single self-contained HTML file
implementing a clone of *Don't Touch The Spikes*: canvas rendering, a three-state machine,
bird physics, procedurally regenerating wall spikes, a difficulty curve, a collectible
currency with `localStorage` persistence, particle systems, screen shake and a game-over
card. 520 lines, written in two commits, with zero human intervention between the prompt
and the result.

It is genuinely playable and genuinely flawed. [`REVIEW.md`](REVIEW.md) documents ten
defects in detail. The most instructive one is a single wrong constant:

```js
const GRAVITY = 27;   // should be 1620
```

The brief specified physics at a 60 FPS baseline. The model correctly decided to convert
to a delta-time loop, and correctly converted both **velocities** (`-8.5 px/frame` became
`-510 px/s`, `4.5 px/frame` became `270 px/s`). It then converted the **acceleration** the
same way — multiplying by 60 instead of 60² — because an acceleration in `px/frame²`
carries the frame unit twice.

The consequence is not subtle. Jump height is `v²/2g`:

```
as generated:  510² / (2 × 27)   = 4816 px    (five screen-heights, 18.9 s to apex)
correct:       510² / (2 × 1620) =   80 px    (0.32 s to apex)
```

A one-character-class error in dimensional analysis, producing a game where a single tap
sends the bird into orbit. That failure mode — architecturally sound, numerically
unverified — turned out to characterise the whole run.

---

## The hardware

Nothing here is a datacentre. This is a 2018 gaming laptop — eight years old.

| Component | Spec |
|---|---|
| Machine | Acer Predator laptop |
| CPU | Intel Core i5-8300H, 4 cores / 8 threads @ 2.30 GHz |
| RAM | 32 GB DDR4, ~22.7 GB/s measured bandwidth |
| GPU | NVIDIA GeForce GTX 1060 Mobile, **6 GB VRAM**, Pascal `sm_61` |
| Driver | 582.66 |
| OS | Windows 11 |

The GPU is the interesting constraint. 6 GB of VRAM against a **19 GB model file** — the
weights are more than three times the card's capacity.

## The model

| | |
|---|---|
| Model | `Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_S` |
| Architecture | Mixture of experts — 35B total parameters, ~3B active per token |
| Quantisation | Q4_K_S |
| File size | 19.0 GiB (20,366,861,472 bytes) |
| Runtime | llama.cpp `b10453` (`3cb7ffb1a`), CUDA 12.4, Clang 20.1.8 |

**MoE architecture is the entire reason this works.** Local inference on this class of
hardware is memory-bandwidth-bound, not compute-bound: throughput is governed by how many
bytes must be read per token. A dense 27B model must stream all ~17 GB of its weights for
every single token. This 35B MoE reads only the ~3B parameters that are active — roughly a
sixth of the traffic, from a model that is nominally larger.

The measured difference on this machine is stark:

| Model | Type | Generation |
|---|---|---|
| Qwen3.8-27B (Q3_K_XL) | dense 27B | **1.2 tok/s** |
| Qwopus3.6-35B-A3B (Q4_K_S) | MoE, 3B active | **11.4 tok/s** |

A ~9x speedup from a *larger* model. At 1.2 tok/s this experiment would have taken over
three hours and been useless; at MoE speeds it took 22 minutes.

(Both rows come from the original measurement pass, so the ratio between them is sound.
The A3B figure was later re-measured higher — see
[These numbers supersede an earlier set](#these-numbers-supersede-an-earlier-set-and-here-is-why-they-differ).
The dense model was not re-run, so it is left alone rather than compared across protocols.)

---

## The configuration that makes it work

```powershell
llama-server.exe `
  -m Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_S.gguf `
  --alias qwopus3.6-a3b-coder `
  --host 127.0.0.1 --port 8085 `
  -ngl 99 `
  --cpu-moe `
  --threads 6 `
  --ctx-size 98304 `
  --jinja `
  -n -1
```

### `-ngl 99 --cpu-moe` — the load-bearing flag pair

`--cpu-moe` keeps **all MoE expert weights in system RAM** while `-ngl 99` puts the
attention and shared layers in VRAM. An MoE's bulk is experts, but its per-token hot path
is largely the shared layers — so on a small card, offloading exactly the experts and
nothing else is the right split.

This is counter-intuitive enough that it is worth showing the sweep. Measured with
`llama-bench`, tg32, `-t 8`:

| Configuration | Generation |
|---|---|
| `-ngl 0` (everything on CPU) | 6.30 tok/s |
| `-ngl 99 -ncmoe 99` (all experts on CPU) | **10.36 tok/s** |
| `-ngl 99 -ncmoe 44` (some experts in VRAM) | 4.02 tok/s |
| `-ngl 99 -ncmoe 40` (more experts in VRAM) | 4.63 tok/s |

Moving experts *into* the 6 GB card makes it **2.5x slower** than leaving them all in RAM.
Partial expert residency thrashes VRAM, and the paging cost dwarfs any gain. On a card
this size the correct answer is all-or-nothing.

### Context: 98,304 tokens on a 6 GB card

KV cache costs roughly 21 MB per 1k tokens here, and throughput is nearly flat as the
window grows:

| Context | VRAM used | Generation |
|---|---|---|
| 16,384 | 2,661 MiB | 17.25 tok/s |
| 32,768 | 2,997 MiB | 17.15 tok/s |
| 65,536 | 3,669 MiB | 17.25 tok/s |
| **98,304** | **4,341 MiB** | **17.16 tok/s** |
| 131,072 | 5,013 MiB | 17.12 tok/s |

Each figure is the mean of four reps, measured twice per context in an
up-then-back-down order so that thermal drift cancels rather than accumulating on
whichever configuration happened to run last.

Generation is **flat across the whole range** — 17.25 tok/s at 16k against 17.12 at 131k,
a difference of 0.8% across an 8x larger window, which is inside the run-to-run spread.
Context length is not a throughput decision on this setup. It is purely a VRAM decision, at
a very predictable **21.0 MiB of KV cache per 1,000 tokens**.

98,304 is the configured default rather than the 131,072 maximum, to keep VRAM headroom.
At 131,072 roughly 1.1 GB remains free, and a browser claiming more VRAM can push the
server over the edge — at which point throughput collapses rather than degrades, because
the driver silently backs the overflow with *shared GPU memory* (system RAM reached over
PCIe 3.0 x16, ~12 GB/s real). That is slower than simply letting the CPU read the same
RAM at ~22.7 GB/s, and is the most likely reason the `-ncmoe` sweep above falls off a cliff
rather than degrading gently (not directly instrumented, but it fits both the magnitude and
the shape). Setting **CUDA - Sysmem Fallback Policy** to *Prefer No Sysmem Fallback*
in the NVIDIA control panel converts that silent 2.5x regression into a visible
allocation failure.

### Thread count: 6, not 8

The i5-8300H is 4 cores / 8 threads, so both "use every hardware thread" and "use only
physical cores" are defensible guesses. Both are wrong — the best setting is **6**.

| Threads | 1.4k-token prompt | 32.5k-token prompt |
|---|---|---|
| `-t 4` | 16.47 tok/s | — |
| **`-t 6`** | **17.12 tok/s** | **14.91 tok/s** |
| `-t 8` | 16.47 tok/s | 14.36 tok/s |

About **+4%** in both regimes. Small, but it reproduces: in the 32.5k set every single
`-t 6` rep (15.09, 15.14, 14.71, 14.69) beat every single `-t 8` rep (14.67, 14.41, 14.24,
14.10). Prompt processing is unaffected — 147.6 against 147.3 tok/s — so this is a
decode-side effect only, which fits a workload whose decode path is CPU-side expert GEMMs
and whose prefill is GPU-side.

Note that `-t 4` and `-t 8` tie *exactly* at 16.47. The intuition that hyperthread siblings
contend for the same memory pipeline predicts `-t 4` should win; it doesn't. We have the
measurement and no confident mechanism for why 6 specifically, so it is recorded as an
empirical result rather than explained.

Methodology matters here more than the number. Configurations were run in a mirrored order
(`8,4,6,6,4,8`) so that thermal drift cancels. That turned out to be load-bearing: the
first `-t 4` block reported 13.64 tok/s, which taken at face value would have made it look
20% slower than `-t 8`. Its prompt-processing rate that block was 154 tok/s against ~181
everywhere else — page-cache contention from reloading the 19 GB model early in the run,
not a property of the thread count. Measured again later in the same run it returned 16.47.
A single-pass benchmark would have published that artefact.

### Two things that look like optimisations and are not

- **KV cache quantisation (`-ctk q8_0 -ctv q8_0`) is catastrophic on Pascal.** Prompt
  processing fell from 84 to 8.4 tok/s — a 10x regression. Pascal lacks the native support
  that makes this a win on newer architectures. Leave the KV cache at F16.
- **MTP speculative decoding (`--spec-type draft-mtp`) made it worse**, despite the model
  shipping an MTP head. Measured draft acceptance was `0.00000` — literally zero drafted
  tokens accepted across 235 generated — turning the draft head into pure overhead and
  dropping throughput from 5.2 to 2.62 tok/s on the companion machine.

### Benchmark honestly: `llama-bench` will lie to you

The most transferable lesson from setting this up. `llama-bench` gave the wrong answer
three times, in both directions:

- It reported 11.8 tok/s for the MTP configuration. Real serving throughput was 5.2.
- It recommended a layer count that collapsed to 10.2 tok/s under the real server, because
  it does not account for the VRAM the actual serving context consumes.
- It **under**-reported baseline generation by ~45% — 11.94 tok/s against the server's
  16.76 at identical settings — because its default `tg32` run is too short to amortise
  threadpool spin-up on a CPU-side MoE. This one is the most dangerous of the three,
  because a pessimistic benchmark does not look like an error. It looks like your hardware.
  See [below](#these-numbers-supersede-an-earlier-set-and-here-is-why-they-differ).

Every number in this README was measured **against the running server** under realistic
load. Tune against the thing you will actually run.

---

## Measured throughput

| Metric | Result |
|---|---|
| Generation (16k context) | **17.25 tok/s** |
| Generation (98k context) | **17.16 tok/s** |
| Generation (32.5k-token prompt in flight) | **14.91 tok/s** |
| Prompt processing (2,000-token batch) | **185 tok/s** |
| Prompt processing (32,501-token batch) | 147 tok/s |
| KV cache cost | 21.0 MiB per 1,000 tokens |
| VRAM at 98,304 context | 4,341 / 6,144 MiB |

Two separate things are often conflated as "context". The **allocated window**
(`--ctx-size`) costs VRAM and essentially no throughput. The **prompt actually in flight**
does cost throughput: generation falls from 17.2 to 14.9 tok/s once 32.5k tokens are
resident, because every generated token attends over them.

Prompt processing peaks in the low thousands of tokens and declines from there — 185 tok/s
at 2k, 147 at 32.5k, 131 at 39.4k. It is much lower on very short prompts (63 tok/s) simply
because fixed per-request overhead dominates. So the shape is a rise then a slow fall, not
the "doubles on large batches" that a two-point measurement suggested. Cache hits remain
free: 39,413 tokens replayed in 0 s, which is what actually makes an agentic loop viable,
since each turn re-reads a large and mostly-unchanged context.

### These numbers supersede an earlier set, and here is why they differ

An earlier pass recorded 11.4 tok/s at 16k and 10.6 at 98k, against the 17.25 and 17.16
above. The hardware did not change and nothing was optimised. The earlier figures were
produced by **`llama-bench`**; the ones above were measured against the **running server**.

Re-running `llama-bench` today on the same model and flags reproduces the old number
exactly:

| Tool | threads | test | tok/s |
|---|---|---|---|
| `llama-bench` | 8 | tg32 | **11.94 +/- 2.25** |
| `llama-bench` | 8 | tg128 | 15.39 +/- 0.36 |
| `llama-bench` | 6 | tg32 | 15.18 +/- 0.27 |
| `llama-bench` | 6 | tg128 | 16.12 +/- 0.67 |
| live server | 8 | 32 tokens | **16.76** |
| live server | 6 | 32 tokens | **17.15** |

Two effects compound, and both are visible in that table:

- **tg32 is too short a run.** Going from tg32 to tg128 alone takes `-t 8` from 11.94 to
  15.39. On a CPU-side MoE the first tokens are dominated by threadpool spin-up and CPU
  boost ramp, and 32 tokens never amortises it. A live server does not pay this cost — its
  threadpool is already warm. Measured against the server, throughput is flat at ~16.8
  tok/s from `n_predict` 16 all the way to 512.
- **`-t 8` is also the noisiest setting**, at +/- 2.25 against +/- 0.27 for `-t 6`. The
  original configuration sat on the worst-behaved point of both axes at once.

So the honest chain is **11.4 (llama-bench tg32, -t 8) -> 16.8 (real serving, -t 8) ->
17.2 (real serving, -t 6)**. Only the last 4% is an improvement. The other ~45% was always
available and was simply being under-reported.

This also corrects a claim this README used to make: that every number in it was measured
against the running server. That was not true of the throughput and context tables. It is
true now.

The VRAM column moved too, by 200-350 MiB in the other direction. That one is benign:
`nvidia-smi` reports *total* board usage, so those figures always included whatever else
held VRAM at the time. The derived KV cost — 21.0 MiB per 1k tokens — is identical across
both passes, which is the number that actually matters for planning.

## The run

| | |
|---|---|
| Harness | [opencode](https://opencode.ai) |
| Prompt | [`mission.md`](mission.md), given once with no follow-up |
| Wall-clock | **22 minutes** |
| Context consumed | **33,487 / 98,304 tokens (34%)** |
| Output | 2 commits, 520 lines, one self-contained HTML file |
| Human intervention | none |

22 minutes of wall-clock covers reasoning, tool calls, prefill on every turn and two
code-writing passes. Generation alone runs at 15-17 tok/s depending on how much context is
resident, but wall-clock is not pure generation, so the run is better read as "a 520-line
file plus a self-directed polish commit (`234d249`) in under half an hour" than converted
into a token count.

The 34% context figure is worth dwelling on. The full agentic session — system prompt,
tool schemas, file reads, two write passes and the model's own reasoning — fit in a third
of the window, on a 6 GB card. Headroom, not a ceiling.

### opencode integration

llama.cpp's OpenAI-compatible endpoint plugs in as a custom provider. The model id must
match `--alias` exactly, and `context` must match the server's `--ctx-size`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "qwopus-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Qwopus 3.6 35B-A3B (local)",
      "options": {
        "baseURL": "http://127.0.0.1:8085/v1",
        "apiKey": "local"
      },
      "models": {
        "qwopus3.6-a3b-coder": {
          "name": "Qwopus 3.6 35B-A3B Coder",
          "tool_call": true,
          "limit": { "context": 98304, "output": 16384 }
        }
      }
    }
  }
}
```

Two practical gotchas: the server enforces no authentication, so `apiKey` can be any
non-empty string — bind it to `127.0.0.1` unless you intend to expose it. And give the
model a generous output budget: it emits reasoning into `reasoning_content`, so a tight
cap yields a long chain of thought and an *empty* answer, which looks like a broken server
and is not.

---

## What's next

[`mission_rl.md`](mission_rl.md) is the follow-up handoff, written to be executed by the
same model with the same lack of supervision. It asks for the game to grow into a combined
**physics laboratory and reinforcement-learning harness**: live sliders for gravity, flap
force and spike density, with derived readouts that make an inconsistent parameter pair
visible before you play it — and a tabular Q-learning agent that learns to tap its way to a
rising score in the same UI, with a turbo training mode and exportable policies.

The two halves are deliberately coupled. Change the gravity and the trained policy
degrades, which is the demonstration rather than a bug to be papered over.

There is a second motive. The failure documented above is a model producing plausible,
well-structured, unverified numerical work. A training loop cannot be self-deceived in
that way: an agent that cannot score is measurable in a way that "looks correct" is not.

## Repository layout

```
mission.md          the original prompt, given once
original/index.html the model's unedited output (commit 234d249)
index.html          the working copy, still being extended by the model
REVIEW.md           ten defects, ranked by impact on playability
mission_rl.md       the follow-up handoff: physics lab + RL agent
```

Open either HTML file directly in a browser. No build step, no dependencies, no network.
