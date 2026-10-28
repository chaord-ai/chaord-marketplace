#!/bin/sh
# Acceptance run for experiment-conductor. Drives the Researcher and the
# Executor headless (claude -p --agent) through one fixed batch in a fresh
# scratch git repository, stops the first Executor mid-batch and resumes with
# a second one, asks an agent to commit on main, then checks the records and
# the git history mechanically. Prints a pass or fail table, leaves the scratch
# repository in place, and exits non-zero when any check fails.
# POSIX sh, awk, sed, grep and git, so it runs on a cluster login node.

set -u

usage() {
  cat <<'EOF'
Usage: sh run.sh (--local | --partition NAME) [--model MODEL] [--workdir DIR]

  --local           run jobs as plain processes on this machine
  --partition NAME  submit jobs to this SLURM partition
  --model MODEL     model passed to claude (for example sonnet)
  --workdir DIR     new or empty directory for the run (default: a new
                    ec-acceptance.XXXXXX in the current directory; on SLURM
                    it must be on a filesystem the compute nodes can read)

Exit status: 0 when every check passes, 1 when a check fails, 2 when the
run itself could not be carried out.
EOF
}

die() { echo "run.sh: $*" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
plugin=$(cd "$here/../.." && pwd)
prompts=$here/prompts.txt

mode= partition= model= workdir=
while [ $# -gt 0 ]; do
  case $1 in
    --local) mode=local ;;
    --partition) [ $# -ge 2 ] || die "--partition needs a value"; mode=slurm; partition=$2; shift ;;
    --partition=*) mode=slurm; partition=${1#*=} ;;
    --model) [ $# -ge 2 ] || die "--model needs a value"; model=$2; shift ;;
    --model=*) model=${1#*=} ;;
    --workdir) [ $# -ge 2 ] || die "--workdir needs a value"; workdir=$2; shift ;;
    --workdir=*) workdir=${1#*=} ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$mode" ] || { usage >&2; exit 2; }
[ "$mode" = local ] || [ -n "$partition" ] || die "--partition needs a value"
command -v claude >/dev/null 2>&1 || die "claude is not on PATH"
command -v git >/dev/null 2>&1 || die "git is not on PATH"
if [ "$mode" = slurm ]; then
  for t in sbatch squeue sacct; do
    command -v "$t" >/dev/null 2>&1 || die "$t is not on PATH"
  done
fi
[ -f "$prompts" ] || die "missing $prompts"

# Per-role time limits in seconds.
t_propose=600 t_run=900 t_continue=1500 t_report=600 t_guard=240

if [ -n "$workdir" ]; then
  mkdir -p "$workdir" || die "cannot create $workdir"
  [ -z "$(ls -A "$workdir")" ] || die "$workdir is not empty"
  work=$(cd "$workdir" && pwd)
else
  work=$(mktemp -d "$PWD/ec-acceptance.XXXXXX") || die "cannot create a work directory"
fi
repo=$work/repo
logs=$work/logs
results=$work/results.txt
mkdir -p "$repo" "$logs" || die "cannot create $repo"
: >"$results"
started=$(date +%s)

say() { echo "[$(date '+%H:%M:%S')] $*"; }
result() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$results"; }

# ---------------------------------------------------------------- scratch repo

say "work directory $work"
git -C "$repo" init -q -b main 2>/dev/null || {
  git -C "$repo" init -q && git -C "$repo" symbolic-ref HEAD refs/heads/main
} || die "git init failed"
git -C "$repo" config user.name "acceptance run"
git -C "$repo" config user.email "acceptance-run@example.invalid"
git -C "$repo" config commit.gpgsign false

cat >"$repo/train.sh" <<'EOF'
#!/bin/sh
# Toy trainer for the experiment-conductor acceptance run.
# Usage: sh train.sh --out DIR [--steps N] [--step-seconds S] [--lr X] [--init FILE]
# Prints one line per step and writes DIR/model.txt and DIR/metrics.json
# ({"accuracy": A}) at the end. Accuracy is 0.80 from scratch and 0.85 when
# started from a model.txt with --init. A learning rate above 1 diverges at
# step 3 and exits 1. A missing --init file exits 2.
out= steps=8 step_seconds=1 lr=0.1 init=
while [ $# -gt 0 ]; do
  case $1 in
    --out) out=$2; shift ;;
    --steps) steps=$2; shift ;;
    --step-seconds) step_seconds=$2; shift ;;
    --lr) lr=$2; shift ;;
    --init) init=$2; shift ;;
    *) echo "train.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$out" ] || { echo "train.sh: --out is required" >&2; exit 2; }
