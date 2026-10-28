#!/bin/sh
# SessionStart hook: prints a compact summary of the experiment records under
# lab/<batch>/ to stdout, which Claude Code adds to the session's context,
# grouped by batch with each batch's branch. Prints nothing when the project
# has no lab/ folder. POSIX sh and awk only.

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
[ -d lab ] || exit 0

# On main or master with local batch branches present, name them. Read-only git.
branch_hint() {
  cur=$(git symbolic-ref --short -q HEAD 2>/dev/null) || return 0
  case "$cur" in main | master) ;; *) return 0 ;; esac
  exps=$(git branch --list 'exp/*' --format='%(refname:short)' 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')
  [ -n "$exps" ] || return 0
  echo "experiment-conductor: this session is on $cur and the local batch branches are $exps. Switch to your batch branch before reading or writing records."
}

# Every Markdown file in a batch folder is a record, except the batch README.
# An empty record reaches awk as no lines at all, so it is named here.
set --
empty=""
for f in lab/*/*.md; do
  [ -f "$f" ] || continue
  case "$f" in */README.md) continue ;; esac
  if [ -s "$f" ]; then set -- "$@" "$f"; else empty="$empty $f"; fi
done
if [ $# -eq 0 ] && [ -z "$empty" ]; then
  echo "experiment-conductor: lab/ holds no experiment records yet."
  branch_hint
  exit 0
fi

[ $# -eq 0 ] && set -- /dev/null
awk -v empty="$empty" '
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function unquote(s) { s = trim(s); gsub(/^["\047]|["\047]$/, "", s); return s }
function value(line) {
  sub(/^[A-Za-z_]+:[ \t]*/, "", line)
  sub(/[ \t]+#.*$/, "", line)
  return trim(line)
}
function lastjob(list,   n, parts) {
  gsub(/[][]/, "", list)
  n = split(list, parts, ",")
  while (n > 0 && unquote(parts[n]) == "") n--
  return n > 0 ? unquote(parts[n]) : ""
}
function finish(   label, b) {
  if (path == "") return
  total++
  if (fm < 2 || id == "" || !(status in count)) {
    bad = bad "\n  " path
    return
  }
  count[status]++
  b = batch
  if (!(b in seen)) { seen[b] = 1; nb++; border[nb] = b }
  bcount[b, status]++
  label = id " " title
  if (status == "running") {
    attn[b] = attn[b] "\n  running: " label " (job " (job == "" ? "unknown" : job) ")"
  }
  if (review == "awaiting-analysis") attn[b] = attn[b] "\n  awaiting analysis: " label
  if (status == "needs-decision") attn[b] = attn[b] "\n  needs decision: " label (reason == "" ? "" : " - " reason)
  if (status == "failed" && review !~ /^(supported|refuted|inconclusive)$/) attn[b] = attn[b] "\n  failed: " label (reason == "" ? "" : " - " reason)
}
BEGIN {
  ne = split(empty, eparts, " ")
  for (i = 1; i <= ne; i++) { total++; bad = bad "\n  " eparts[i] }
  n = split("proposed ready running done failed needs-decision", order, " ")
  for (i = 1; i <= n; i++) count[order[i]] = 0
}
FILENAME == "/dev/null" { next }
FNR == 1 {
  finish()
  path = FILENAME
  batch = path; sub(/^lab\//, "", batch); sub(/\/[^\/]*$/, "", batch)
  id = ""; title = ""; status = ""; review = ""; job = ""; reason = ""
  fm = 0; section = ""; injobs = 0
  if ($0 !~ /^---[ \t]*\r?$/) fm = -1
}
{ sub(/\r$/, "") }
fm == -1 { next }
/^---[ \t]*$/ && fm < 2 { fm++; next }
fm == 1 {
  if (injobs && $0 ~ /^[ \t]*-[ \t]*/) {
    item = $0; sub(/^[ \t]*-[ \t]*/, "", item); sub(/[ \t]+#.*$/, "", item)
    if (unquote(item) != "") job = unquote(item)
    next
  }
  injobs = 0
  if ($0 ~ /^id:/) id = value($0)
  else if ($0 ~ /^title:/) title = value($0)
  else if ($0 ~ /^status:/) status = value($0)
  else if ($0 ~ /^review:/) review = value($0)
  else if ($0 ~ /^jobs:/) {
    v = value($0)
    if (v == "") injobs = 1; else job = lastjob(v)
  }
  next
}
/^## / { section = $0; sub(/^## +/, "", section); sub(/[ \t]+#.*$/, "", section); next }
section == "Attempts" && /^- / {
  # The outcome is the second to last field; the log path is the last.
  k = split($0, f, "[ \t]*[|][ \t]*")
  reason = (k >= 3) ? trim(f[k - 1]) : ""
}
END {
  finish()
  printf "experiment-conductor: lab/ holds %d records in %d %s.\n", total, nb, (nb == 1 ? "batch" : "batches")
  line = "By status:"
  for (i = 1; i <= n; i++) line = line " " order[i] " " count[order[i]] (i < n ? "," : "")
  print line
  for (j = 1; j <= nb; j++) {
    b = border[j]
    line = ""
    for (i = 1; i <= n; i++) if (bcount[b, order[i]] > 0) line = line (line == "" ? "" : ", ") order[i] " " bcount[b, order[i]]
    print "Batch " b " on branch exp/" b ": " line attn[b]
  }
  if (bad != "") print "Unrecognized records (missing or malformed front matter, or an unknown status):" bad
  print "Follow the experiment-protocol skill: work on the batch branch, check every running job with the scheduler, and make your first message the status report (what finished, what is running, what comes next, and any stale status you will correct) before changing anything."
}
' "$@"
branch_hint
exit 0
