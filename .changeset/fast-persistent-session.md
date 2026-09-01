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

Confirmation list trimmed to genuinely destructive commands only
(`rm`, `rmdir`, `dd`, `mkfs`, `mkswap`, `fdisk`, `shutdown`, `reboot`,
`find -delete`, `truncate`, `shred`). Redirects, sudo, package
managers, `mv`, `chmod`, `kill`, `service`, `mount`, and other
non-destructive commands now run immediately without confirmation.

Robustness: `dispose()` now rejects queued commands instead of leaving
them hanging. The package emits a valid `dist/index.d.ts` and declares
an `exports` map (the `types` field previously pointed at a file the
build never produced).

Hang-proofing: the WSL shell is spawned via `setsid -w`, detaching it
from any controlling TTY. Commands that would block on `/dev/tty`
(e.g. `sudo` password prompts) now fail fast instead of hanging the
whole session — verified live: `sudo echo hi` returns in ~300ms with
exit 1 and the session keeps serving subsequent commands.

New env vars: MCP_WSL_PERSISTENT, MCP_WSL_TIMEOUT, MCP_WSL_MAX_OUTPUT,
MCP_WSL_DISTRO, MCP_WSL_SHELL, MCP_WSL_DIRECT, MCP_WSL_CONFIRM.
