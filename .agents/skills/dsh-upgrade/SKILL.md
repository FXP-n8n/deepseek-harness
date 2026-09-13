---
name: dsh-upgrade
description: Use when upgrading a DeepSeek Harness installation to a newer release — identifying which install shape is being upgraded, moving a source checkout, a published dsh CLI, or the desktop application to a new version, updating a profile's bundles and plugins, and verifying what survived.
---

# Upgrading DeepSeek Harness

An upgrade replaces the runtime and leaves supported product data alone. Identify the install shape first: the runtime moves, while `$DSH_HOME` (default `~/.dsh`) keeps `profiles/`, `sessions/`, `settings.yaml`, `attachments/`, and `storages/` for every shape below. Only session data is converted, and only forward.

## Identify the install shape

| Shape | Where its runtime lives | Upgrade action |
| --- | --- | --- |
| Source checkout | the Git working tree, launched as `pnpm dsh` through `tsx` | integrate a newer `master`, then reinstall |
| Published CLI | the installed `@deepseek-ai/dsh` package | install a newer version or dist-tag |
| Desktop application | the signed app's bundled runtime | install the newer application |
| Profile plugins | `$DSH_HOME/profiles/<name>` | `dsh plugin` against that profile |

Read the current version and the composed profile before changing anything. `--dump-config` composes the bundle layers with the profile's own user layer and exits without booting, so a release that composes wrongly fails visibly.

```sh
pnpm dsh --version                            # or: dsh --version
pnpm dsh --profile web --dump-config | head    # or: dsh --profile web --dump-config
```

## Decide whether an upgrade exists

An upgrade has a target, so compare what is installed with what the target provides and stop when the installed runtime already contains it. `git describe --tags` answers both halves for a checkout: the newest reachable release tag plus the commit distance from it, and a distance ahead of zero means `master` already carries that release.

```sh
git fetch origin
git log --oneline -1 origin/master            # target commit
git describe --tags master                     # newest release tag and distance
npm view @deepseek-ai/dsh dist-tags            # published targets
```

A checkout whose `master` equals `origin/master` and whose describe distance is positive has nothing to upgrade, and so does a published install whose `dsh --version` equals the newest dist-tag it wants. Report that and change nothing; reinstalling and restarting a runtime that already contains the target only risks the data below.

## Source checkout

1. Park local work on a branch first. Uncommitted edits to tracked files block the integration, and untracked files are not protected at all.

```sh
git status --short --branch
```

2. Fetch and integrate the newer `master`.

```sh
git fetch origin
git merge --ff-only origin/master     # clean checkout
git rebase origin/master              # a branch carrying local commits
```

A local branch survives `git reset --hard` on `master` and worktree recreation, but only a pushed branch survives a fresh clone.

3. Reinstall, because the manifests and the lockfile travel with the release.

```sh
pnpm install
```

4. Rebuild the artifacts the browser surface serves. A source launch resolves Host packages from `src` through `tsx`, while the Web bundle comes from the built tree, so rebuild after a release that changes client or Web code.

```sh
pnpm run build
```

5. Restart the host process. A running `pnpm dsh web` keeps the old code in memory until it is replaced. An agent running inside that host cannot restart the process hosting it: hand this step to the operator, or restart out of band, and resume the session afterwards.

6. Verify before continuing work: `pnpm dsh --version`, `pnpm dsh --profile web --dump-config`, boot the profile, and resume one session.

## Published CLI

The published package is `@deepseek-ai/dsh`, and its bin is `dsh`. Install an explicit version or dist-tag and confirm the result, because a dist-tag is a mutable alias that does not necessarily name the newest build — at the time of writing `latest` was `0.1.5-rc.1` while `next` was `0.1.5-rc.2`.

```sh
npm view @deepseek-ai/dsh dist-tags
pnpm add -g @deepseek-ai/dsh@<version-or-tag>    # or: npm install -g @deepseek-ai/dsh@<version-or-tag>
dsh --version
```

Upgrading the CLI does not modify an existing `$DSH_HOME/profiles/<name>`. A profile is initialized on first use from a shipped template, and its bundle pins live in its own `package.json` and lockfile.

## Profile bundles and plugins

`dsh plugin --profile <name> <pnpm arguments>` forwards its arguments to pnpm inside the profile directory, so a bundle or plugin version moves the same way an ordinary dependency does.

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-app@<version>
dsh plugin --profile web update
```

To adopt a changed shipped template, initialize a new profile from it. `--from-default-profile <template>` copies only the template's bundle list and patch-reload policy into a new, unused profile name; shipped names are reserved, an existing directory is refused by naming its `package.json`, and no profile is upgraded in place. Compare the shipped layers with the local delta before copying the user layer across.

```sh
dsh --profile web --dump-default-config          # shipped layers only
dsh --profile web --dump-config                  # with the profile's user layer
dsh --profile rescue --from-default-profile web   # new profile from the current template
```

Shipped templates are `acp`, `web`, `headless`, `sdk`, and `sdk-minimal`. The desktop profile is reserved: `dsh plugin` rejects it with `profile "desktop" is managed exclusively by the Electron application`.

## Desktop application

The desktop app carries its exact dsh runtime in signed application resources. `$DSH_HOME/profiles/desktop` holds external plugins and links to host-owned packages, so a compatible upgrade retains the plugin files and refreshes those links without installing core dependencies. Replace the application; do not manage the desktop profile through the CLI.

## What an upgrade never converts

- **Product data.** Profiles, settings, attachments, storages, and sessions belong to the profile and the user, not to the runtime.
- **Session data.** A newer runtime converts older session data on first read, and the previous runtime cannot read data the newer one published; a published generation is never rolled back. A downgrade is therefore a data decision, not only a version number, and a prerelease publication establishes the same obligation as a stable one.
- **The released-format record.** [Session format version and release status](../../../docs/session-format-status.md) owns the current writer version and the latest published format; [npm release sequences](../../notes/implemented/process/2026-08-10-npm-release-sequences.md) own how a version reaches the registry and which dist-tag carries it.

Keep a copy of `$DSH_HOME` before any downgrade, and treat a session opened by a newer runtime as belonging to that runtime.

## Dev Note

None.
