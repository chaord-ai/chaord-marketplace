#!/bin/sh
# SessionStart hook: prints a compact summary of lab/experiments/ to stdout,
# which Claude Code adds to the session's context. Prints nothing when the
# project has no lab/experiments/ folder. POSIX sh and awk only.

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
[ -d lab/experiments ] || exit 0

set -- lab/experiments/*.md
if [ ! -f "$1" ]; then
  echo "experiment-conductor: lab/experiments/ holds no records yet."
  exit 0
fi

awk '
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function value(line) {
  sub(/^[A-Za-z_]+:[ \t]*/, "", line)
  sub(/[ \t]+#.*$/, "", line)
  return trim(line)
}
function lastjob(list,   n, parts) {
  gsub(/[][]/, "", list)
  n = split(list, parts, ",")
  while (n > 0 && trim(parts[n]) == "") n--
  return n > 0 ? trim(parts[n]) : ""
}
function finish() {
  if (fname == "") return
  if (id == "") id = fname
  total++
  if (status in count) count[status]++; else other++
  label = id " " title
  if (status == "running") {
    running = running "\n  " label " (job " (job == "" ? "unknown" : job) ")"
  }
  if (review == "awaiting-analysis") awaiting = awaiting "\n  " label
  if (status == "needs-decision") decision = decision "\n  " label (reason == "" ? "" : " - " reason)
  if (status == "failed") failed = failed "\n  " label (reason == "" ? "" : " - " reason)
}
BEGIN {
  n = split("proposed ready running done failed needs-decision", order, " ")
  for (i = 1; i <= n; i++) count[order[i]] = 0
}
FNR == 1 {
  finish()
  fname = FILENAME; sub(/^.*\//, "", fname); sub(/\.md$/, "", fname)
  id = ""; title = ""; status = ""; review = ""; job = ""; reason = ""
  fm = 0; section = ""
}
{ sub(/\r$/, "") }
/^---[ \t]*$/ && fm < 2 { fm++; next }
fm == 1 {
  if ($0 ~ /^id:/) id = value($0)
  else if ($0 ~ /^title:/) title = value($0)
  else if ($0 ~ /^status:/) status = value($0)
  else if ($0 ~ /^review:/) review = value($0)
  else if ($0 ~ /^jobs:/) job = lastjob(value($0))
  next
}
/^## / { section = $0; sub(/^## +/, "", section); sub(/[ \t]+#.*$/, "", section); next }
section == "Attempts" && /^- / {
  k = split($0, f, "[ \t]*[|][ \t]*")
  reason = (k >= 4) ? trim(f[4]) : ""
}
END {
  finish()
  printf "experiment-conductor: lab/experiments/ holds %d records.\n", total
  line = "By status:"
  for (i = 1; i <= n; i++) line = line " " order[i] " " count[order[i]] (i < n ? "," : "")
  if (other > 0) line = line ", unrecognized " other
  print line
  print "Running:" (running == "" ? " none" : running)
  print "Awaiting analysis:" (awaiting == "" ? " none" : awaiting)
  print "Needs decision:" (decision == "" ? " none" : decision)
  print "Failed:" (failed == "" ? " none" : failed)
  print "Follow the experiment-protocol skill: check every running job with the scheduler, fix stale statuses, then tell the user what finished, what is running and what comes next before acting."
}
' "$@"
exit 0
