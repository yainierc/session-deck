# design/

Mockups. Each one is a decision being made, frozen on the day it was made.

They are kept because the reasoning in them is not recoverable from the code
that came out of it. The sidebar looks the way it does because three of these
pages measured something nobody had measured: that the project heading was
rendering at 14px/400 when its own rule asked for 12px/600, that a session's
name started five pixels to the *left* of its project's, and that two
different things in the panel were both being called "active". A commit
message can carry the conclusion. It cannot carry the comparison you clicked
through to reach it.

They are static HTML with no build step and no dependencies — open one in a
browser. `package.json` publishes `src` and `dist`, so none of this ships.

## The rule for reading them

**The panel is the truth. A mockup is what somebody believed on a Thursday.**

Where a page says "today" it means the day it was written, and several of
those sentences are already false on purpose: describing the problem is the
whole job of the page, and the problem got fixed. Nothing here should be
treated as a description of how the deck currently behaves, and nothing here
should be updated to keep up with it. A mockup that gets edited to stay
current stops being a record of a decision and becomes a second, worse copy
of the code.

If one of these disagrees with the panel, the panel wins and the mockup is
history.

| File | Decided | State |
|---|---|---|
| `menu-v1.html` | The project row: name, "new task", and a `⋯` menu — out of four options | Implemented. Its "today" is the sidebar before any of it was done |
| `menu-v2.html` | How sessions nest under a project: the grouped block, out of six | Implemented |
| `menu-v3.html` | Where "you are here" lives: the block takes the only frame, the open session is filled | Implemented |
| `atlas-v1.html` | What replaces the "All agents" card grid once several sessions talk to each other — a score of per-agent lanes, out of three; plus what replaces the per-file treemap on that screen, out of three | Proposed, nothing built. The page is live: it simulates traffic so the three can be judged moving. The six agents are real; the messages between them are invented, and the page says so |
| `atlas-v2.html` | Whether the constellation v1 rejected as "prettiest, least informative" survives a better geometry — four of them, judged on one question: what does the movement mean. Picks the orbital clock, where a body's angle is how long that agent has been silent | Proposed, nothing built. Live like v1. Its four variants each carry a line separating what moves because of data from what moves for show; two of them fail it on purpose |