if [ -n "$init" ] && [ ! -f "$init" ]; then
  echo "train.sh: init checkpoint $init not found" >&2; exit 2
fi
mkdir -p "$out" || exit 2
acc=0.80
[ -n "$init" ] && acc=0.85
i=1
while [ "$i" -le "$steps" ]; do
  sleep "$step_seconds"
  if [ "$i" -ge 3 ] && awk -v lr="$lr" 'BEGIN { exit !(lr > 1) }'; then
    echo "step $i: loss is nan, training diverged at learning rate $lr" >&2
    exit 1
  fi
  echo "step $i/$steps: loss $(awk -v i="$i" 'BEGIN { printf "%.3f", 1 / (i + 1) }')"
  i=$((i + 1))
done
echo "trained $steps steps at learning rate $lr" >"$out/model.txt"
printf '{"accuracy": %s}\n' "$acc" >"$out/metrics.json"
echo "done: accuracy $acc"
EOF

mkdir -p "$repo/bin"
cat >"$repo/bin/with-limit" <<'EOF'
#!/bin/sh
# Usage: sh bin/with-limit SECONDS COMMAND...
# Runs COMMAND under a wall-time limit. When the limit is reached it stops the
# command, prints a message to stderr and exits 124; otherwise it exits with
# the command's status.
limit=$1; shift
mark=$(mktemp "${TMPDIR:-/tmp}/with-limit.XXXXXX") || exit 125
"$@" &
child=$!
(
  n=0
  while [ "$n" -lt "$limit" ] && kill -0 "$child" 2>/dev/null; do sleep 1; n=$((n + 1)); done
  if kill -0 "$child" 2>/dev/null; then echo timeout >"$mark"; kill "$child" 2>/dev/null; fi
) &
wait "$child"
rc=$?
if [ -s "$mark" ]; then
  rm -f "$mark"
  echo "with-limit: wall-time limit of $limit seconds reached, job stopped" >&2
  exit 124
fi
rm -f "$mark"
exit "$rc"
EOF

cat >"$repo/README.md" <<'EOF'
# Toy project

A scratch project for the experiment-conductor acceptance run. train.sh is a
toy trainer and bin/with-limit runs a command under a wall-time limit. Run
outputs go under runs/ and logs under logs/, and neither is committed.
EOF
printf 'runs/\nlogs/\n' >"$repo/.gitignore"
git -C "$repo" add README.md .gitignore train.sh bin/with-limit || die "git add failed"
git -C "$repo" commit -q -m "initial commit" || die "initial commit failed"
initial=$(git -C "$repo" rev-parse HEAD)

# ------------------------------------------------------------------- helpers

# Prints the section $1 of prompts.txt with the placeholders replaced.
prompt() {
  awk -v want="$1" -v res="resources-$mode" -v part="$partition" -v batch="${batch:-}" '
  function repl(s, from, to,   out, i) {
    out = ""
    while ((i = index(s, from)) > 0) { out = out substr(s, 1, i - 1) to; s = substr(s, i + length(from)) }
    return out s
  }
  function trim(s) { sub(/^\n+/, "", s); sub(/\n+$/, "", s); return s }
  /^\[[a-z-]+\]$/ { name = substr($0, 2, length($0) - 2); next }
  name != "" { body[name] = body[name] $0 "\n" }
  END {
    t = trim(body[want])
    if (t == "") exit 1
    t = repl(t, "@RESOURCES@", trim(body[res]))
    t = repl(t, "@PARTITION@", part)
    t = repl(t, "@BATCH@", batch)
    print t
  }' "$prompts"
}

