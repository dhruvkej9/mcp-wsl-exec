---
'wsl-exec-mcp': minor
---

Performance overhaul: persistent WSL session (one bash multiplexed
over sentinel protocol) replaces per-command wsl.exe spawns,
eliminating WSL2 VM cold boots; default 30s timeout actually applied;
stdin closed so interactive commands can't hang; buffered + capped
output collection (1 MiB, UTF-8 safe); SIGKILL escalation on timeout;
precompiled dangerous-command matchers; UUID confirmation IDs with
5-minute TTL; Windows drive paths in working_dir translated to /mnt
mounts.

Security hardening: backslash-escaped command names (`\rm`, `\r\m`) no
longer bypass the dangerous-command matcher. New `MCP_WSL_CONFIRM=0`
env var runs dangerous commands immediately, skipping the
confirm_command round trip.

Robustness: `dispose()` now rejects queued commands instead of leaving
them hanging. The package emits a valid `dist/index.d.ts` and declares
an `exports` map (the `types` field previously pointed at a file the
build never produced).

New env vars: MCP_WSL_PERSISTENT, MCP_WSL_TIMEOUT, MCP_WSL_MAX_OUTPUT,
MCP_WSL_DISTRO, MCP_WSL_SHELL, MCP_WSL_DIRECT, MCP_WSL_CONFIRM.
