# qwen-A3B-experiment

**Can a 35B mixture-of-experts model, running entirely on a six-year-old gaming laptop
with a 6 GB GTX 1060, build a complete arcade game unattended?**

Yes. It took 22 minutes at ~11 tokens/second, and the result runs.

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

Nothing here is a datacentre. This is a 2018 gaming laptop.

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
three hours and been useless; at 11.4 tok/s it took 22 minutes.

---

## The configuration that makes it work

```powershell
llama-server.exe `
  -m Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_S.gguf `
  --alias qwopus3.6-a3b-coder `
  --host 127.0.0.1 --port 8085 `
  -ngl 99 `
  --cpu-moe `
  --threads 8 `
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
| 16,384 | 2,877 MiB | 11.4 tok/s |
| 32,768 | 3,375 MiB | 10.0 tok/s |
| 65,536 | 4,051 MiB | 10.7 tok/s |
| **98,304** | **4,695 MiB** | **10.6 tok/s** |
| 131,072 | 5,357 MiB | 10.6 tok/s |

98,304 is the configured default rather than the 131,072 maximum, to keep ~1.4 GB of VRAM
headroom. At 131,072 only 787 MiB remain, and a browser claiming more VRAM can push the
server over the edge — at which point throughput collapses rather than degrades.

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
twice, in both directions:

- It reported 11.8 tok/s for the MTP configuration. Real serving throughput was 5.2.
- It recommended a layer count that collapsed to 10.2 tok/s under the real server, because
  it does not account for the VRAM the actual serving context consumes.

Every number in this README was measured **against the running server** under realistic
load. Tune against the thing you will actually run.

---

## Measured throughput

| Metric | Result |
|---|---|
| Generation (16k context) | **11.4 tok/s** |
| Generation (98k context) | **10.5–10.6 tok/s** |
| Prompt processing (short) | 63 tok/s |
| Prompt processing (39,417-token batch) | **131 tok/s** |
| VRAM at 98,304 context | 4,695 / 6,144 MiB |

Growing the context window 6x costs about **8%** of generation throughput. Prompt
processing scales the opposite way — it more than doubles on large batches, which is
exactly the regime an agentic coding session lives in, since each turn re-reads a large
and mostly-unchanged context. Cache hits are free: 39,413 tokens replayed in 0 s.

## The run

| | |
|---|---|
| Harness | [opencode](https://opencode.ai) |
| Prompt | [`mission.md`](mission.md), given once with no follow-up |
| Wall-clock | **22 minutes** |
| Context consumed | **33,487 / 98,304 tokens (34%)** |
| Output | 2 commits, 520 lines, one self-contained HTML file |
| Human intervention | none |

At ~11 tok/s sustained, 22 minutes is on the order of 14,000 generated tokens across
reasoning, tool calls and two code-writing passes — consistent with a 520-line file plus a
self-directed polish commit (`234d249`) that the model wrote without being asked.

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
