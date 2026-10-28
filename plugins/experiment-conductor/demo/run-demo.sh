#!/bin/sh
# Opens the Researcher and Executor of experiment-conductor in two tmux panes
# inside a fresh scratch git repo, with a first prompt already submitted.
set -eu

usage() {
  echo "usage: run-demo.sh [-l PLUGIN_DIR] [-d] PARTITION" >&2
  echo "  -l PLUGIN_DIR  load the plugin from a local checkout (--plugin-dir)" >&2
  echo "  -d             create the tmux session but do not attach to it" >&2
  exit 2
}

plugin_dir=""
attach=1
while getopts "l:dh" opt; do
  case $opt in
    l) plugin_dir=$OPTARG ;;
    d) attach=0 ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ $# -eq 1 ] || usage
partition=$1

command -v tmux >/dev/null 2>&1 || { echo "tmux not found" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git not found" >&2; exit 1; }
claude_bin=${CLAUDE_BIN:-claude}

if [ -n "$plugin_dir" ]; then
  plugin_dir=$(cd "$plugin_dir" && pwd) || exit 1
fi

# One fresh folder per run: the scratch repo plus the launcher files.
base=$(mktemp -d "${TMPDIR:-/tmp}/ec-demo.XXXXXX")
id=${base##*.}
repo=$base/lab
launch=$base/launch
mkdir "$repo" "$launch"

git -C "$repo" init -q
git -C "$repo" symbolic-ref HEAD refs/heads/main
printf '# Experiment Conductor demo\n' > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" -c user.name=demo -c user.email=demo@example.com \
  commit -q -m "init: demo repo"

r_name=researcher-$id
e_name=executor-$id
session=ecdemo-$id

cat > "$launch/researcher.prompt" <<PROMPT
This is a dry run of the workflow, with no real research. Propose a batch of 5 dummy experiments. Each one is a SLURM job on partition \`$partition\` with 1 CPU and no GPU. It sleeps about 60 seconds and writes a fake metric to its run folder. Make E003 depend on E002. Make E004 fail every time with exit 1, so we can see the failure path.

I approve this dry-run batch now, so you may mark all five records ready yourself without asking me again. When the batch is ready, send a message to the Claude Code session named $e_name to tell it which batch branch to run. Each time that session messages you that an experiment is ready for analysis, analyze it. When all experiments are analyzed, write the batch report.
PROMPT

cat > "$launch/executor.prompt" <<PROMPT
This is a dry run of the workflow. Wait for a message from the Claude Code session named $r_name that says a batch is ready. Then run the batch according to the protocol. Each time an experiment is ready for analysis, send a message to the session named $r_name. When the batch is finished, send it a final message.
PROMPT

# Each pane runs a small launcher so the prompt needs no quoting in tmux.
for role in researcher executor; do
  if [ $role = researcher ]; then name=$r_name; else name=$e_name; fi
  {
    echo "#!/bin/sh"
    echo "cd \"$repo\""
    printf 'exec "%s" --name "%s" --agent "experiment-conductor:%s"' \
      "$claude_bin" "$name" "$role"
    if [ -n "$plugin_dir" ]; then
      printf ' --plugin-dir "%s"' "$plugin_dir"
    fi
    echo " \"\$(cat \"$launch/$role.prompt\")\""
  } > "$launch/$role.sh"
  chmod +x "$launch/$role.sh"
done

tmux new-session -d -s "$session" -c "$repo" "$launch/researcher.sh"
tmux split-window -v -t "$session" -c "$repo" "$launch/executor.sh"
tmux select-pane -t "$session:0.0"

echo "demo repo: $repo"
echo "tmux session: $session"

if [ "$attach" -eq 1 ]; then
  if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "$session"
  else
    tmux attach-session -t "$session"
  fi
fi
