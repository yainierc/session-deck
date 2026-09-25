#!/bin/bash
#
# deck.sh — start/stop session-deck in the background, independent of
# VS Code and of the terminal you launch it from.
#
#   ./deck.sh start     bring the server up and open the browser
#   ./deck.sh stop      shut it down
#   ./deck.sh restart   restart it (after a code change)
#   ./deck.sh status    say whether it is alive, and on which URL
#   ./deck.sh logs      follow the log live (ctrl+c to leave)
#   ./deck.sh build     rebuild the UI and restart
#
# Optional variables:
#   PORT=4400 ./deck.sh start
#   PUBLIC_URL=http://my-machine:4317 ./deck.sh start   (if something serves
#   it from in front: a tunnel, tailscale serve. It is what makes the QR show.)
#   SESSION_DECK_PUBLIC_URL   the same, under its own name: this is the one
#   worth leaving in your .zshrc, because bare PUBLIC_URL is read by other
#   tools and exporting it follows you into every other project.

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-4317}"
# If something is serving the deck from in front -- a tunnel, tailscale serve --
# this is where you tell it where it answers, which is the one thing it cannot
# work out on its own. Without this it still starts, but with no QR to offer.
#
# Two names on purpose. PUBLIC_URL does for a one-off start, but not for
# leaving in a profile: it is a name other tools already use -- Create React
# App reads it as the base for assets -- and exporting it there puts it in
# every project the user has. The specific one is what survives in a .zshrc
# without side effects, and that is why it wins.
PUBLIC_URL="${SESSION_DECK_PUBLIC_URL:-${PUBLIC_URL:-}}"
LOG="/tmp/session-deck.log"
PIDFILE="/tmp/session-deck.pid"

# If node is not on the PATH (which happens when launching from Finder or
# launchd), look for it in nvm before giving up.
if ! command -v node >/dev/null 2>&1; then
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: cannot find node on the PATH" >&2
  exit 1
fi

# Find the server even when we were not the ones who started it: an earlier
# nohup, or an orphan left over from another session, leaves no pidfile, and
# used to make us start a second process on top of the busy port.
running_pid() {
  local pid
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"; return 0
    fi
  fi
  pid="$(pgrep -f "src/cli\.js.*--port $PORT" 2>/dev/null | head -1)"
  [ -z "$pid" ] && pid="$(pgrep -f "src/cli\.js" 2>/dev/null | head -1)"
  [ -n "$pid" ] || return 1
  echo "$pid"
}

# The server moves up a port on its own if its own one is busy, so the real URL
# is read from the log; if the log is no use (an orphan server) we find it by
# probing the range of ports it could have picked.
# Loopback only, and on purpose. With PUBLIC_URL the log ends with the public
# address, and that one is for the other devices: opening it here is a change
# of origin, which is to say of cookie, and a browser that was already paired
# lands on the lock screen without having lost anything.
current_url() {
  local url p
  url="$(grep -o 'http://127\.0\.0\.1:[0-9]*' "$LOG" 2>/dev/null | tail -1)"
  if [ -n "$url" ] && curl -s -o /dev/null --max-time 1 "$url/api/health"; then
    echo "$url"; return 0
  fi
  for p in $(seq "$PORT" $((PORT + 10))); do
    if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/api/health"; then
      echo "http://127.0.0.1:$p"; return 0
    fi
  done
  return 1
}

# The link carrying the key, to open it the first time. It doubles as the way
# back: the token is traded for a cookie and disappears from the address bar.
pairing_url() {
  local url
  # The status of a `grep | tail` is tail's, which is 0 even when grep found
  # nothing, so the empty case has to be checked by hand or the caller ends up
  # opening an empty string believing we handed it a URL.
  url="$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | tail -1)"
  [ -n "$url" ] || return 1
  echo "$url"
}

start() {
  local pid url
  if pid="$(running_pid)"; then
    url="$(current_url)" || url="(not answering, try ./deck.sh restart)"
    echo "already running (pid $pid)  ->  $url"
    return 0
  fi

  if [ ! -f "$DIR/dist/index.html" ]; then
    echo "no build yet, compiling..."
    (cd "$DIR" && npm run build) || return 1
  fi

  : > "$LOG"
  # The & has to apply to node alone. With `cd ... && nohup node ... &` bash
  # forks a wrapper subshell: $! returned the wrapper's pid, stop killed that
  # one and left node orphaned, and the wrapper went on holding the output of
  # whoever called the script.
  (
    cd "$DIR" || exit 1
    # The array keeps the argument off the line when there is no value:
    # passing --public-url "" aborts the start with an invalid url.
    #
    # The odd expansion is mandatory, not decoration. The bash macOS ships is
    # 3.2, and there "${extra[@]}" with an empty array counts as an undefined
    # variable: under set -u the script dies before starting anything. The
    # ${x[@]+...} form expands only if it exists, and it is the only thing that
    # behaves the same on 3.2 and on modern bash, where the empty case is no
    # longer an error.
    extra=()
    [ -n "$PUBLIC_URL" ] && extra=(--public-url "$PUBLIC_URL")
    nohup node src/cli.js --no-open --port "$PORT" "${extra[@]+"${extra[@]}"}" < /dev/null >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
  )

  # Wait for it to actually come up before declaring victory.
  for _ in $(seq 1 30); do
    if url="$(current_url)"; then
      echo "session-deck started (pid $(cat "$PIDFILE"))  ->  $url"
      command -v open >/dev/null 2>&1 && open "$(pairing_url || echo "$url")"
      return 0
    fi
    sleep 0.3
  done

  echo "did not start. last lines of the log:" >&2
  tail -20 "$LOG" >&2
  rm -f "$PIDFILE"
  return 1
}

# How long we give the server to shut down nicely.
#
# On SIGTERM it does not die: it waits for each session to finish the turn it
# has half-done and notes which ones they were, so the next start can offer
# them back. That note is exactly what a premature kill -9 destroys, so this
# margin has to be larger than its own (SESSION_DECK_DRAIN_MS, 25s by default).
GRACE_SECS="${DECK_GRACE_SECS:-40}"

stop() {
  local pid killed=0 waited
  # In a loop: there can be more than one live instance (orphans of earlier
  # starts), and leaving a single one loose is what broke the next start.
  while pid="$(running_pid)"; do
    kill "$pid" 2>/dev/null
    waited=0
    while kill -0 "$pid" 2>/dev/null; do
      # 5 a second: the whole loop is GRACE_SECS on the clock.
      [ "$waited" -ge $((GRACE_SECS * 5)) ] && break
      # A single line, so it is visible that it is waiting and not hung.
      if [ "$waited" -eq 15 ]; then
        printf 'waiting for sessions to close their turn (up to %ss)...\n' "$GRACE_SECS"
      fi
      sleep 0.2
      waited=$((waited + 1))
    done
    kill -9 "$pid" 2>/dev/null
    killed=$((killed + 1))
    [ "$killed" -ge 5 ] && break
  done
  rm -f "$PIDFILE"
  if [ "$killed" -gt 0 ]; then
    echo "session-deck stopped ($killed process(es))"
  else
    echo "was not running"
  fi
}

status() {
  local pid url
  if pid="$(running_pid)"; then
    url="$(current_url)" || url="(not answering)"
    echo "running (pid $pid)  ->  $url"
  else
    echo "stopped"
    return 1
  fi
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    tail -f "$LOG" ;;
  build)   (cd "$DIR" && npm run build) && { stop; start; } ;;
  *)       sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
