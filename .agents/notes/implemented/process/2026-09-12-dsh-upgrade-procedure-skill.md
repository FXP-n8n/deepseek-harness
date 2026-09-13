# Agent Note: The upgrade procedure lives in a repository skill

Status: implemented

English | [中文](2026-09-12-dsh-upgrade-procedure-skill.zh.md)

## Problem

Nothing in the repository states, in one place, what an upgrade moves and what it leaves alone, so an operator must reconstruct the answer from the launcher's flags, the desktop runtime description, the Session format records, and the npm release sequences.

The failure modes are quiet rather than loud: a profile is never upgraded in place, a dist-tag need not name the newest build, and Session data converts forward only.

## Decision

`.agents/skills/dsh-upgrade` owns the upgrade procedure as one agent-facing instruction: identify the install shape, move the runtime, leave the product data, and verify the result.

The skill owns the sequence and the failure modes: the four install shapes and their upgrade actions, the source-checkout integrate-reinstall-rebuild-restart order, the published-CLI install-and-confirm step, the `dsh plugin` forwarding path, `--from-default-profile` initializing a new profile instead of upgrading an existing one, and the Session forward-only rule.

It defers to the owners that already carry a fact and links them instead of restating them: [Session format version and release status](../../../../docs/session-format-status.md) for the writer version and the latest published format, [npm release sequences](2026-08-10-npm-release-sequences.md) for how a version reaches the registry and which dist-tag carries it, and [architecture](../../../../docs/architecture.md) for the desktop runtime and its external-plugin arrangement.

The invariant the skill states once is the product data: `$DSH_HOME` keeps profiles, sessions, settings, attachments, and storages while the runtime moves.

## Alternatives considered

**A `docs/` guide.** A guide for a human reader would duplicate the launcher's flag reference and the release records that already own their facts.

**Extending a package README.** No package owns the upgrade: the CLI launcher, the profile bundles, the desktop runtime, and the Session format each own a part while the procedure spans all four.

**A prose Agent Note only.** A note records the decision and cannot be invoked, so the procedure would still be reconstructed at each upgrade.

**Restating the release sequence in the skill.** Registry tags and workflows move with the release process, so a copy inside the skill would drift from its owner.

## Consequences

An upgrade now starts from one instruction file instead of four owners, and that file is the maintenance point for the procedure: a change to profile initialization, to the launcher's flags, or to the Session forward-only rule must update the skill in the same change.

The skill deliberately holds no release-side procedure — cutting and publishing a release remains with the release scripts and workflows — and it states no install command that the launcher does not expose.
