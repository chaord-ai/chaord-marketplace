#!/bin/sh
# PreToolUse hook on Bash: keeps the Researcher and Executor off main. In a
# session of either agent it blocks git commit, git merge and git push while
# the repository is on main or master, and any git push whose refspec targets
# main or master from any branch. Other sessions and other commands pass.
# Exit 2 blocks the call and hands stderr to the model. POSIX sh, awk, sed.

input=$(cat)

# Prints the decoded JSON string value of the first "key": "..." in $input.
json_string() {
  printf '%s' "$input" | awk -v key="$1" '
  { buf = buf $0 "\n" }
  END {
    pat = "\"" key "\"[ \t\n]*:[ \t\n]*\""
    if (!match(buf, pat)) exit
    s = substr(buf, RSTART + RLENGTH); out = ""
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1)
      if (c == "\"") break
      if (c == "\\") {
        i++; c = substr(s, i, 1)
        if (c == "n") c = "\n"; else if (c == "t") c = "\t"; else if (c == "r") c = ""
      }
      out = out c
    }
    printf "%s", out
  }'
}

# Only the plugin's own agents are guarded. agent_type names the agent of a
# session started with --agent and of a subagent, as in
# "agent_type":"experiment-conductor:executor".
case "$(json_string agent_type)" in
  experiment-conductor:researcher | experiment-conductor:executor) ;;
  *) exit 0 ;;
esac

command=$(json_string command)
case "$command" in *git*) ;; *) exit 0 ;; esac
cwd=$(json_string cwd)
[ -n "$cwd" ] || cwd=.

# One line per git invocation in the command: the -C directory (or "."), the
# subcommand, and "main" when it is a push that names main or master.
calls=$(printf '%s\n' "$command" | awk '
{
  line = $0
  gsub(/&&|\|\||[;|&()]/, "\n", line)
  nseg = split(line, segs, "\n")
  for (s = 1; s <= nseg; s++) {
    n = split(segs[s], w, /[ \t]+/)
    for (i = 1; i <= n; i++) { gsub(/["\047]/, "", w[i]) }
    for (i = 1; i <= n; i++) {
      if (w[i] != "git" && w[i] !~ /\/git$/) continue
      dir = "."; j = i + 1
      while (j <= n && w[j] ~ /^-/) {
        if (w[j] == "-C") { dir = w[j + 1]; j += 2 }
        else if (w[j] == "-c") j += 2
        else j++
      }
      sub_ = w[j]; target = "-"
      if (sub_ == "push") {
        args = 0
        for (k = j + 1; k <= n; k++) {
          if (w[k] == "--all" || w[k] == "--mirror") target = "main"
          if (w[k] ~ /^-/ || w[k] == "") continue
          args++
          if (args == 1) continue
          ref = w[k]; sub(/^\+/, "", ref); sub(/^.*:/, "", ref); sub(/^refs\/heads\//, "", ref)
          if (ref == "main" || ref == "master") target = "main"
        }
      }
      if (sub_ != "") print dir "\t" sub_ "\t" target
      break
    }
  }
}')

tab=$(printf '\t')
printf '%s\n' "$calls" | while IFS="$tab" read -r dir sub target; do
  case "$sub" in commit | merge | push) ;; *) continue ;; esac
  case "$dir" in /*) ;; *) dir="$cwd/$dir" ;; esac
  branch=$(git -C "$dir" symbolic-ref --short -q HEAD 2>/dev/null)
  if [ "$sub" = push ] && [ "$target" = main ]; then
    echo "experiment-conductor: blocked a git push that targets main. Merging to main is the user's action. Push the batch branch exp/<YYYY-MM-DD>-<batch-slug> instead." >&2
    exit 2
  fi
  case "$branch" in
    main | master)
      echo "experiment-conductor: blocked git $sub on $branch. Agents commit, push and merge only on the batch branch. Switch to it with git switch exp/<YYYY-MM-DD>-<batch-slug> and run the command again." >&2
      exit 2
      ;;
  esac
done
