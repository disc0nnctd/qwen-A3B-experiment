# Working notes for the agent

This repository is an experiment in having a local model build and improve a game
unattended. **The model writes the code in `index.html`.** A human, or another
agent driving it, supplies the task and verifies the result — but does not write
the game itself. That constraint is the experiment; keep it.

Read this before driving a session. Everything below was learned the expensive
way, in wall-clock, on this hardware.

---

## Verify by running, never by reading

The model will tell you "the file parses correctly". On at least one occasion it
established that by calling `fs.readFileSync` on the HTML, which proves the file
exists and nothing else. Its self-reports are not evidence.

Use the harness:

```
cd harness
npm install          # once
node rl_check.js            # smoke test + persistence round-trip
node rl_check.js curve      # learning curve by decile
node rl_check.js features   # feature variety + flap wiring + index bounds
```

Every bug in Block E of `TASKS_NEXT.md` was found by running that, and none of
them were visible by inspection. Two of them — a crash on the first frame and an
agent whose only action was a no-op — had survived multiple sessions of the model
reading its own code and pronouncing it correct.

A syntax check is still worth doing, and is not the same thing:

```
python -c "import re; s=open('index.html',encoding='utf-8').read(); \
  open('/tmp/game.js','w',encoding='utf-8').write(re.search(r'<script>(.*?)</script>',s,re.S).group(1))"
node --check /tmp/game.js
```

## Driving the model

The server config lives in `../run_a3b_predator.ps1`; the provider block for
opencode is in the README. Generation is ~17 tok/s when the GPU is idle.

**Invoke it like this.** The positional message must come *first*, and the long
prompt goes in a file:

```powershell
opencode run "Apply the edit described in the attached file exactly as written." `
  --auto --dir <repo> -f <promptfile>
```

- Passing a multi-line string through PowerShell `Start-Process -ArgumentList`
  **truncates it at the first line**. The model then receives only your opening
  sentence. This is silent and looks exactly like the model ignoring you: one
  session it received nothing but "Fix one bug in index.html", went hunting on
  its own, and rewrote an unrelated function.
- `-f` takes an array, so it swallows a following positional. Message first, or
  it fails with `File not found: Apply`.

**Start a fresh session per task.** opencode compacts a session once it grows,
and compaction at 17 tok/s costs *ten minutes or more* before your prompt is even
read. One session here had accumulated 244k input tokens and became unusable —
every turn paid the compaction toll. A fresh session reads `index.html` in about
90 seconds and gets straight to work.

**Check the server has a free slot** before blaming the model for being slow:

```
curl -s http://127.0.0.1:8085/slots
```

Concurrent opencode instances share one GTX 1060 and split the ~17 tok/s between
them. Three busy slots turn a 6-minute task into a 25-minute one.

## Prompt shape

**One concern per prompt.** A two-part prompt sent the model into a 25-minute
reasoning block that returned nothing at all. This is the failure the README
documents: reasoning goes to `reasoning_content` and consumes the 16,384-token
output budget, so a long chain of thought yields an *empty* answer. It looks like
a hung server and is not.

**Give literal before-and-after edits, not goals.** Framed as "fix a bug", the
model free-associates to the first defect it notices anywhere in the file and
fixes that instead. Framed as "replace this exact line with this exact line", it
is reliable and fast — a five-edit refactor landed correctly in one pass.

A prompt that works looks like:

```
Apply these three exact edits to index.html. Do not look for other bugs.
Do not change anything else.

EDIT 1 - line 602. Replace this line:
  <old>
with:
  <new>

Reason: <one paragraph of why, with the evidence>
```

**State what must not change.** "Do not change any physics constant, reward
value, or hyperparameter" is worth including every time. Without it the model
edits adjacent things it finds untidy.

**Always diff before accepting.** Even on a well-scoped prompt it makes
unrequested changes — during this work it rewrote `clampSliders()` and altered
the meaning of the Start Learning button without being asked. Both were
defensible; neither was requested.

## Observations about the model

- It is good at structure and bad at arithmetic. The original run produced a
  clean three-state architecture and a dimensionally wrong gravity constant. The
  RL pass produced a correct Q-learning update rule and an off-by-one in the
  table dimensions. Assume the shape is right and the numbers are not.
- It does not check its work against execution, only against plausibility. This
  is the single reason the harness exists.
- It writes reasonable, idiomatic code in this file's style, and follows an
  explicit edit list very well. Spend the effort on specifying, not on hoping.

## Hazards in this repo

- **`_build.py` regenerates `index.html` from scratch.** It is a stale scaffold
  from an early session and is hundreds of commits behind the live file. Running
  it would destroy the current game. It is gitignored; do not resurrect it.
- `TASKS_NEXT.md` drifts. Several tasks marked open there were already fixed in
  the working tree. Confirm against the code before acting on it.
