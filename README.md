# Claude Code sandbox

A Docker image for running [Claude Code](https://code.claude.com/docs) in a sandbox. Use it three ways:

- **In your terminal**: `docker run -it` against a project folder.
- **As an always-on box you drive from [claude.ai/code](https://claude.ai/code) and the Claude app**, using [Remote Control](https://code.claude.com/docs/en/remote-control).
- **As a [self-hosted environment](https://code.claude.com/docs/en/self-hosted-environments)** for a Claude Team or Enterprise organization.

```
ghcr.io/loganrf/claude:latest        linux/amd64, linux/arm64
```

The image is Debian (trixie) with Claude Code (signature-verified native binary), Node.js 24, Python 3, git, git-lfs, the GitHub CLI, ripgrep, build-essential and tmux. Claude Code runs as the unprivileged user `claude`.

## Quick start

### 1. In your terminal

Works with any credential. An API key:

```bash
docker run -it --rm -e ANTHROPIC_API_KEY -v "$PWD":/workspace -v claude-config:/home/claude/.claude ghcr.io/loganrf/claude
```

Or your Claude plan through a long-lived token. Create one with `claude setup-token` on any machine, or with the image:

```bash
docker run -it --rm ghcr.io/loganrf/claude setup-token
```

```bash
docker run -it --rm -e CLAUDE_CODE_OAUTH_TOKEN -v "$PWD":/workspace -v claude-config:/home/claude/.claude ghcr.io/loganrf/claude
```

A shell function makes this a one-word command. Variables that aren't set on your machine are simply not passed:

```bash
claude-sandbox() {
  docker run -it --rm -e ANTHROPIC_API_KEY -e CLAUDE_CODE_OAUTH_TOKEN -e GH_TOKEN \
    -v "$PWD":/workspace -v claude-config:/home/claude/.claude \
    ghcr.io/loganrf/claude "$@"
}
```

Arguments go straight to Claude Code, for example `claude-sandbox --model opus` or `claude-sandbox claude -p "summarize this repo"`.

If the `claude-config` volume holds a claude.ai login (see the next section), the terminal session is also mirrored to claude.ai/code and the Claude app.

### 2. From claude.ai/code and the Claude app

This needs a Claude Pro, Max, Ultra, Team or Enterprise plan. On Team and Enterprise, an Owner must turn on Remote Control in the [Claude Code admin settings](https://claude.ai/admin-settings/claude-code).

```bash
git clone https://github.com/loganrf/claude claude-sandbox
```

```bash
cd claude-sandbox && cp .env.example .env && mkdir -p workspace
```

Sign in once. The login is stored in the `claude-config` volume. If no browser opens, open the printed URL on any device, approve, and paste the code back:

```bash
docker compose run --rm claude login
```

```bash
docker compose up -d
```

Open [claude.ai/code](https://claude.ai/code) or **Code** in the Claude app. The container appears in the session list as `claude-sandbox-…` with a computer icon. Sessions you start there run inside the container against `/workspace`.

- **Choose the project**: put a checkout in `./workspace` (or set `WORKSPACE=/path/to/project` in `.env`), or set `GIT_REPO_URL` to clone one on first start.
- **Use the terminal too**: run `docker compose exec claude claude`.
- **See the status screen and QR code**: run `docker attach claude-sandbox-claude-1`, and detach with Ctrl-P Ctrl-Q.

Only a full `claude auth login` can start Remote Control. `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` only make model requests, so with only those the service stays idle and tells you why in `docker compose logs`.

### 3. As a Team or Enterprise self-hosted environment

Self-hosted environments put this container in the environment picker of every cloud session your organization starts: claude.ai/code, the Claude apps, `claude --cloud`, and scheduled tasks. They are in public beta on Team and Enterprise plans.

1. An Owner turns on **Allow self-hosted environments**, then creates an environment at [Cloud environments](https://claude.ai/admin-settings/cloud-environments) and copies the environment key, which is shown once.
2. Save the key next to `compose.runner.yaml`: paste it, press Enter, then Ctrl-D.

   ```bash
   (umask 077 && cat > environment-secret)
   ```

3. Start the runner:

   ```bash
   docker compose -f compose.runner.yaml up -d
   ```

The environment turns **Healthy** in the admin page, and sessions routed to it run in this container. Without a `GH_TOKEN`, the runner uses the Anthropic git proxy for github.com repositories. The runner exits after each session by design and Compose restarts it. For production, run a fresh container per session, as [Deploy to production](https://code.claude.com/docs/en/self-hosted-environments-deploy) describes.

Anthropic-hosted cloud environments can't use a custom image ("replacing the base image entirely isn't supported yet"), so Remote Control and self-hosted runners are the two ways to put this image behind claude.ai.

## Credentials

| What you have | How to provide it | Terminal | claude.ai and app |
| --- | --- | --- | --- |
| Claude plan, full login | `login` command once; stored in `/home/claude/.claude` | yes | yes, through Remote Control |
| Claude plan, long-lived token | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | yes | no: the token is inference-only |
| Claude Console API key | `ANTHROPIC_API_KEY` | yes | no |
| Team or Enterprise environment | `SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET` | no | yes, as a self-hosted environment |
| Bedrock, Vertex AI, Foundry, LLM gateway | their usual variables, such as `CLAUDE_CODE_USE_BEDROCK` or `ANTHROPIC_BASE_URL` | yes | no |

Every credential variable also accepts a `<NAME>_FILE` variant pointing at a file, for Docker and Kubernetes secrets. An API key or `ANTHROPIC_AUTH_TOKEN` outranks a stored login, as in Claude Code itself. When a stored login exists, the entrypoint ignores `CLAUDE_CODE_OAUTH_TOKEN` so Remote Control can start.

The entrypoint pre-answers Claude Code's first-run questions: onboarding, approval of the `ANTHROPIC_API_KEY` you passed, trust for `/workspace`, and Remote Control's one-time consent. A new container starts straight into work.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` | | Claude credentials (see above) |
| `GH_TOKEN` or `GITHUB_TOKEN` | | Used by `gh`, and set up as git's credential helper for github.com |
| `GIT_USER_NAME`, `GIT_USER_EMAIL` | | Git commit identity |
| `GIT_REPO_URL`, `GIT_REPO_BRANCH` | | Clone into the workspace on start if it's empty |
| `CLAUDE_MODE` | `auto` | Mode when no command is given (see [Modes](#modes)) |
| `CLAUDE_PERMISSION_MODE` | Claude Code's default | `default`, `acceptEdits`, `auto`, `plan`, `dontAsk` or `bypassPermissions` |
| `CLAUDE_ARGS` | | Extra arguments for `claude` or `claude remote-control` |
| `CLAUDE_REMOTE_CONTROL` | `1` | `0` keeps the container off claude.ai/code even when signed in |
| `CLAUDE_RC_NAME` | auto | Remote Control session name. Auto names start with the hostname; set `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX` to change that |
| `CLAUDE_RC_SPAWN` | `same-dir` | How Remote Control creates sessions: `same-dir`, `worktree` (needs a git repo) or `session` |
| `CLAUDE_RC_CAPACITY` | 32 | Maximum concurrent Remote Control sessions |
| `SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET` | | Environment key; selects runner mode |
| `CLAUDE_RUNNER_CAPACITY` | `1` | Concurrent sessions per runner |
| `SELF_HOSTED_RUNNER_*`, `CLAUDE_RUNNER_*` | | Passed through to the runner ([reference](https://code.claude.com/docs/en/self-hosted-environments-reference)) |
| `CLAUDE_WORKDIR` | `/workspace` | Project directory |
| `CLAUDE_TRUST_WORKSPACE` | `1` | Pre-trust the workspace, so its `.claude/` settings, hooks and MCP servers load |
| `CLAUDE_SUDO` | `0` | `1` gives the `claude` user passwordless sudo, for example to `apt-get install` |
| `HOST_UID`, `HOST_GID` | owner of `/workspace` | Run as this UID/GID so files on bind mounts belong to you |
| `CLAUDE_MATCH_WORKSPACE_OWNER` | `1` | `0` stops adopting the workspace owner's UID |

Any other [Claude Code environment variable](https://code.claude.com/docs/en/env-vars) works as usual. Claude Code's auto-updater is off (`DISABLE_AUTOUPDATER=1`); new releases arrive with new image tags.

## Modes

Pass a mode as the container command, for example `docker run … ghcr.io/loganrf/claude status`.

| Mode | What it runs |
| --- | --- |
| `auto` (default) | `runner` if an environment secret is set, otherwise `interactive` with a TTY, otherwise `server` |
| `interactive` | `claude` in the terminal, plus `--remote-control` when a claude.ai login exists |
| `server` | The first that applies: `runner`, then `remote-control`, then `idle` with the reason logged |
| `remote-control` | `claude remote-control`; exits with the reason if it can't |
| `runner` | `claude self-hosted-runner` |
| `login` | `claude auth login` (claude.ai account) |
| `setup-token` | `claude setup-token` |
| `status` | What the container detected and which mode `server` would pick |
| `shell` | `bash` as the `claude` user |
| `idle` | Stays up for `docker exec` |
| `help` | Usage |

Any other command runs as the `claude` user. A first argument starting with `-` goes to `claude`.

`docker exec <container> claude` also runs as `claude`, even though `docker exec` defaults to root. For a shell, use `docker exec -it -u claude <container> bash`.

## Volumes and paths

| Path | Contents |
| --- | --- |
| `/workspace` | The project Claude works on |
| `/home/claude/.claude` | `CLAUDE_CONFIG_DIR`: login, settings, session history, `.claude.json`. Keep it on a volume |

On Linux, the entrypoint switches the `claude` user to the owner of a bind-mounted `/workspace`, so files Claude creates belong to you on the host. Create the folder before the first start (`mkdir -p workspace`); otherwise Docker creates it as root.

## Use it as a dev container

Copy [`examples/devcontainer/devcontainer.json`](examples/devcontainer/devcontainer.json) to `.devcontainer/devcontainer.json` in any project. It passes `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN` from your machine and keeps the login in a shared `claude-code-config` volume. After `claude auth login` in the container terminal and a rebuild, the dev container is also reachable from claude.ai/code.

## What the sandbox does and doesn't protect

- **Contained**: Claude Code runs as an unprivileged user in a container and sees only what you mount. It has no sudo unless you set `CLAUDE_SUDO=1`. That makes `CLAUDE_PERMISSION_MODE=bypassPermissions` a reasonable choice for unattended work on trusted repositories.
- **Not contained**: anything inside the container is readable by code Claude runs. That includes your tokens, the login in `/home/claude/.claude`, and the mounted workspace, which Claude can change. Use narrowly scoped tokens, such as a fine-grained `GH_TOKEN` for one repository, and don't mount `~/.ssh` or cloud credentials.
- **Network**: outbound access is Docker's default, which is unrestricted. Limit it with your own Docker network or firewall rules if you need to.
- **Trust**: `/workspace` is pre-trusted, so a repository's committed `.claude/` settings, hooks and MCP servers take effect. Set `CLAUDE_TRUST_WORKSPACE=0` for repositories you don't trust.
- **Remote Control**: execution stays in the container. The conversation transcript is stored on Anthropic's servers, under Claude Code's [data usage](https://code.claude.com/docs/en/data-usage) terms.

## Image tags and publishing

[`.github/workflows/image.yml`](.github/workflows/image.yml) builds the image on every push and pull request and runs [`tests/smoke.sh`](tests/smoke.sh) against it. It publishes to GHCR only from the default branch, from `v*` tags, on the weekly schedule, and from manual runs on the default branch.

| Tag | Meaning |
| --- | --- |
| `latest` | Default branch, rebuilt every Monday with the current stable Claude Code and fresh OS packages |
| `claude-code-X.Y.Z` | The build that contains Claude Code X.Y.Z |
| `sha-<commit>` | One commit of this repository |
| `X.Y.Z`, `X.Y` | Git tags `vX.Y.Z` |

To build a specific Claude Code version, open **Actions › Image › Run workflow** and enter `latest` or a version number. Images carry SBOM and provenance attestations:

```bash
gh attestation verify oci://ghcr.io/loganrf/claude:latest -R loganrf/claude
```

After the first publish, check the package's visibility under **Package settings** on GitHub. Make it public if you want `docker pull` to work without `docker login ghcr.io`.

## Build and test locally

```bash
docker build -t claude-sandbox .
```

```bash
tests/smoke.sh claude-sandbox
```

`--build-arg CLAUDE_CODE_VERSION=` takes `stable` (default), `latest` or a version number. The build verifies the Claude Code binary against Anthropic's GPG-signed release manifest. To add tools, extend the image; it starts as root, so `apt-get` works:

```dockerfile
FROM ghcr.io/loganrf/claude:latest
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
```

## Troubleshooting

- **See what the container detected**: `docker compose run --rm claude status`. Inside a session, `/status` shows the same from Claude Code's side.
- **Not on claude.ai/code**: check `docker compose logs claude`. Common causes are no stored login, an `ANTHROPIC_API_KEY` in `.env`, or Remote Control turned off for a Team or Enterprise organization.
- **`Remote Control requires a full-scope login token`**: you're authenticated with `CLAUDE_CODE_OAUTH_TOKEN`. Run the `login` command.
- **Login expired**: run `docker compose run --rm claude login` again, then `docker compose restart`.
- **Permission denied in `/workspace`**: set `HOST_UID` and `HOST_GID` to your `id -u` and `id -g`.
