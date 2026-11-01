# Claude Code sandbox

A Docker image for running [Claude Code](https://code.claude.com/docs) in a sandbox. Use it three ways:

- **In your terminal**: `docker run -it` against a project folder.
- **As an always-on box you drive from [claude.ai/code](https://claude.ai/code) and the Claude app**, using [Remote Control](https://code.claude.com/docs/en/remote-control). A password-protected [web UI](#web-ui) signs it in to Claude, holds your GitHub token and turns Remote Control on and off.
- **As a [self-hosted environment](https://code.claude.com/docs/en/self-hosted-environments)** for a Claude Team or Enterprise organization.

```
ghcr.io/loganrf/claude:latest        linux/amd64, linux/arm64
```

The image is Debian (trixie) with Claude Code (signature-verified native binary), Node.js 24, Python 3, git, git-lfs, the GitHub CLI, ripgrep, build-essential, tmux, shellcheck, Chromium and Docker Engine. Docker only runs if you [turn it on](#docker-inside-the-sandbox). Claude Code runs as the unprivileged user `claude`.

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

```bash
docker compose up -d
```

Get the one-time setup code from the log:

```bash
docker compose logs claude | grep 'setup code'
```

Open `http://localhost:8765`, or the machine's address from another computer. Enter the setup code and create a password for the web UI, then:

1. On **Claude**, choose **Sign in with Claude**. Open the link on any device, approve, and paste the code back.
2. On **GitHub**, paste a token (**Help** lists the permissions to grant) and set your commit name and email.
3. Remote Control starts as soon as you're signed in. **Overview** shows it running.

Open [claude.ai/code](https://claude.ai/code) or **Code** in the Claude app. The container appears in the session list as `claude-sandbox-…` with a computer icon. Sessions you start there run inside the container against `/workspace`.

- **Choose the project**: put a checkout in `./workspace` (or set `WORKSPACE=/path/to/project` in `.env`), or set a repository URL on the web UI's GitHub page (`GIT_REPO_URL`) to clone one into the empty workspace.
- **Use the terminal too**: run `docker compose exec claude claude`.
- **Sign in from the terminal instead**: `docker compose run --rm claude login` stores the same login. The web UI picks it up within 30 seconds.
- **See the status screen**: run `docker attach claude-sandbox-claude-1`, and detach with Ctrl-P Ctrl-Q.

Only a full Claude sign-in can start Remote Control. `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` only make model requests, so with only those Remote Control doesn't start, and the web UI and `docker compose logs` tell you why.

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

## Web UI

In `server` mode, which `compose.yaml` uses, the container serves a web UI on port 8765. It runs `claude remote-control` itself, so Remote Control can be started and stopped from the browser, and it restarts Remote Control when it exits.

| Page | What it does |
| --- | --- |
| **Overview** | Remote Control state and link, the Claude account in use, the GitHub token and workspace repository, the container (Claude Code version, user, disk, permission mode) and every setting with where it comes from |
| **Claude** | Sign in with your Claude account (with or without SSO), sign out, or save a long-lived token or API key instead |
| **GitHub** | Save and test a token, set the commit name and email, and choose a repository to clone into an empty workspace |
| **Remote Control** | Start, stop and restart it, set its name, spawn mode, capacity and permission mode, and watch its output |
| **Help** | Which GitHub token to create and which permissions to grant, with links that pre-fill GitHub's form |
| **Security** | Change the web UI password |

### Password

Set `CLAUDE_WEBUI_PASSWORD` (or `CLAUDE_WEBUI_PASSWORD_FILE`) in `.env` to choose the password up front. Without it, the first visit asks you to create one. That page also asks for the setup code the container prints to its log, so nobody else on the network can claim the UI before you. The code changes on every restart until a password exists, and is also saved in `/home/claude/.claude/claude-sandbox/setup-code`.

Passwords need at least 12 characters. A created password is stored as a scrypt hash in the `claude-config` volume. After 5 wrong passwords, an address is refused for 15 minutes. Sessions last 12 hours of inactivity, 7 days at most.

**Reset the web UI password** by deleting the hash and restarting, which brings the setup page back:

```bash
docker compose exec claude rm /home/claude/.claude/claude-sandbox/webui-auth.json && docker compose restart
```

### Keep it private

The web UI can sign the container in to Claude, change tokens and start Remote Control, so protect it like the tokens themselves.

- It serves plain HTTP by default. Use it on a private network or VPN, or put HTTPS in front of it. To serve HTTPS directly, mount a certificate and set `CLAUDE_WEBUI_TLS_CERT` and `CLAUDE_WEBUI_TLS_KEY` to its paths in the container.
- To accept connections from the Docker host only, set `CLAUDE_SANDBOX_WEBUI_PORT=127.0.0.1:8765` in `.env`, and reach it from elsewhere through an SSH tunnel (`ssh -L 8765:localhost:8765 host`).
- Requests that change anything must come from the page itself: cookies are `SameSite=Strict`, cross-origin writes are refused, and the page sends a strict Content Security Policy.

### Settings

Values you save in the web UI go to `/home/claude/.claude/claude-sandbox/settings.json` in the `claude-config` volume, readable only by the `claude` user. They're the same variables as in `.env`: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL`, `GIT_REPO_URL`, `GIT_REPO_BRANCH`, `CLAUDE_REMOTE_CONTROL`, `CLAUDE_RC_NAME`, `CLAUDE_RC_SPAWN`, `CLAUDE_RC_CAPACITY` and `CLAUDE_PERMISSION_MODE`.

- A variable set in the container environment wins. The web UI marks it "from environment" and won't change it.
- `docker compose exec claude claude` and shells as the `claude` user pick saved values up right away. Git identity is applied when you save, and a repository URL is cloned then if the workspace is empty.
- A running Remote Control keeps the values it started with. The web UI says when a restart would apply new ones; restarting stops the sessions running in it.

Set `CLAUDE_WEBUI=0` to turn the web UI off. `server` mode then runs Remote Control directly, as before.

## Docker inside the sandbox

Docker Engine, Buildx and Compose are installed but off. To let Claude build images and run containers, add [`compose.docker.yaml`](compose.docker.yaml):

```bash
docker compose -f compose.yaml -f compose.docker.yaml up -d
```

Or put `COMPOSE_FILE=compose.yaml:compose.docker.yaml` in `.env` so plain `docker compose` commands include it. With `docker run`, pass `--privileged -e CLAUDE_DOCKER=1 -v claude-docker:/var/lib/docker`.

The entrypoint then starts its own Docker daemon as root before handing over to the `claude` user, who uses it through the `docker` group. It's separate from your host's Docker: Claude doesn't see your other containers, and paths such as `/workspace` mean the same thing to `docker run -v` as they do in the shell. Images and build cache live in the `docker-data` volume. Containers Claude starts stop when the sandbox stops. `docker compose run` one-off commands such as `login` and `status` don't start Docker.

> [!WARNING]
> Docker-in-Docker needs a privileged container. Code inside it, including anything Claude runs, can take over the Docker host, so this removes the sandbox boundary. Only turn it on for a host you're willing to hand to Claude.

If Docker doesn't start, the container log says why and `/var/log/dockerd.log` has the details. Common causes are a host that doesn't allow privileged containers, or a Docker host that is itself a container, such as a Proxmox LXC container without nesting. To pass daemon options, mount a `daemon.json` at `/etc/docker/daemon.json`.

## Chromium

`chromium` is at `/usr/bin/chromium`, and `CHROME_BIN`, `CHROME_PATH` and `PUPPETEER_EXECUTABLE_PATH` point there. For example, `chromium --headless --screenshot=page.png https://example.com`. Chromium's own sandbox can't start in an unprivileged container, so the image turns it off with `--no-sandbox` (in `/etc/chromium.d/claude-sandbox`); the container is the sandbox.

Playwright can use it with `chromium.launch({ executablePath: '/usr/bin/chromium' })`. Its own downloaded browsers (`npx playwright install chromium`) also run, because the system libraries they need are installed.

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
| `CLAUDE_DOCKER` | `0` | `1` starts [Docker inside the sandbox](#docker-inside-the-sandbox); needs a privileged container |
| `CLAUDE_WEBUI` | `1` | `0` turns the [web UI](#web-ui) off in `server` mode |
| `CLAUDE_WEBUI_PASSWORD` | | Web UI password. Without it, the first visit creates one with the setup code from the log |
| `CLAUDE_WEBUI_PORT` | `8765` | Port the web UI listens on inside the container |
| `CLAUDE_WEBUI_HOST` | all interfaces | Address the web UI listens on inside the container |
| `CLAUDE_WEBUI_TLS_CERT`, `CLAUDE_WEBUI_TLS_KEY` | | PEM certificate and key files; the web UI then serves HTTPS |
| `CLAUDE_SANDBOX_WEBUI_PORT` | `8765` | Compose only: host port for the web UI, such as `127.0.0.1:8765` |

Settings saved in the web UI fill in any of the Claude, GitHub, git and Remote Control variables above that the environment leaves unset. Any other [Claude Code environment variable](https://code.claude.com/docs/en/env-vars) works as usual. Claude Code's auto-updater is off (`DISABLE_AUTOUPDATER=1`); new releases arrive with new image tags.

## Modes

Pass a mode as the container command, for example `docker run … ghcr.io/loganrf/claude status`.

| Mode | What it runs |
| --- | --- |
| `auto` (default) | `runner` if an environment secret is set, otherwise `interactive` with a TTY, otherwise `server` |
| `interactive` | `claude` in the terminal, plus `--remote-control` when a claude.ai login exists |
| `server` | `runner` if an environment secret is set, otherwise `webui`. With `CLAUDE_WEBUI=0`: `remote-control`, or `idle` with the reason logged |
| `webui` | The [web UI](#web-ui), which runs `remote-control` whenever it can |
| `remote-control` | `claude remote-control`; exits with the reason if it can't |
| `runner` | `claude self-hosted-runner` |
| `login` | `claude auth login` (claude.ai account) |
| `setup-token` | `claude setup-token` |
| `status` | What the container detected and which mode `server` would pick; `status --json` for scripts |
| `prepare` | Apply settings (git identity, credential helper, clone `GIT_REPO_URL`) and exit |
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
| `/home/claude/.claude/claude-sandbox` | Web UI password hash and saved settings |
| `/var/lib/docker` | Images and containers of [Docker inside the sandbox](#docker-inside-the-sandbox) (`docker-data` volume) |

On Linux, the entrypoint switches the `claude` user to the owner of a bind-mounted `/workspace`, so files Claude creates belong to you on the host. Create the folder before the first start (`mkdir -p workspace`); otherwise Docker creates it as root.

## Use it as a dev container

Copy [`examples/devcontainer/devcontainer.json`](examples/devcontainer/devcontainer.json) to `.devcontainer/devcontainer.json` in any project. It passes `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN` from your machine and keeps the login in a shared `claude-code-config` volume. After `claude auth login` in the container terminal and a rebuild, the dev container is also reachable from claude.ai/code.

## What the sandbox does and doesn't protect

- **Contained**: Claude Code runs as an unprivileged user in a container and sees only what you mount. It has no sudo unless you set `CLAUDE_SUDO=1`. That makes `CLAUDE_PERMISSION_MODE=bypassPermissions` a reasonable choice for unattended work on trusted repositories.
- **Not contained**: anything inside the container is readable by code Claude runs. That includes your tokens, the login in `/home/claude/.claude`, settings saved in the web UI, and the mounted workspace, which Claude can change. Use narrowly scoped tokens, such as a fine-grained `GH_TOKEN` for one repository, and don't mount `~/.ssh` or cloud credentials.
- **Docker**: with [`compose.docker.yaml`](#docker-inside-the-sandbox) the container is privileged, and code in it can take over the Docker host. Without it, Docker doesn't run.
- **Web UI**: whoever can sign in to it controls the container's Claude login, tokens and Remote Control. It runs as the `claude` user, so it has no more access than Claude itself. See [Keep it private](#keep-it-private).
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

- **See what the container detected**: the web UI's Overview, or `docker compose run --rm claude status`. Inside a session, `/status` shows the same from Claude Code's side.
- **Not on claude.ai/code**: the web UI's Remote Control page shows why and Remote Control's own output. Common causes are no stored login, an API key, or Remote Control turned off for a Team or Enterprise organization.
- **Web UI unreachable**: check that port 8765 is published (`docker compose ps`) and not taken by something else; change the host side with `CLAUDE_SANDBOX_WEBUI_PORT`. `docker compose logs claude` shows the web UI's own messages.
- **Lost the setup code**: `docker compose logs claude | grep 'setup code'`, or `docker compose exec claude cat /home/claude/.claude/claude-sandbox/setup-code`.
- **Forgot the web UI password**: see [Reset the web UI password](#password).
- **`Remote Control requires a full-scope login token`**: you're authenticated with `CLAUDE_CODE_OAUTH_TOKEN`. Run the `login` command.
- **Login expired**: sign in again on the web UI's Claude page, or run `docker compose run --rm claude login`.
- **Permission denied in `/workspace`**: set `HOST_UID` and `HOST_GID` to your `id -u` and `id -g`.
