---
name: cpm
description: Configure, inspect, and use the CPM isolated workspace on the current Linux development machine. Use when the user asks to set up CPM, enter its container, run Claude/Codex or other commands there, or diagnose its proxy, whitelist, volume, or startup checks.
---

# CPM local workspace

CPM runs commands on the current Linux machine inside a Docker container with no direct external network. It routes network requests through its local sidecar and configured SOCKS5 proxy. Work only on the machine where `cpm` is invoked; CPM has no SSH deployment workflow.

## Workflow

1. Check `cpm --version` and `cpm help`. If CPM is missing and installation is requested, use the repository's `install.sh` on **this development machine**.
2. Run `cpm` to set the SOCKS5 proxy, direct access whitelist, timezone, locale, and default `claude` route. The TUI masks the full proxy specification. Avoid placing proxy credentials in command arguments, logs, or chat replies.
3. Run `cpm setup` to install a missing official Claude binary, check Docker security prerequisites, create or verify named volumes, and build the container image. Run `cpm check` and inspect each `FAIL` before starting a target command.
4. Use `cpm enter` for an interactive shell, `cpm exec -- <command>` for one command, `cpm proxy` for Claude, or `cpm proxy codex` for Codex. Clone repositories inside `/workspace`.

On first interactive Codex launch, CPM starts `codex login --device-auth` because browser login's localhost callback cannot reach the isolated container. The user completes the verification in their own browser; device code login must be enabled for the account or workspace. Never collect or relay a device code yourself.

CPM compares the host OS, architecture, kernel, UID/GID, and common tool versions with the image before launching a command. Read warnings as concrete differences; do not assume the entire host filesystem or package set is replicated. Default `cpm proxy codex` disables Codex's inner sandbox because the outer CPM container blocks nested user namespaces. The outer container boundary remains in force. An explicit Codex `--sandbox` argument takes precedence.

The container uses the same persistent `/home/node` and `/workspace` Docker volumes on subsequent runs by the same host user. Each command starts a new container, so background processes, `/tmp`, and changes to the read-only image layer do not persist. The host HOME and project directories are not mounted. Never remove CPM's named volumes as a routine repair step; a missing or replaced volume makes CPM stop to avoid silently presenting an empty workspace.

The whitelist supports comma-separated domains, IP addresses, and CIDR ranges. For a whole domain, include the apex and suffix as needed, for example `naiveai-dev.com,.naiveai-dev.com`. The sidecar still rejects cloud metadata and host loopback targets. A whitelist entry permits a direct connection from the **host sidecar**, so only add destinations the user intends to reach directly.

CPM checks proxy exit IP, region, locale, and container controls at startup. Its isolation reduces host information exposure but does not guarantee that arbitrary code cannot detect a container or escape a kernel vulnerability. Report what the checks actually prove.
