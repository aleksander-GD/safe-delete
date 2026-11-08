#!/bin/sh
# safe-delete: stands in for rm, rmdir and unlink inside Claude's Bash tool.
# Moves each target into the Trash instead of deleting it, keeping the
# commands' own checks and exit codes, and records each move in the log the
# mod reads: kind US original US trashed US epoch RS (US = \037, RS = \036).
#
# Usage: sh trash.sh <log> <rm|rmdir|unlink> [args...]

log=$1
cmd=$2
shift 2

recursive=0
force=0
dirs=0
status=0

case $cmd in
  rm)
    while [ $# -gt 0 ]; do
      case $1 in
        --) shift; break ;;
        --recursive) recursive=1 ;;
        --force) force=1 ;;
        --dir) dirs=1 ;;
        --*) ;;
        -?*)
          flags=${1#-}
          case $flags in *[rR]*) recursive=1 ;; esac
          case $flags in *f*) force=1 ;; esac
          case $flags in *d*) dirs=1 ;; esac
          ;;
        *) break ;;
      esac
      shift
    done
    ;;
  rmdir)
    while [ $# -gt 0 ]; do
      case $1 in
        --) shift; break ;;
        -?*) ;;
        *) break ;;
      esac
      shift
    done
    ;;
  unlink)
    [ "$1" = "--" ] && shift
    ;;
  *)
    echo "safe-delete: unknown command $cmd" >&2
    exit 2
    ;;
esac

if [ $# -eq 0 ]; then
  [ "$cmd" = rm ] && [ $force = 1 ] && exit 0
  echo "usage: $cmd file ..." >&2
  exit 64
fi

# Where the Trash is: macOS's, else the freedesktop one.
if [ "$(uname -s)" = Darwin ]; then
  trash="$HOME/.Trash"
  info=""
else
  root="${XDG_DATA_HOME:-$HOME/.local/share}/Trash"
  trash="$root/files"
  info="$root/info"
  mkdir -p "$trash" "$info" 2>/dev/null
fi

us=$(printf '\037')
rs=$(printf '\036')

for target in "$@"; do
  name=$(basename -- "$target")
  case $name in
    . | .. | /)
      echo "$cmd: \"$target\" may not be removed" >&2
      status=1
      continue
      ;;
  esac

  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    if ! { [ "$cmd" = rm ] && [ $force = 1 ]; }; then
      echo "$cmd: $target: No such file or directory" >&2
      status=1
    fi
    continue
  fi

  if [ -d "$target" ] && [ ! -L "$target" ]; then
    kind=folder
    case $cmd in
      rm)
        if [ $recursive = 0 ]; then
          if [ $dirs = 0 ] || [ -n "$(ls -A -- "$target" 2>/dev/null)" ]; then
            echo "rm: $target: is a directory" >&2
            status=1
            continue
          fi
        fi
        ;;
      rmdir)
        if [ -n "$(ls -A -- "$target" 2>/dev/null)" ]; then
          echo "rmdir: $target: Directory not empty" >&2
          status=1
          continue
        fi
        ;;
      unlink)
        echo "unlink: $target: is a directory" >&2
        status=1
        continue
        ;;
    esac
  else
    kind=file
    if [ "$cmd" = rmdir ]; then
      echo "rmdir: $target: Not a directory" >&2
      status=1
      continue
    fi
  fi

  parent=$(cd -- "$(dirname -- "$target")" 2>/dev/null && pwd)
  if [ -z "$parent" ]; then
    echo "$cmd: $target: cannot resolve its folder" >&2
    status=1
    continue
  fi
  original="${parent%/}/$name"

  case $original in
    "$trash" | "$trash"/*)
      echo "$cmd: $target: already in the Trash; empty the Trash to delete it" >&2
      status=1
      continue
      ;;
  esac

  # A free name in the Trash, as Finder picks one: "name 12.34.56", then a counter.
  dest="$trash/$name"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    stamp=$(date +%H.%M.%S)
    dest="$trash/$name $stamp"
    n=2
    while [ -e "$dest" ] || [ -L "$dest" ]; do
      dest="$trash/$name $stamp $n"
      n=$((n + 1))
    done
  fi

  if ! /bin/mv -- "$original" "$dest"; then
    echo "$cmd: $target: could not move it to the Trash ($trash); nothing was deleted" >&2
    status=1
    continue
  fi

  if [ -n "$info" ]; then
    printf '[Trash Info]\nPath=%s\nDeletionDate=%s\n' "$original" "$(date +%Y-%m-%dT%H:%M:%S)" \
      >"$info/$(basename -- "$dest").trashinfo" 2>/dev/null
  fi

  if ! printf '%s%s%s%s%s%s%s%s' "$kind" "$us" "$original" "$us" "$dest" "$us" "$(date +%s)" "$rs" >>"$log" 2>/dev/null; then
    echo "safe-delete: moved $original to $dest, but could not record it for /restore" >&2
  fi
done

exit $status
