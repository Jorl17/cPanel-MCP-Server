#!/bin/zsh
# Build the cPanel MCP server and register it for the current macOS user in
# Claude Code and Codex.
#
# Usage: install-macos.sh <server URL> <cPanel user name>
#
# We register the server under the name "cpanel" at user scope, so it is
# available in every project. When a "cpanel" server is already registered,
# we replace it. The API token is not part of the registration. Store it
# with store-token-macos.sh.
set -euo pipefail

if (( $# != 2 )); then
  print -u2 "Usage: $0 <server URL> <cPanel user name>"
  exit 2
fi

server_url="$1"
username="$2"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
repo_dir="${0:A:h:h}"
launcher="$repo_dir/scripts/cpanel-mcp-keychain"

# Return the Claude Code CLI on PATH, or else the newest copy in the Claude
# desktop app.
find_claude() {
  if command -v claude >/dev/null; then
    command -v claude
    return
  fi
  local -a found
  found=("$HOME"/Library/Application\ Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude(N.om))
  (( ${#found} )) && print -r -- "${found[1]}"
}

# Return the Codex CLI on PATH, or else the copy in the Codex app.
find_codex() {
  if command -v codex >/dev/null; then
    command -v codex
  elif [[ -x /Applications/Codex.app/Contents/Resources/codex ]]; then
    print -r -- /Applications/Codex.app/Contents/Resources/codex
  fi
}

cd "$repo_dir"
npm ci --ignore-scripts --no-audit --no-fund
npm test

env_args=(CPANEL_SERVER_URL="$server_url" CPANEL_USERNAME="$username")

claude_cli="$(find_claude || true)"
if [[ -n "$claude_cli" ]]; then
  "$claude_cli" mcp remove --scope user cpanel >/dev/null 2>&1 || true
  "$claude_cli" mcp add --scope user cpanel \
    -e "${env_args[1]}" -e "${env_args[2]}" -- "$launcher"
  print "Registered cpanel in Claude Code (user scope)."
else
  print -u2 "Claude Code CLI not found. Skipped the Claude Code registration."
fi

codex_cli="$(find_codex || true)"
if [[ -n "$codex_cli" ]]; then
  "$codex_cli" mcp remove cpanel >/dev/null 2>&1 || true
  "$codex_cli" mcp add cpanel \
    --env "${env_args[1]}" --env "${env_args[2]}" -- "$launcher"
  print "Registered cpanel in Codex."
else
  print -u2 "Codex CLI not found. Skipped the Codex registration."
fi
