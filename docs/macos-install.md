# Install on macOS for Claude Code and Codex

These steps register the server once per macOS user, under the name
`cpanel`, so it is available in every project in Claude Code and Codex.
The API token is stored in the login Keychain and is not part of any MCP
configuration file.

Requirements: Node.js and npm (for example from Homebrew), and the Claude
desktop app with Claude Code, the Codex app, or their CLIs.

## 1. Get the code

Use the `local-fixes` branch of this fork, at a fixed commit:

```bash
git clone https://github.com/Jorl17/cPanel-MCP-Server.git ~/src/cpanel-mcp-server
git -C ~/src/cpanel-mcp-server checkout local-fixes
```

## 2. Build, test and register

Replace the server URL and the cPanel user name with your own:

```bash
~/src/cpanel-mcp-server/scripts/install-macos.sh https://cpanel.example.com cpaneluser
```

The script installs the locked dependencies with `npm ci`, builds and runs
the tests, and then runs `claude mcp add --scope user` and `codex mcp add`.
When the `claude` or `codex` command is not on PATH, the script uses the
copy inside the Claude or Codex app.

## 3. Create and store an API token

In cPanel, open Security > Manage API Tokens and create a token. A cPanel
token can call every API that the account can call. Give each Mac its own
token with a name such as `mcp-<mac name>` and an expiry date, so you can
revoke one Mac without the other.

Store the token, with the same URL and user name as in step 2:

```bash
~/src/cpanel-mcp-server/scripts/store-token-macos.sh https://cpanel.example.com cpaneluser
```

Paste the token twice when the `security` tool asks for it.

## 4. Check the connection

Start a new Claude Code or Codex session and ask for a read, for example
"list the domains of my cPanel account" or "list the email forwarders".
In Claude Code, `/mcp` shows whether the `cpanel` server is connected.

## Notes

- We send each API call once. When a change times out, read the current
  state before you try it again.
- The server registers every tool group, including tools that delete data,
  manage tokens or turn off two-factor authentication. Approve write tools
  one at a time in the agent.
- DNS edit and delete tools address a record by its line number, which
  changes when the zone changes. Read the zone again right before a change.