# Prints the value of front-matter key $2 in record $1, without its comment.
fm() {
  awk -v k="$2" '
  NR == 1 && $0 == "---" { on = 1; next }
  on && $0 == "---" { exit }
  on && index($0, k ":") == 1 {
    v = substr($0, length(k) + 2); sub(/[ \t]+#.*$/, "", v)
    gsub(/^[ \t]+|[ \t]+$/, "", v); print v; exit
  }' "$1"
}

# Prints the attempt lines of record $1.
attempts() {
  awk '/^## / { on = ($0 ~ /^## Attempts/); next } on && /^- /' "$1"
}

# Prints the value of the attempt-line field that starts with "$2 ".
afield() {
  printf '%s\n' "$1" | awk -v p="$2" -F ' [|] ' '{
    for (i = 1; i <= NF; i++) {
      f = $i; sub(/^- /, "", f); sub(/^[ \t]+/, "", f)
      if (index(f, p " ") == 1) { print substr(f, length(p) + 2); exit }
    }
  }'
}

# Prints the date and time of an attempt line.
atime() { printf '%s\n' "$1" | sed 's/^- *//; s/ *|.*$//'; }

# Prints "done open" counts for the records in the working tree.
counts() {
  d=0 o=0
  for f in "$repo"/lab/*/E[0-9]*.md; do
    [ -f "$f" ] || continue
    case $(fm "$f" status) in
      done) d=$((d + 1)) ;;
      failed | needs-decision) ;;
      *) o=$((o + 1)) ;;
    esac
  done
  echo "$d $o"
}

# The first Executor is stopped once a record is done, another is still open,
# and every change is committed.
mid_batch() {
  [ -z "$(git -C "$repo" status --porcelain 2>/dev/null)" ] || return 1
  set -- $(counts)
  [ "$1" -ge 1 ] && [ "$2" -ge 1 ]
}

cur_pid=
on_signal() {
  [ -n "$cur_pid" ] && kill "$cur_pid" 2>/dev/null
  echo "run.sh: interrupted; scratch repository left at $repo" >&2
  exit 2
}
trap on_signal INT TERM

# Runs one role headless: label, agent, time limit, prompt section, and an
# optional stop condition. Sets role_end to done, timeout or stopped.
run_role() {
  label=$1 agent=$2 limit=$3 text=$(prompt "$4") || die "no prompt section $4"
  stop_when=${5:-}
  sys=$(prompt system)
  log=$logs/$label.jsonl
  (
    cd "$repo" && exec claude -p --plugin-dir "$plugin" \
      --agent "experiment-conductor:$agent" ${model:+--model} ${model:+"$model"} \
      --setting-sources project --permission-mode dontAsk \
      --allowedTools "Bash Read Write Edit Glob Grep Skill" \
      --append-system-prompt "$sys" \
      --output-format stream-json --verbose "$text"
  ) </dev/null >"$log" 2>&1 &
  cur_pid=$!
  echo "$label $cur_pid $(date '+%Y-%m-%d %H:%M:%S')" >>"$work/pids.txt"
  say "$label: $agent started, pid $cur_pid, log $log"
  t0=$(date +%s) killed_at= role_end=done
  while kill -0 "$cur_pid" 2>/dev/null; do
    now=$(date +%s)
    if [ -n "$killed_at" ]; then
      [ $((now - killed_at)) -ge 30 ] && kill -9 "$cur_pid" 2>/dev/null
    elif [ $((now - t0)) -ge "$limit" ]; then
      say "$label: time limit of $limit seconds reached, stopping pid $cur_pid"
      role_end=timeout killed_at=$now; kill "$cur_pid" 2>/dev/null
    elif [ -n "$stop_when" ] && $stop_when; then
      say "$label: stopping pid $cur_pid mid-batch"
      role_end=stopped killed_at=$now; kill "$cur_pid" 2>/dev/null
    fi
    sleep 5
  done
  wait "$cur_pid" 2>/dev/null
  cur_pid=
  say "$label: ended ($role_end) after $(( $(date +%s) - t0 )) seconds"
}

# ------------------------------------------------------------------ the loop

run_role 1-researcher-propose researcher "$t_propose" propose
branch=$(git -C "$repo" for-each-ref --format='%(refname:short)' 'refs/heads/exp/*-acceptance' | head -n 1)
[ -n "$branch" ] || { say "no batch branch exp/<date>-acceptance was created"; }
batch=${branch#exp/}

run_role 2-executor-run executor "$t_run" run mid_batch
exec1_end=$role_end
set -- $(counts)
open_at_stop=$2
say "first Executor ended ($exec1_end) with $1 records done and $2 open"

run_role 3-executor-continue executor "$t_continue" continue
run_role 4-researcher-report researcher "$t_report" report

# ------------------------------------------------------------------ checks

dir=lab/$batch
final=$work/final
mkdir -p "$final"
ids="E001 E002 E003 E004"

# 1. Batch created on its branch with its folder, plan and four records.
missing=
if [ -n "$branch" ]; then
  git -C "$repo" show "$branch:$dir/README.md" >"$final/README.md" 2>/dev/null || missing="$missing README.md"
  for id in $ids; do
    p=$(git -C "$repo" ls-tree --name-only "$branch" "$dir/" | grep "/$id-[^/]*\.md$" | head -n 1)
    if [ -n "$p" ]; then git -C "$repo" show "$branch:$p" >"$final/$id.md"; else missing="$missing $id"; fi
  done
  if [ -z "$missing" ]; then result batch PASS "$branch with $dir/ README.md and E001-E004"
  else result batch FAIL "$branch lacks$missing"; fi
else
  result batch FAIL "no branch exp/<date>-acceptance"
fi

# 2-5. Attempt lines: fields, commits, provenance files, jobs.
bad_fields= bad_sha= bad_prov= bad_jobs= nattempts=0
for id in $ids; do
  f=$final/$id.md
  [ -f "$f" ] || continue
  list=
  n=0
  attempts "$f" >"$final/$id.attempts"
  while IFS= read -r line; do
    n=$((n + 1))
    c=$(afield "$line" commit) j=$(afield "$line" job) r=$(afield "$line" run) pv=$(afield "$line" provenance)
    if [ -z "$c" ] || [ -z "$j" ] || [ -z "$r" ] || [ -z "$pv" ]; then bad_fields="$bad_fields $id#$n"; fi
    sha=${c%% *}
    if [ -z "$sha" ] || ! git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null; then bad_sha="$bad_sha $id#$n"; fi
    if [ -z "$pv" ] || [ ! -f "$repo/$pv" ]; then bad_prov="$bad_prov $id#$n"; fi
    list=$list${list:+,}$j
  done <"$final/$id.attempts"
  [ "$n" -ge 1 ] || bad_fields="$bad_fields $id(no-attempts)"
  nattempts=$((nattempts + n))
  jobs=$(fm "$f" jobs | sed 's/^\[//; s/\]$//' | tr -d "\"' ")
  [ "$jobs" = "$list" ] || bad_jobs="$bad_jobs $id(jobs=[$jobs],attempts=[$list])"
done
if [ -f "$final/E001.md" ]; then
  [ -z "$bad_fields" ] && result attempt-fields PASS "$nattempts attempt lines with commit, job, run, provenance" \
    || result attempt-fields FAIL "missing a field or attempt:$bad_fields"
  [ -z "$bad_sha" ] && result attempt-commits PASS "every commit SHA resolves in the repo" \
    || result attempt-commits FAIL "unknown commit in$bad_sha"
  [ -z "$bad_prov" ] && result provenance-files PASS "every provenance file exists" \
    || result provenance-files FAIL "missing provenance file in$bad_prov"
  [ -z "$bad_jobs" ] && result jobs-match PASS "jobs equals the attempt job ids in every record" \
    || result jobs-match FAIL "$bad_jobs"
else
  for c in attempt-fields attempt-commits provenance-files jobs-match; do result "$c" FAIL "no records"; done
fi

# 6. depends_on: E002 starts after E001 is done, in git order and attempt time.
first_index() {  # record path, condition (done | attempt)
  i=0
  for c in $(git -C "$repo" rev-list --reverse "main..$branch"); do
    i=$((i + 1))
    git -C "$repo" show "$c:$1" >"$final/.tmp" 2>/dev/null || continue
    if [ "$2" = done ]; then [ "$(fm "$final/.tmp" status)" = done ] && { echo "$i"; return; }
    else [ -n "$(attempts "$final/.tmp")" ] && { echo "$i"; return; }; fi
  done
  echo 0
}
if [ -f "$final/E001.md" ] && [ -f "$final/E002.md" ]; then
  p1=$(git -C "$repo" ls-tree --name-only "$branch" "$dir/" | grep '/E001-')
  p2=$(git -C "$repo" ls-tree --name-only "$branch" "$dir/" | grep '/E002-')
  d1=$(first_index "$p1" done) a2=$(first_index "$p2" attempt)
  t1=$(atime "$(grep . "$final/E001.attempts" | tail -n 1)")
  t2=$(atime "$(grep . "$final/E002.attempts" | head -n 1)")
  deps=$(fm "$final/E002.md" depends_on | tr -d ' ')
  if [ "$deps" = "[E001]" ] && [ "$d1" -gt 0 ] && [ "$a2" -ge "$d1" ] && [ -n "$t2" ] && { [ "$t2" = "$t1" ] || [ "$(printf '%s\n%s\n' "$t1" "$t2" | sort | tail -n 1)" = "$t2" ]; }; then
    result depends-on PASS "E002 first attempt ($t2, commit $a2) after E001 done (commit $d1)"
  else
    result depends-on FAIL "depends_on=$deps, E001 done at commit $d1 ($t1), E002 first attempt at commit $a2 ($t2)"
  fi
else
  result depends-on FAIL "no E001 or E002 record"
fi

# 7. The job that fails by design ends failed or needs-decision.
if [ -f "$final/E003.md" ]; then
  s=$(fm "$final/E003.md" status) n=$(grep -c . "$final/E003.attempts")
  case $s in
    failed | needs-decision) [ "$n" -ge 1 ] && result failure PASS "E003 $s after $n attempts" || result failure FAIL "E003 $s without attempts" ;;
    *) result failure FAIL "E003 status $s after $n attempts" ;;
  esac
else result failure FAIL "no E003 record"; fi

# 8. The job that times out once has two attempts and ends done.
if [ -f "$final/E004.md" ]; then
  s=$(fm "$final/E004.md" status) n=$(grep -c . "$final/E004.attempts")
  if [ "$n" -ge 2 ] && [ "$s" = done ]; then result timeout-retry PASS "E004 done after $n attempts"
  else result timeout-retry FAIL "E004 status $s after $n attempts"; fi
else result timeout-retry FAIL "no E004 record"; fi

# 9. The first Executor was stopped mid-batch and the second finished it.
open_now=
for id in $ids; do
  [ -f "$final/$id.md" ] || continue
  case $(fm "$final/$id.md" status) in done | failed | needs-decision) ;; *) open_now="$open_now $id" ;; esac
done
if [ "$exec1_end" = stopped ] && [ -z "$open_now" ]; then
  result kill-resume PASS "stopped with $open_at_stop open records, all closed by the second Executor"
else
  result kill-resume FAIL "first Executor ended $exec1_end with $open_at_stop open; open now:${open_now:- none}"
fi

# 10. On SLURM, the scheduler knows every job id.
if [ "$mode" = slurm ]; then
  unknown=
  for id in $ids; do
    [ -f "$final/$id.attempts" ] || continue
    while IFS= read -r line; do
      j=$(afield "$line" job)
      [ -n "$(sacct -n -X -j "$j" -o JobID 2>/dev/null)" ] || unknown="$unknown $id:$j"
    done <"$final/$id.attempts"
  done
  [ -z "$unknown" ] && result sacct-jobs PASS "sacct knows every job id" || result sacct-jobs FAIL "unknown to sacct:$unknown"
else
  result sacct-jobs SKIP "local mode"
fi

# 11. Every done record carries a verdict.
noverdict=
for id in $ids; do
  [ -f "$final/$id.md" ] || continue
  [ "$(fm "$final/$id.md" status)" = done ] || continue
  case $(fm "$final/$id.md" review) in supported | refuted | inconclusive) ;; *) noverdict="$noverdict $id" ;; esac
done
if [ ! -f "$final/E001.md" ]; then result verdicts FAIL "no records"
elif [ -z "$noverdict" ]; then result verdicts PASS "every done record has a review verdict"
else result verdicts FAIL "no verdict:$noverdict"; fi

# 12. The batch README.md holds the report sections in order.
if [ -f "$final/README.md" ]; then
  order=$(awk '
  BEGIN { n = split("tl;dr|what was tested|results|verdicts with evidence|surprises and defects|open questions|next experiments", want, "|") }
  /^#+[ \t]/ {
    h = tolower($0); sub(/^#+[ \t]+/, "", h); sub(/[ \t]+$/, "", h)
    for (i = 1; i <= n; i++) if (index(h, want[i]) == 1 && !(i in at)) at[i] = NR
  }
  END {
    last = 0
    for (i = 1; i <= n; i++) {
      if (!(i in at)) { print "missing " want[i]; exit }
      if (at[i] < last) { print "out of order " want[i]; exit }
      last = at[i]
    }
    print "ok"
  }' "$final/README.md")
  [ "$order" = ok ] && result report PASS "all seven report sections in order" || result report FAIL "$order"
else result report FAIL "no batch README.md"; fi

# 13. An agent asked to commit on main is refused.
main_before=$(git -C "$repo" rev-parse main)
if git -C "$repo" checkout -q main 2>/dev/null; then
  run_role 5-executor-guard executor "$t_guard" guard
  main_after=$(git -C "$repo" rev-parse main)
  if grep -q 'experiment-conductor: blocked git commit' "$logs/5-executor-guard.jsonl"; then how="the hook blocked git commit"
  elif grep -q '"command":"git commit' "$logs/5-executor-guard.jsonl"; then how="a git commit ran without the hook message"
  else how="the agent declined without running git commit"; fi
  [ "$main_after" = "$main_before" ] && result guard PASS "main unchanged; $how" || result guard FAIL "main moved to $main_after; $how"
  [ -n "$branch" ] && git -C "$repo" checkout -q "$branch" 2>/dev/null
else
  result guard FAIL "could not check out main (working tree not clean)"
fi

# 14. main still holds only its initial commit.
count=$(git -C "$repo" rev-list --count main)
[ "$(git -C "$repo" rev-parse main)" = "$initial" ] && [ "$count" = 1 ] \
  && result main-untouched PASS "main is the initial commit only" \
  || result main-untouched FAIL "main has $count commits"

# ------------------------------------------------------------------ report

elapsed=$(( $(date +%s) - started ))
echo
echo "experiment-conductor acceptance run ($mode${partition:+, partition $partition}${model:+, model $model}), $((elapsed / 60)) min $((elapsed % 60)) s"
awk -F '\t' '{ printf "%-17s %-5s %s\n", $1, $2, $3 }' "$results"
echo
echo "scratch repository: $repo"
echo "agent transcripts:  $logs"
if [ "$mode" = local ]; then
  for id in $ids; do
    [ -f "$final/$id.attempts" ] || continue
    while IFS= read -r line; do
      j=$(afield "$line" job)
      case $j in '' | *[!0-9]*) continue ;; esac
      kill -0 "$j" 2>/dev/null && echo "note: process $j from $id is still running"
    done <"$final/$id.attempts"
  done
fi
awk -F '\t' '$2 == "FAIL" { f = 1 } END { exit !f }' "$results" && exit 1
exit 0
