# Task prompts for the model

One file per task, each a single concern, each written as literal
before-and-after edits. This shape is not stylistic — see `../AGENTS.md`. Given a
goal ("fix the state features") the model free-associates to whatever defect it
notices first. Given an exact line to replace, it is reliable.

## Delivering one

The positional message comes **first**, and the task file is attached with `-f`.
Passing the task inline through PowerShell `Start-Process -ArgumentList`
truncates it at the first line, silently.

```powershell
opencode run "Do the task described in the attached file. Do not search for unrelated bugs." `
  --auto --title "<short title>" --dir <path-to-repo> -f prompts/E5-state-features.md
```

Start a **fresh session per task**. A long session triggers opencode compaction,
which costs ten minutes or more at 17 tok/s before the prompt is even read.

## After it finishes

Never accept the model's own verdict that the file is correct. Run it:

```
cd harness
node rl_check.js features    # for E5
node rl_check.js sweep       # for E6
node rl_check.js curve       # for either
```

Then `git diff` before committing — it makes unrequested changes even on a
well-scoped prompt.

## Order

`E5` first. It changes the Q-table dimensions, which invalidates any saved
policy, so doing it before `E6` avoids throwing away a run tuned under the old
state space.
