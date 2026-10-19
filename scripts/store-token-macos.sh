#!/bin/zsh
# Store a cPanel API token in the macOS Keychain for cpanel-mcp-keychain.
#
# Usage: store-token-macos.sh <server URL> <cPanel user name>
#
# The security tool asks for the token itself, so the token is not in the
# command line or the shell history. Paste the token twice when asked.
set -euo pipefail

if (( $# != 2 )); then
  print -u2 "Usage: $0 <server URL> <cPanel user name>"
  exit 2
fi

server_url="$1"
username="$2"
account="${username}@${${server_url#*://}%%[:/]*}"

security add-generic-password -U -s cpanel-mcp -a "$account" \
  -l "cPanel MCP token ($account)" -w
print "Stored the token for $account in the login Keychain."
