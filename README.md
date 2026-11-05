# session-deck

[![test](https://github.com/yainierc/session-deck/actions/workflows/test.yml/badge.svg)](https://github.com/yainierc/session-deck/actions/workflows/test.yml)

One panel for every Claude Code session you have running, grouped by project,
with a desktop notification when any of them gets blocked waiting on you.

## Requirements

- **Node.js 18 or newer.**
- **[Claude Code](https://docs.claude.com/en/docs/claude-code), installed and
  signed in.** The deck does not start sessions from nothing: it reads the
  registry Claude Code already publishes on this machine, so without the CLI
  there is nothing to show.

## Install

Not published to npm yet — run it from a clone.

```
git clone https://github.com/yainierc/session-deck.git
cd session-deck
npm install
npm run build
npm start            # opens http://localhost:4317 in your browser
```

Two things about that first start. **The deck is locked**, so open the link it
prints rather than typing `localhost:4317` yourself — the printed one carries
the key, a bare URL will just ask you for it. See [Pairing](#pairing). And
`npm start` lives as long as the terminal does; `./deck.sh start` runs it in
the background instead, independent of the shell and of VS Code, with `stop`,
`restart`, `status` and `logs` alongside it.

`deck.sh` is the one part of this that is not portable: it is a bash script,
and it reaches for `pgrep`, `nohup` and `curl`. On Windows use `npm start` and
leave the terminal open, or run the script from Git Bash or WSL. Everything
else — the server, the tests, the build — is Node, and
[CI runs it on Windows, macOS and Linux](../../actions/workflows/test.yml).

`npm link` from the clone puts `session-deck` on your PATH as a command.

## Why it exists

When you have six sessions spread across VS Code windows, the problem is not
being unable to see them: it is not noticing that one has been sitting on a
permission prompt for twenty minutes. session-deck reads the registry Claude
Code already publishes and tells you.

## Options

```
session-deck --port 4317     # port (default 4317)
session-deck --host 0.0.0.0  # reach it from your phone on the local network
session-deck --no-open       # do not open the browser
session-deck --no-notify     # no desktop notifications
```

### Where your data lives

The pairing key, the workspace, the presets, the settings and the handoff
record — the sessions to offer back after a restart — all sit in
`~/.session-deck/`. `SESSION_DECK_DIR` points that somewhere else if you want
it somewhere else. `~/.claude` is read, never written — with exactly one
exception, [killing a session the deck did not
start](#killing-a-session-the-deck-did-not-start), which tidies up the
registration of the process it just ended because that process no longer can.

## Pairing

The deck is locked. Starting it prints a link carrying its key, and opens your
browser on that link; with `--host 0.0.0.0` it also prints a QR code, which is
how a phone gets in without anybody typing a token.

```
  locked. open this to pair this browser:
  http://localhost:4317/?token=...

  or scan to pair a phone on your network:
  [QR]
```

You pair a device once. The link is traded for a cookie and then removed from
the address bar, so it is not left behind in history, in a bookmark, or in a
screenshot of the panel.

This is not ceremony. The deck launches sessions and answers their permission
prompts, including in **Never ask** mode — so an open port here is arbitrary
code execution on this machine, and `--host 0.0.0.0` puts that port in front of
everyone on the network. It used to be open.

### Reaching it from your phone

`--host 0.0.0.0` is the blunt way: the port is open to whatever else is on that
wifi, and you have to be on it.

The other way is to leave the deck on loopback and put something in front of it
that only your own devices can reach. [Tailscale](https://tailscale.com/download)
on this machine and on the phone is the short path — it builds a private
network between your devices, and works from anywhere, not just your wifi:

```
tailscale serve 4317                                       # forward the tailnet to the deck
SESSION_DECK_PUBLIC_URL=http://your-machine:4317 ./deck.sh start
```

`--public-url` is the same thing on the command line, and `PUBLIC_URL` also
works for a one-off start. The long name is the one worth exporting from a
shell profile: `PUBLIC_URL` on its own is read by other tools — Create React
App takes it as the base path for assets — so leaving that one set follows you
into every other project you build.

That second line is not optional decoration. The deck sees nothing but its own
loopback socket and has no way to learn that something is forwarding to it, so
without being told it concludes no device can reach it and draws no QR — which
is exactly the state that looks like a bug when the phone can reach it fine.
`--public-url` is how it finds out, and it is also the address that goes in the
QR, since `127.0.0.1` means the phone itself.

The same flag covers any other tunnel — ngrok, cloudflared, a reverse proxy in
front. Whatever address the other device types, that is the value.

**Settings → Pairing** has the link and the QR again for when the terminal has
scrolled away — the terminal prints them once, this page keeps them — and
**Revoke and re-key** for when a paired device is lost. Revoking
signs out every other device immediately and keeps the browser you clicked it
in — including dropping live connections, since a socket that was already open
would otherwise outlive the key that bought it.

The key lives in `~/.session-deck/auth.json`, readable only by you. Both pages
are shown only to the machine running the deck: a paired phone may drive the
deck, but handing it the key would let it pair devices of its own.

### Unlocking with a PIN

Off by default. **Settings → Pairing → Unlock PIN** sets one, and then the
locked page grows a box: a device that can reach the deck types the PIN and is
handed the same cookie the QR would have handed it. It is for the case the QR
cannot cover — a phone that was wiped, or one in your pocket while you are not
at the laptop to show it a code.

Be clear-eyed about the trade. The token is 256 bits and is not guessable. Six
digits is a million guesses, against a port that runs commands on this machine.
So the PIN is never what stands between an attacker and the deck — the throttle
is:

- Six digits minimum, digits only.
- Five wrong tries lock the PIN for a minute, then two, then four, doubling to
  an hour. The lock is checked before any hashing, so a flood of guesses cannot
  be turned into a way to load the machine.
- The count is global rather than per-IP, because per-IP is bypassed by anyone
  who can change address. A stranger can therefore lock the PIN — but never
  lock *you* out, since the link and QR on the pairing page keep working.
- Stored as scrypt with a per-PIN salt, never in the clear. Anyone who can read
  `auth.json` already has the token, so this is about the PIN you reused
  elsewhere, not about this deck.
- Setting or removing it is local-only, like the pairing page. A paired phone
  may drive the deck; choosing the credential that admits further devices is
  the one thing it is not allowed to do.
- **Revoke and re-key clears the PIN too.** You revoke because a device was
  lost, and that device knew the PIN as well as the link — re-keying while
  leaving the PIN standing would sign it out of one credential and leave it
  holding the other.

If you only ever reach the deck over Tailscale, this is a small addition to an
already-private path. On `--host 0.0.0.0` on a network you do not control, the
PIN is the whole of the door, and the throttle is the whole of the lock.

## Where the data comes from

None of this uses private APIs or patches Claude Code. It only reads what the
CLI already leaves on disk:

| Source | Contains |
|---|---|
| `~/.claude/sessions/<pid>.json` | One per live session: cwd, name, status, socket |
| `~/.claude/projects/<id>/<sessionId>.jsonl` | The conversation transcript |

Each session's status is the one it publishes itself: `busy`, `idle`, `shell`
or `waiting`. When it is `waiting`, the `waitingFor` field says why (for
example `permission prompt`).

## Portability

Runs on macOS, Windows and Linux. Everything that depends on the operating
system is isolated in **`src/platform.js`** — if something breaks when you
move machines, that is the only file to look at.

The five real differences between platforms:

| Concern | How it is handled |
|---|---|
| Project directory name | Never parsed. Treated as an opaque id; the real `cwd` is read from inside the JSON, which is identical on all three platforms. |
| Messaging socket | Read from the `messagingSocketPath` field, never constructed. Node connects the same way to a unix socket and a Windows named pipe. |
| Process alive or dead | `process.kill(pid, 0)`, which behaves the same everywhere. The output of `ps` is never parsed. |
| Ending someone else's process | `SIGTERM`, then `SIGKILL` on Unix. Windows has no graceful signal for a console process you did not start, so it is `taskkill /T /F`. |
| Native notification | The only per-platform branch: `osascript` on Mac, a PowerShell toast on Windows, `notify-send` on Linux. |

And one trap: on Windows the binary is `claude.cmd` and only starts with
`shell: true`. That is already handled in `spawnClaude()`.

> **What is actually verified.** The test suite and the build run on Windows,
> macOS and Linux on every push, against the two ends of the supported Node
> range. That covers the logic, and it is why the badge above means something.
>
> It does not cover the parts only a person can see: the native notification,
> the folder dialog, opening a terminal, and `deck.sh` itself, which is bash.
> Those are written per platform and exercised daily on macOS only. If you run
> the deck on Windows or Linux and one of them misbehaves, that is a real bug
> and worth an issue — you are the first person there.

## What it shows, and what it does not

The panel shows **the conversation**, not the execution log:

- What was said: your messages and Claude's replies
- Whether it is working right now, and with which tool

What it deliberately does **not** show:

- The commands it runs (`git status --short && ...`)
- Tool results, file reads, diffs
- Messages Claude Code injects into itself: command output, internal
  reminders, task notifications

That is noise when you just want to know how a project is going. If you need
that level of detail, it is in that session's terminal.

There is one exception, and it is a picture rather than a log: the **Files**
view.

### How full the context is

On the detail line of a session the deck launched, beside the path and the
branch, is a small bar and a percentage: how much of the context window the
conversation is using. It goes amber past 90%.

**It is not a warning.** Claude Code compacts the conversation on its own when
the window fills — it summarises what came before and the session carries on —
so there is no cliff to steer away from and the deck does not offer to start a
fresh session for you. That offer would trade a summary for total amnesia,
which is strictly worse than what happens if you ignore the bar entirely.

What the bar is for is that compaction is **silent and lossy**. Afterwards, the
fine detail of the last hour is a paragraph. Seeing 85% is what lets you land a
commit, or ask for the summary you actually want, before the session writes one
for you. Hovering says how many tokens that is, and whether auto-compaction is
on — with it off, the top of the bar is the end of the window rather than a
summary.

The reading is taken once per turn, when the session stops working, because
that is the only moment it changes. It comes from the SDK's own
`getContextUsage`, in its cheap mode: the summary answers from the last
response's usage rather than counting every category through the token-count
API, which is a network round trip per category and not what a bar in a header
is worth.

**Only sessions the deck started have one.** A session running in a terminal is
observed through the registry, not driven — there is no handle to ask it
through. The bar is absent rather than estimated, because a guess rendered in
the same place as a reading is indistinguishable from one.

## Watching one session

Every session header carries a **Chat / Agents** switch. Chat is the
conversation, as the session is writing it. Agents is what it delegated — a
subagent's work reaches the main transcript as a single summary line, and this
is the only place the rest of it can be read.

There were two more tabs, and a screen behind them. **Map** drew every file
the session had touched as a live treemap; **Timeline** drew the same events
as a story, one lane per file; and **All agents** was that map repeated for
every running session at once, busiest first. All three are gone.

They were not broken. They were an answer to "what is everything doing"
worked out from file activity, and the teams screen answers the same question
from the arrangement you declared when you raised the team — who hands out
the work, who talks to whom, who is waiting on you. When the two disagreed,
the arrangement was the right one. Deleting them took about 1,500 lines of
drawing code, a polling endpoint and a two-second timer with it. The history
is in git if the picture is ever wanted back.
## What needs you

The home screen is a queue, not a list of projects. Everything else in the
deck is organised by where things live; this is organised by whether it is
waiting on you, which is the question you open the panel to ask.

| Group | What lands there |
|---|---|
| **Blocked on you** | A session has stopped on a permission prompt |
| **Broken** | A pull request with failing checks |
| **Only on this machine** | Uncommitted or unpushed work — the stuff that actually gets lost |
| **Ready to move** | Pull requests green and not yet reviewed |
| **Forgotten** | Sessions nobody has touched in 12 hours or more |
| **Can be tidied** | Worktrees whose branch has landed |

Clicking a row goes where it can be dealt with: the session, the project, or
the pull request on GitHub.

### Answering without leaving the queue

A blocked row carries its permission with it — **Allow once**, **Always
allow**, **Deny**, right there under the row. Walking to the session to press
Allow on a `Bash(ls)` was the queue sending you somewhere to learn nothing.

Two things deliberately still send you to the session. A session the deck did
not launch has its prompt on its own TTY and there is nothing here to press.
And a **question** — `AskUserQuestion`, where Claude asks you to choose between
options it wrote — is a decision rather than a permission: the options mean
something only against the conversation they came out of, and answering one
from a list is how you pick the wrong option quickly. Those keep the trip,
which is the right amount of friction.

The card is the conversation's own card, reused rather than rebuilt, and it
reads the pending ask from the live socket rather than from the queue — the
queue is an HTTP snapshot, and answering the ask a stale row remembered would
be answering something the session has already moved past. A session with
several asks parked swaps the next one into place as you answer.

Opening the deck no longer jumps you into a session. Being dropped into one
conversation hides the other five things that also needed you — which is the
problem this panel exists to solve.

The queue reads git and gh across the whole workspace, so it runs on demand
with its own **Refresh**, never on the one-second tick. It does refresh itself
when a session becomes blocked, since that arrives over the socket anyway.

## The workspace

The sidebar is a workspace you define, not just a list of what happens to be
running. **Add folder** puts a project there for good, so it stays visible
whether or not anything is open in it — which is what makes it somewhere you
can launch work into rather than only watch.

**Add folder** opens a picker that browses the disk of the machine running the
deck: shortcuts along the top, a breadcrumb you can click back through, and a
list of folders where the ones that are git repositories say so. A single click
chooses a folder, a double-click opens it, and a line above the buttons always
spells out which folder **Add folder** is about to add. Folders already in the
workspace are marked rather than offered and then refused.

There are three ways in, because a folder picker is somewhere different people
arrive from different directions:

- **Browse** the list, which is the one that also works from a phone.
- **Choose in Finder…**, which hands over to the operating system's own dialog
  — your sidebar, your tags, your recent places. What comes back is selected in
  the list rather than added behind your back, so the same button still
  finishes the job. Cancelling says nothing.
- **Type a path**, when you already have it. `~` works.

The list exists at all because a browser cannot hand a web app a real path — a
file input gives contents and a relative name, never the folder on disk. Only
directory *names* cross the wire, and both browsing and the system dialog
refuse anything but a request from the machine running the deck: the first
because the shape of your home folder is yours, the second because it makes a
window appear on somebody's screen.

Each folder carries its own **+** button: a new task always starts in the
folder you clicked, so there is no project dropdown to get wrong.

Adding a subdirectory or a worktree adds the project it belongs to, so the
same codebase never appears twice.

Removing one is the same move in reverse: the **×** on the project row, or
**Stop tracking** in the project view. It drops the folder from the sidebar
and nothing else — the folder stays on disk, no file is touched, and a session
running in it keeps running, unwatched. The confirmation says so, because
"Remove" beside a folder name reads like "delete my code" to anyone who has
not read the source.

### What the deck watches, and what it ignores

The workspace is the whole answer. A session running in a folder you added
appears whoever started it — from here, from a terminal, from a VS Code window
— because what you added is the project, not the way work gets launched into
it. A session running anywhere else does not appear at all, and does not
notify you either: a repo you never added to the deck is one you have decided
not to be interrupted by, and an alert you cannot act on is worse than no
alert. That filter runs once, where the state is built, so the sidebar, the
inbox, the teams screen and the desktop notifier can never disagree about which
sessions exist.

The one thing that overrides it: a task **the deck itself launched** always
shows, even if its folder is not in the workspace — drop the folder while a
task is running in it and the project stays, marked **live**, until that task
ends. The deck started that session and owns its permission prompts, and a
prompt with nowhere to be answered is a session blocked for ever.

The workspace lives in `~/.session-deck/workspace.json`, not inside
`~/.claude`.

Each project folds shut with the chevron, and stays that way across reloads.
A folded project shows how many sessions are hidden inside it.

One rule overrides the fold: **a folded project cannot swallow an alert.**
When one of its sessions starts waiting on you, it opens itself. That fires
on the transition only, the same way the desktop notification does — it
nudges once, and if you fold it again it stays folded.

Collapse state is per-browser and lives in `localStorage`, so it never
leaves the machine you are looking at.

### The list does not move

Projects sit in the order you added them and sessions in the order they
started, and nothing that happens to a session changes where its row is.

It used to be the opposite. Urgency decided the order — a project with
something blocked floated to the top, a waiting session climbed above its
siblings, and a busy one drifted up every time it touched its file. It reads
well in a screenshot. In use it means the list rearranges itself exactly when
you are reaching for it: the row moves up as the ask arrives, and back down
as you answer it, so every permission prompt costs you your place twice and
the project you were half-way through reading is somewhere else by the time
you look up.

What is waiting on you is said instead of staged — the amber dot, the count on
the project, **What needs you**, the floating ask, the desktop notification.
None of those need the list to move, and a list that holds still is one you
learn by position and stop having to read.

The one exception is the fold above, which opens a collapsed project when
something inside it starts waiting. That is not reordering: nothing changes
places, a door opens.

## Permissions

Every launched session runs at one of four levels, picked in the launcher.
The choice is saved, so you set it once rather than on every launch.

| Mode | What it does |
|---|---|
| **Ask me** | Asks before anything your rules do not already allow. |
| **Auto-accept edits** | Writes and edits files without asking. Still asks before running commands. |
| **Auto** | A safety check approves routine actions on its own and only asks about risky ones. |
| **Never ask** | Runs everything without asking, including shell commands. |

**Auto-accept edits** is usually the one worth having: file writes are what
prompt most often, while shell commands — the ones actually worth a glance —
still stop for you.

**Auto** hands the decision to Claude Code's own classifier: a second model
reads each call, approves the routine ones and only sends you the ones it
judges risky. It is the one to pick where an organisation policy disables
`bypassPermissions` — there **Never ask** silently runs as **Ask me** (see
below), while **Auto** is still allowed and still runs without a card per
command.

These are the deck's own answer to each tool call, given before the session
ever reaches your rules, and for a long time they were not: the deck parked
every call and waited for you whatever you had picked, so **Never ask** asked.
It does not any more. The one thing no mode answers is a **question** —
AskUserQuestion arrives through the same channel as a permission, but its
answer is content only you have, and letting it through would hand the model a
blank where it asked something.

**Never ask** means what it says, including for a session the roadmap
launched: shell commands, network access, no prompts. A worktree keeps a
session's file changes off your branch; it is not a sandbox, and a command can
leave it.

You can also change the mode of a session that is already running, from the
control in its header. It takes effect immediately, without throwing away the
work in flight.

### A requested mode is not a granted mode

Some environments refuse `bypassPermissions` outright and quietly hand back
`default` instead. A panel that displayed the request would be telling you
permissions are off while they are still being enforced — the most dangerous
thing a permissions UI can do.

So the deck reads the mode the session reports at startup, shows that, and
says plainly when it is not what was asked for. When the refused request was
**Never ask**, the note also points at **Auto**.

### The ask comes to you

A prompt raised in one session while you are reading another used to cost a
round trip: leave the screen you were on, find the row, press Allow, find your
way back. The answer was one click and everything around it was the chore.

So the ask floats. Top right, over whatever you are looking at, with the
session's name, what it wants, and **Deny** / **Always** / **Allow once** on
it. You answer where you are, and the screen you were reading does not move.

What it deliberately does not do:

- **It never disappears on a timer.** This is not a notification about
  something that happened — it is a process stopped dead, waiting. A card that
  faded away on its own would leave it stopped for good. It goes when it is
  answered, or when you put it away with the ×, which says "not from here" and
  nothing else: the session stays blocked, the dot stays amber and the queue
  still counts it.
- **It does not show twice.** Not for the session already open in front of
  you — its own card is there in the conversation — and not on **What needs
  you**, which is the same queue with the same buttons on it.
- **It does not answer a question.** `AskUserQuestion` gets a card that says
  what is being asked and takes you to the conversation, for the same reason
  the queue does: the options mean something only against what they came out
  of. The same line, drawn in both places.
- **It does not offer what it cannot do.** A session running in somebody's
  terminal has its prompt on that TTY. There is nothing for a button here to
  send, so there is no button.

Past three at once it stops stacking and counts the rest, which takes you to
the queue. On a phone the cards sit under the top bar across the full width,
and step out of the way while the drawer is open.

### The other lever

When a prompt does appear, **Always allow** writes a rule so that action stops
asking in future sessions too. That is the durable fix for a specific command
you approve constantly, and it is narrower than turning the asking off
wholesale.

## Task shortcuts

There are things you type into every new session — "what were we doing here,
what is still pending" being the usual one. Those live as shortcuts above the
task box.

Clicking a shortcut starts it immediately. The pencil next to it loads it
into the box instead, for when you want to adjust it first. **Manage** lets
you delete them, and save whatever is in the box as a new one.

Because a shortcut runs on one click with no review step, the three shipped
by default are deliberately investigative — they read and report, they do not
change code. Anything that edits should be a shortcut you wrote yourself and
meant to run.

Shortcuts live in `~/.session-deck/presets.json`. **Reset** puts the shipped
ones back.

## The project view

Clicking a folder instead of a session shows the shape of the project:

- **Sessions** running in it
- **Running subagents**, by task title — a subagent is a Task tool call, and
  it is still running while no tool result has come back for it. To read what
  one is saying, open its session and take the **Agents** tab
- **Worktrees**, with their branch and which session is in each, whether or
  not anything is open there. Each has its own **New task** button, so you can
  launch straight into a worktree.

### Reading a subagent

The **Agents** tab on a session lists every subagent it has launched — running
ones first, with a live dot — and opens any of them as a conversation, in the
same shape the session's own chat is read in.

This was the deck's flatly documented limitation for months, and it was never
quite true: a subagent's messages are indeed absent from its parent's
transcript, but they are not missing. Each one keeps its own transcript beside
its parent's, and the SDK reads it by id (`getSubagentMessages`), which also
means it works on sessions the deck never launched.

Its role labels say `task` and `agent` rather than `you` and `claude`: the
first message in a delegated conversation has the user role, but you did not
write it — the session did. Its tool calls are counted rather than listed, the
same bargain the main conversation makes.

### The roadmap

The project header has an **Overview / Roadmap** switch. Overview is what is
happening in the project right now; the roadmap is what it is trying to get
done.

A roadmap is a goal, a list of milestones in order, and a decision about how
the finished work should land — each milestone merged as it finishes, or one
pull request with everything at the end. A milestone has a title for reading
ten of them at a glance and a *task* for acting on one: what a session would
be told to do, written so it stands on its own without the conversation it
came from. The first line of the goal is the roadmap's name, the same trade a
launched session makes with the first line of its task.

A project accumulates roadmaps, and they sort themselves into three tabs:

| Tab | What puts a roadmap here |
|---|---|
| **Planned** | nothing has happened to any of its milestones yet |
| **In progress** | one has been started, or moved off *To do* by hand |
| **Completed** | you said you were finished with it |

Two of the three are **read off the milestones every time, not stored**. A
state you set by hand is a state reality can contradict, and this screen has
already been wrong that way twice — a card claiming a worktree that had been
deleted, and one saying *working* over a session that had been waiting on you
for ten minutes. Completed is the exception because it is genuinely a
decision: "every milestone is done" is not the same as "I am finished with
this", and a roadmap you are abandoning is finished with too.

**Finishing with a roadmap offers to tidy up after it.** That moment is the
one time you know the work is over, so it is the right time to ask — and it
asks rather than assumes, showing what it would remove and why before
anything goes:

- a worktree nobody ever committed in, or one whose commits are already in the
  parent branch, is offered for removal, branch and all
- one with uncommitted changes, or commits that exist nowhere else, is kept,
  with the reason next to it
- one with a session still working in it is never touched, whatever else is
  true of it
- the branch is deleted with `git branch -d`, never `-D`: git refusing to
  delete an unmerged branch is exactly the check that belongs here

Completed roadmaps stay readable and can be reopened. Nothing is ever deleted
from the plan itself by finishing with it.

Two rules keep the screen from filling up, which is the only reason any of
this is here:

- **The open roadmap belongs to the tab it is in.** Finishing with one leaves
  the screen showing its tab's list and nothing else — it does not stay open
  underneath a tab that says nothing is in flight. Opening a finished roadmap
  takes a click on it, which is what an archive should cost. The one exception
  goes the other way: a write that moves a roadmap between states, like
  starting a milestone on a planned one, carries the tab along with it rather
  than having the thing you are working in vanish.
- **A milestone folds.** Done ones arrive folded, because a finished milestone
  is archive too: you want to see it is there and read its title, and the
  branch it used stopped mattering when it landed. The rest arrive open. The
  chevron is the deck's own, the same one the session header folds with.

The tabs never open on **Completed**. A project whose only roadmaps are
finished with opens on an empty *In progress* — that is the clear screen you
asked for by finishing with them.

Three things about it are deliberate:

- **The order is the dependency chain.** Until a milestone can declare what it
  actually depends on, the list read top to bottom is the only statement the
  roadmap makes about what has to happen before what — which is why moving one
  is a control and not a nicety.
- **Start gives a milestone somewhere to work, and nothing more.** It creates
  a worktree and a branch — `roadmap/<the milestone's title, slugged>`, in
  `.claude/worktrees/`, branched from the project's current HEAD, which is
  recorded so "what was this based on" has an answer later. No session is
  launched, nothing is committed and nothing is merged. It is the only step in
  the sequence that cannot lose you anything, which is why it is the one that
  exists first. The name shown before you press it is computed against the
  branches and directories that already exist, so it is the name that will
  actually be created.
- **The disk outranks the roadmap's memory.** A worktree deleted behind the
  deck's back — by hand, by the worktree cleanup, by a prune — shows as gone
  rather than as work in hand, and **Start again** checks the same branch back
  out at the same path instead of making a second one. If the branch is gone
  too there is nothing left to reattach to, and the milestone starts over.
- **Status is yours while nothing else can set it.** When the deck starts
  running milestones it takes `In progress` and `Done` over from facts about
  git, because a session falling idle is not the same thing as work being
  finished.

- **Run puts a session in that worktree**, with the milestone as its task. It
  is told four things: what the project is working towards, which milestone
  this is out of how many, the task itself, and where it is — its worktree, its
  branch and what that was cut from. It is also told what not to do: no
  merging, no pushing, no pull requests. How the work lands is decided on this
  screen and carried out by the deck, and a session that helpfully opens a pull
  request has taken a decision that cannot be un-taken from here. It runs in
  the deck's own default permission mode; the roadmap cannot carry a mode of
  its own, because "run the roadmap" must never be a way to widen privilege
  without seeing the word.
- **The card says what its session is doing**, and it polls while there is one
  to watch. A session blocked on a permission shows *needs you* — the deck's
  whole reason for existing is that this is impossible to miss — and its prompt
  is answered in the session, not here. A session that has ended says so, and
  leaves a way back to its transcript, which is the only record of how the
  milestone got where it is.

How far a milestone gets on its own is the permission mode's answer, not the
roadmap's — see **Permissions** below. In **Never ask** it runs to the end
without stopping; in **Auto-accept edits** it writes files freely and stops at
the first command; in **Ask me** it stops at everything. A question is the one
thing no mode answers, so a session that asks you something waits however it
was launched.

Two limits worth knowing before you lean on this. Nothing lands the work —
merging, pushing and pull requests are still yours to do by hand. And a
milestone started by mistake cannot be un-started from the panel: delete its
worktree and branch with git, and the card will say so.

Roadmaps live in the deck's own directory, not in the repository. A roadmap
kept in the repo would be checked out at a different version inside every
worktree it is about to create, and the one file that must not fork is the
plan. Writing one is local-only, the same rule the permission lists follow.

## Plans

A plan is whatever a project already writes down about what it is building.
The deck does not ask you to adopt a format: it reads the four conventions it
can recognise, and **never writes to any of them**.

| Convention | Where it looks |
|---|---|
| Implementation Plans | `docs/IPs/` |
| trellis contracts | `.trellis/profile.yml`, with `docs/contracts/` filed by state |
| deck plans | numbered Markdown files in `docs/plans/` |
| prose plans | `docs/implementation-plan/`, `docs/plans`, `docs/plan/` |

A repository that writes none of them is reported as writing none of them,
which is the one case where the deck can start a plan without stepping on
something. A repository that writes two is read twice: adopting a convention
rarely means deleting last year's.

Each plan keeps its native identifier beside the shared vocabulary rather than
instead of it. The board counts in `plan` and `milestone`; the card still says
the id you would search the repository for.

### Where you left off

The plans screen answers one question — where did I stop — and it answers it
from the execution log, not from a status somebody typed. Plans that keep one
come first, longest untouched at the top.

Plans with no log cannot answer it. They are not hidden, because a screen that
quietly drops two thirds of the work is lying; they drop to a folded section at
the bottom with their count in the open. Setting a plan aside is a filter over
what was found, never a delete, and the count above always says how many are
out of view.

## Worktree cleanup

Worktrees pile up. The project view says, for each one, whether the work in it
has actually landed — so you can tell the finished ones from the ones still
holding something.

| Flag | Means |
|---|---|
| `PR #132 merged` | The pull request for this branch was merged (needs `gh`) |
| `in origin/main` | Every commit here is already in the parent branch |
| `3 uncommitted` | Work in the working tree that exists nowhere else |
| `never pushed` | Commits here, no remote branch at all |
| `safe to delete` | Nothing above is holding it |

**Delete** appears only on worktrees where nothing is holding on. It runs
`git worktree remove` — never with `--force` — so git refusing is treated as
an answer rather than an obstacle. The branch is not touched, only the
directory.

### What counts as safe

Deliberately conservative, because "safe" has to mean safe: work that exists
only in that directory and nowhere else must never be one click from gone. A
worktree is deletable only when it is clean, fully pushed, and landed in the
parent.

**A worktree with a session running in it is never deletable**, however
finished the branch looks. git would happily remove it; pulling the floor out
from under a running session is not something a panel should help you do.

The check is repeated on the server before deleting, rather than trusting the
state the button was drawn from — that state may be minutes old. The path is
also checked against git's own list of worktrees for the repository, so a
request cannot name an arbitrary directory.

### Why this one shells out to git

The session registry reads files, because it refreshes every second and
spawning processes at that rate would be wasteful. Answering "has this branch
landed" means walking the commit graph, which is not something to hand-roll.
This runs from a click, on its own timer, cached for 30 seconds — the cost
lands where it is affordable.

Everything degrades: no `git`, no `gh`, no network, and you get fewer
answers rather than a broken view — and never a wrong "safe to delete".

## How sessions are grouped

By **repository**, not by directory. A git worktree, or a session opened in a
subdirectory, belongs to the project it came from — splitting those into
separate headings is what makes a list of sessions hard to read.

The repository root is found by walking up to `.git`. A normal checkout has
a `.git` directory; a worktree has a `.git` **file** holding
`gitdir: <main-repo>/.git/worktrees/<name>`, and that pointer is what leads
back to the project. Directories that are not in a repo at all group under
themselves.

This reads files rather than shelling out to `git`: spawning a process per
session per refresh would be slow, and `git` is not guaranteed to be on the
PATH of whatever machine the deck runs on.

Grouping never hides where a session actually is. A session below its project
root shows its location under its name — worktrees by name, subdirectories by
relative path.

## Two kinds of session

The deck treats sessions differently depending on where they were born, and
the difference is not cosmetic.

| | Started in a terminal | Started from the deck |
|---|---|---|
| Shows in the panel | yes | yes |
| Live status and transcript | yes | yes |
| Desktop notification when blocked | yes | yes |
| Answer a permission prompt here | **no** | **yes** |
| Send it a follow-up message here | not while it runs¹ | yes |
| Interrupt the turn it is on | no | yes |
| Kill it here | yes, by signal | yes |

¹ Once it is no longer running, it can be reopened here and becomes the second
kind — see *Reopening a session from the history*.

A terminal session's permission prompt lives on that terminal's TTY, so
nothing outside it can press "yes". Sessions launched from the deck run
through the Claude Agent SDK, where the deck owns the permission callback —
which is what turns the prompt into a button.

Deck-launched sessions are marked with a **deck** tag in the list.

### Killing a session the deck did not start

**Kill** is on every live session, whoever started it, and it always asks
first. What it does underneath is not the same on both sides. A deck session
is unwound: parked permissions are denied, the turn is interrupted, then the
transport closes. A session from a terminal has none of that — the only handle
on it is the pid it publishes, so it gets `SIGTERM`, and `SIGKILL` if it is
too wedged to answer within a few seconds. The terminal it was living in is
left at a dead prompt.

The deck will only ever signal a pid that is, at that moment, a live session
in Claude Code's own registry — not a number a stale panel remembered, and
never a process that is anything else. Its transcript is untouched, so it can
be resumed from a terminal with `claude --resume`.

A session that exits on its own removes its registration from
`~/.claude/sessions/`. One that had to be `SIGKILL`ed never got the chance, so
the deck removes it instead — the `<pid>.json` and the key file beside it, only
once that pid is confirmed dead. This is the single thing the deck writes
inside `~/.claude`, and it exists because leaving those files is not harmless:
the panel hides them while the pid is dead, and the day the system hands that
number to something else, a session that does not exist walks back into the
list.

This is the only thing that ends a session the deck did not start. Restarting
or quitting the deck takes its own sessions down with it and leaves everybody
else's running, which is the whole point of the distinction: the panel closing
must never cost you a terminal you had open.

## Launching a task

**New task** in the sidebar asks for a project and what you want done. The
project list is built from the transcripts on disk, so it is whatever you
have actually been working in lately.

The session loads the same `CLAUDE.md` and permission rules your terminal
sessions use (`settingSources: user, project, local`), so whatever
auto-allows there auto-allows here. You only get asked about what you would
have been asked about anyway.

### Naming a session

A launched session is called after the first line of its task, which is
usually the most useful thing it could be called — `multi-tasking-3a` tells
you nothing, "audit the invoice importer" tells you what it is doing.

It stops working when three sessions in the same repo open the same way, so
the launcher has an optional **Name**, and clicking the name in the
conversation header renames one that is already running. Leave it empty, or
clear it later, and the task line comes back.

That is the deck's own label, and it is not the only name a session has.
Claude Code keeps one too — the one in the session's own prompt box and in its
`/resume` picker, set with `claude -n <name>` at startup or `/rename` inside
the session. Clicking the name of a session the deck did **not** launch writes
that one, through the SDK's `renameSession`, which addresses the session's file
by id rather than the terminal that owns the process. So every session in the
panel can be renamed from the panel, whoever started it.

A session's **tag**, if it has one, shows next to its name. The deck can set
one too (`tagSession` over the same channel as the rename), but grouping the
sidebar by tag is not built — the tag is displayed, not yet organised by.

Two honest edges. A name set this way cannot be unset — Claude Code's record
of it has no empty state, so clearing the box leaves the name alone instead of
pretending, and only the deck's own label on a launched session goes back to
the task line when you empty it. And a name is a name because somebody set it: Claude Code
also derives a title for a session from its conversation, and the SDK reports
that derived title in the same field as the real one — so the deck reads the
`custom-title` record in the session file instead, and a session nobody has
named keeps the name the registry gave it, and the sidebar never shows you a
name you did not type.

## Teams and roles

A **role** is a standing brief. A task shortcut is not: "Review my changes" is
finished when the review is written, and the session that ran it has nothing
left to be. "Backend" is not finished when the migration lands — it is what
that session is *for* as long as the team exists, and it is what the others
address when they need the API explained.

So a role says how to behave rather than what to produce, and what it is
actually working on arrives separately, as the team's goal. Writing the task
into the role is how you end up with one role per project per sprint.

A **team** is the group you raised, and the project each seat sits in. What
gets written down is the smallest thing that answers *who is in this*: the
session ids, and who hands out the work. The name on screen, the project,
whether a session is busy or stopped or waiting on you — none of that is
stored, because all of it changes and none of it would stay true in a file. It
is looked up live from the session list.

### Two ways in

Composing a team by hand asks you to know the answer before you start: which
roles, how many, in which repositories, who dispatches. That is the right form
when you already know.

It is the wrong one straight after an analysis, when the session in front of
you has just spent three days measuring the thing and knows the shape of the
work better than the form does. So a session can propose a team instead. What
comes back is a **draft**, which a person reads and edits before anything is
raised — the deck does not let a session staff itself.

### Knowing who to ask

Every Claude Code session on this machine can already address every other one:
they publish themselves in `~/.claude/sessions`, and the channel was never
closed. What is missing is knowing that asking is an option, and who is worth
asking.

A session launched into a repository has no idea that the answer to "what does
Payments put on this event" is sitting in another process with that repository
already loaded. So it does the only thing it can, and reads fifty files to
rebuild a context that existed twenty metres away. The roster is the list each
new session is handed, so that it knows.

## Interrupting and killing

Two different things, deliberately kept apart and labelled as what they are:

- **Interrupt**, next to the reply box while a session is working, stops what
  it is doing right now. The session stays open and you can talk to it.
- **Kill**, in the conversation header, ends the session and its process.

Kill is not "close the input and hope". Closing the input stream only says no
more messages are coming — the CLI keeps working through whatever it had
already started, still editing files and still spending tokens, while the
panel cheerfully reports it as done. So the stop runs in order: answer any
parked permission (a session frozen inside `canUseTool` has no turn to
interrupt), interrupt the turn in flight, then end the query — the SDK's own
cleanup closes the transport, which ends the subprocess, and waits for it to
exit. Both control calls are raced against a deadline, because the thing being
killed is by definition the thing that stopped behaving.

Quitting the deck is no longer one of these. It **suspends** its sessions
rather than killing them — see *Restarting without losing the thread* below.

Only deck-launched sessions can be killed. A terminal session is a process the
deck never started, whose prompt lives on someone else's TTY — see *Two kinds
of session*.

## Restarting without losing the thread

Stopping the deck to pick up new code used to end its sessions for good. The
conversations stayed on disk, but the only thing that knew which conversation
belonged to which panel entry was a Map in memory, and that Map died with the
process. Every update turned work in flight into an archive nobody could type
into again.

Now a restart hands the sessions over instead:

1. **On the way out** each session is given up to 25 seconds to finish the
   turn it is on, because the part of a turn that never reaches the transcript
   is the part that cannot be resumed. Only then is the process ended, and a
   session still going at the deadline is interrupted rather than cut — the
   CLI picks the boundary. `SESSION_DECK_DRAIN_MS` moves that deadline, and a
   second Ctrl+C skips the wait.
2. **The sessions are written down** in `~/.session-deck/handoff.json`: the
   session id, the folder, the label, the mode. Continuously, not just on the
   way out — the exits that cost the most work are the ones that never run a
   shutdown handler, like `kill -9`, a crash, or a laptop that slept until the
   battery went.
3. **On the way back in** they return to the panel as **resumable**: listed,
   titled, attached to their transcript, with no process behind them. The next
   message you send is what starts one, resuming the conversation with
   everything it already knows, under the same session id and in the same
   transcript file.

Nothing is respawned automatically, which is the point: a restart that quietly
relaunched five CLIs would reload five conversations into context for a deck
you may only have restarted to pick up a CSS change. You choose which thread
to pull.

### Reopening a session from the history

The same machinery works on any conversation on disk, not only the ones the
deck was holding when it stopped. Open a past session from a project's history
and it offers **Reopen here**: the deck takes charge of it and it becomes a
session you can type into, approve permissions for, and interrupt — with its
full context.

This is what finally erases the oldest limitation in the panel. A session the
deck did not launch was readable and nothing else. Now it is readable, and
once it stops running it can be picked up.

The one case it refuses is a session that is **live in a terminal right now**.
Resuming that would put a second process on a conversation still being
written, each appending without seeing the other. The button is hidden for
those, and the server refuses the request as well — the button is not the only
way that message can arrive.

## Permissions

When a launched session needs approval, a card appears in the conversation
with **Deny**, **Always allow** and **Allow once**.

Two things the SDK asks for and the card honours instead of styling away:

- Some requests must not be approvable by a stray keystroke. Those render in
  red with no primary button, so approving takes a deliberate click.
- Some requests must not offer "always allow", because the rule it would
  write grants more than the single action being asked about. The button is
  simply absent there.

A parked permission is never auto-answered on a timer. The SDK is explicit
that an unanswered prompt blocks the tool indefinitely, and silently allowing
or denying because a clock ran out would be worse than waiting. It resolves
only on your answer, on abort, or when you stop the session.

## Signing in

**Settings → Accounts** lists every identity the deck borrows, and the first
row is Claude itself. That row exists because it was the one thing the panel
depended on absolutely and never mentioned: the deck does not talk to the API,
it drives the `claude` binary, so a logged-out CLI means every session you
launch dies — and it dies silently, because the CLI wants a browser and a
terminal and it is running inside a subprocess that has neither.

The state comes from `claude auth status`, not from guessing at where
credentials are kept. That matters more than it sounds: on this Mac they are in
the Keychain and there is no `~/.claude/.credentials.json` at all, while
`~/.claude.json` keeps an account block that survives a logout. The CLI is the
only thing entitled to say which credential actually wins.

**Sign in** opens a terminal on `claude auth login`, the same handoff the
GitHub and Azure rows use. The panel never performs a login itself — the
official CLI stays the only keystore.

More states than the two you would expect, and the extra ones all exist to
avoid the same mistake — offering to fix an account that was never broken is
worse than saying nothing:

| State | What it means | Button? |
|---|---|---|
| `in` | signed in, and the identity is named | no |
| `out` | installed, logged out. The one that stops the deck | **Sign in** |
| `missing` | the CLI is not on PATH | no — install it |
| `provider` | Bedrock or Vertex; credentials belong to AWS or GCP | no |
| `unknown` | the CLI answered something unrecognised | no |

Only the signed-in answer is cached. The other four are the states somebody is
in the middle of changing, they cost a third of a second to re-establish, and
holding one for ten minutes is how a panel ends up showing a red dot over an
account that started working five minutes ago.

## Current state

Read-only observation and full control of deck-launched sessions both work,
and a session that is not running can be reopened here whoever started it. The
deck also survives its own restart: it hands its sessions over to the next
start rather than ending them.

The remaining gap is by design and not fixable from outside: an already-open
terminal session cannot have its prompt answered here, because that prompt
lives on its own TTY.

## Development

```
npm run dev    # server on 4317 + Vite with hot reload on 5317
npm test       # node --test
```

Pairing does not get in the way here. Vite runs on the same machine, under the
same user, so its proxy reads the key off disk and presents it on every call it
forwards — a browser you reload forty times an hour is not a browser worth
pairing. It only ever reads: two processes racing to mint a token would leave
the server holding a different one from the file.

## Architecture

The spine:

```
src/cli.js          the session-deck command
src/server.js       HTTP + WebSocket, notifications
src/platform.js     everything OS-specific (the only file to check when porting)
src/auth.js         the pairing key, and who is allowed to ask anything at all
src/claude-auth.js  is the CLI signed in — the one identity the deck cannot run without
```

Reading what is already on the machine. None of this writes:

```
src/sessions.js       live registry: read, drop dead PIDs, group, watch
src/session-store.js  the session files, addressed by id
src/transcripts.js    index the .jsonl files, read them, follow them by offset
src/activity.js       tool calls -> file events, for the working indicator
src/live-agents.js    the subagents a managed session has running right now
src/projects.js       repository root, worktree list, branches
src/files.js          the project's own files, for the Files tab
src/workspace.js      the folders you added, persisted to ~/.session-deck
src/browse.js         directory listing for the folder picker, local requests only
src/mcp.js            which MCP servers this workspace has, and which are authenticated
```

Driving the sessions the deck started:

```
src/agent.js        the control plane: sessions the deck launches and drives
src/choices.js      the model, the effort and the advisor a session starts with
src/permissions.js  the rules that decide what a session stops to ask about
src/settings.js     deck preferences, including the permission mode
src/presets.js      saved task shortcuts
src/inbox.js        the triage queue: everything waiting on you, ranked
src/progress.js     the checklist a session keeps about its own work
```

More than one session at a time:

```
src/teams.js          the groups you raised, written down
src/roles.js          the jobs you put people in, not the errands you send them on
src/teamproposal.js   a team, proposed by a session that did the work
src/roster.js         who a new session is told it can ask
src/meeting.js        the conversations sessions have with each other
src/handoff.js        what the deck hands over to its own successor
src/handoff-notes.js  the notes one session leaves for the next
```

Plans, and the repository underneath:

```
src/plans.js        how each project writes down what it is trying to build
src/git.js          the one way this deck runs git
src/worktree-status.js  has this branch landed? the one place git is shelled out to
src/pull.js         bringing a project up to date with its remote, from a button
src/forges.js       where a repository's pull requests actually live
src/ado-identity.js which Azure DevOps identity a project actually works as
```

```
web/                React interface
test/               node --test; the gate is covered from both sides
```

## License

MIT — the full text is in [LICENSE](LICENSE). Copyright (c) 2026 Lusoft LLC.

Use it, change it, ship it inside something commercial if you want. The one
condition is that the copyright notice and the licence text travel with any
copy or substantial portion you pass on.
