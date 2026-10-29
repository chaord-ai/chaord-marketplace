#!/bin/sh
# Opens the Researcher and Executor of experiment-conductor in two tmux panes
# inside a fresh scratch git repo at BASE/project, with a first prompt already
# submitted.
set -eu

usage() {
  echo "usage: run-demo.sh [-b BASE] [-l PLUGIN_DIR] [-m MODE] [-d] PARTITION" >&2
  echo "  -b BASE        folder that holds the demo repo (default: \$HOME/ec-demo)" >&2
  echo "  -l PLUGIN_DIR  load the plugin from a local checkout (--plugin-dir)" >&2
  echo "  -m MODE        pass --permission-mode MODE to both sessions" >&2
  echo "  -d             create the tmux session but do not attach to it" >&2
  exit 2
}

plugin_dir=""
base_dir=${HOME:-}/ec-demo
mode=""
attach=1
while getopts "b:l:m:dh" opt; do
  case $opt in
    b) base_dir=$OPTARG ;;
    m) mode=$OPTARG ;;
    l) plugin_dir=$OPTARG ;;
    d) attach=0 ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ $# -eq 1 ] || usage
partition=$1
[ -n "$partition" ] || { echo "error: PARTITION must not be empty" >&2; usage; }
[ -n "$base_dir" ] || { echo "error: BASE must not be empty" >&2; usage; }

# The generated launchers quote paths with double quotes, so these characters
# would break them. Spaces are fine.
check_path() {
  case $2 in
    *'"'* | *'$'* | *'`'*)
      echo "error: $1 must not contain a double quote, a dollar sign or a backtick: $2" >&2
      exit 2 ;;
  esac
}
check_path BASE "$base_dir"
check_path PLUGIN_DIR "$plugin_dir"
check_path MODE "$mode"

command -v tmux >/dev/null 2>&1 || { echo "tmux not found" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git not found" >&2; exit 1; }
claude_bin=${CLAUDE_BIN:-claude}

if [ -n "$plugin_dir" ]; then
  plugin_dir=$(cd "$plugin_dir" && pwd) || exit 1
  check_path PLUGIN_DIR "$plugin_dir"
fi

# Every run uses the same repo folder, BASE/project. Claude Code remembers
# trust per git repo path, so the presenter trusts that path once and later
# runs start without a trust dialog. The previous run's repo moves to
# BASE/runs, and its launchers stay there too.
mkdir -p "$base_dir/runs"
base_dir=$(cd "$base_dir" && pwd) || exit 1
check_path BASE "$base_dir"
running=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^ecdemo-' || true)
if [ -n "$running" ]; then
  echo "error: an earlier demo is still running in tmux: $running" >&2
  echo "stop it first with: tmux kill-session -t <name>" >&2
  exit 1
fi
launch=$(mktemp -d "$base_dir/runs/launch.XXXXXX")
id=${launch##*.}
repo=$base_dir/project
if [ -e "$repo" ]; then
  mv "$repo" "$base_dir/runs/project.$(date +%Y%m%d-%H%M%S).$id"
fi
mkdir "$repo"

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

I approve every record in this dry-run batch, E-numbers included, so treat this message as my approval of each one and mark them ready yourself. When the batch is ready, send a message to the Claude Code session named $e_name to tell it which batch branch to run. Each time that session messages you that an experiment is ready for analysis, analyze it. When all experiments are analyzed, write the batch report.
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
    if [ -n "$mode" ]; then
      printf ' --permission-mode "%s"' "$mode"
    fi
    if [ -n "$plugin_dir" ]; then
      printf ' --plugin-dir "%s"' "$plugin_dir"
    fi
    echo " \"\$(cat \"$launch/$role.prompt\")\""
  } > "$launch/$role.sh"
  chmod +x "$launch/$role.sh"
done

tmux new-session -d -s "$session" -c "$repo" sh "$launch/researcher.sh"
tmux split-window -v -t "$session" -c "$repo" sh "$launch/executor.sh"
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
