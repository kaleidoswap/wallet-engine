# Security Policy

`@kaleidorg/wallet-engine` moves real funds across Bitcoin L2s. We take security
seriously and welcome responsible disclosure.

> **Alpha software.** This engine is experimental and unaudited. Do not use it
> with mainnet funds you cannot afford to lose.

## Reporting a Vulnerability

Please **DO NOT** open a public issue for security vulnerabilities. Instead,
email:

**security@kaleidoswap.com**

### What to Include

- A description of the vulnerability
- Steps to reproduce
- Potential impact (e.g. fund loss, misrouting, key exposure)
- Any suggested fix
- Your contact information for follow-up

### Response Timeline

- **Initial response**: within 48 hours
- **Status updates**: every 7 days until resolved
- **Fix**: as quickly as possible, typically within 30 days

### Disclosure Policy

- Please give us reasonable time to investigate and fix before going public.
- We credit researchers who report responsibly (unless you prefer anonymity).
- Once a fix ships, we publish an advisory describing the issue and the fix.

## Threat Model Notes

When auditing this package, the highest-impact surfaces are:

- **The destination classifier** (`src/router/destination.ts`) and the
  **cross-protocol router** (`src/router/index.ts`) — they decide which protocol
  pays a destination. Misclassification can misroute funds. Matchers are
  deliberately strict and fail closed (→ `UNKNOWN`, no candidates).
- **Adapter escape hatches** (`executeProtocolOperation`) — gated by per-adapter
  allowlists so a caller-supplied operation string cannot reach arbitrary
  account methods or prototype members.
- **Money coercion** at SDK boundaries — guarded against `NaN`/non-finite and
  precision loss past `Number.MAX_SAFE_INTEGER`.
- **Unified receive URIs** — multiple payment methods in one URI are NOT
  cryptographically bound; consumers must surface methods (`receiveMethodsOf`)
  rather than silently auto-pay one.

## Fixing a Vulnerability (maintainers and agents)

This repository is public, and the published packages lag the default branch,
so a merged fix is not a shipped fix. Until a release containing the fix is
published, nothing public may describe the bug in a way that helps exploit the
versions people are running.

- Pull-request titles and bodies, commit messages, issues, comments, code
  comments, test names and the `[Unreleased]` changelog describe the change
  neutrally: what is now validated or refused, not what an attacker could do.
  No references to an unpublished review or audit, no finding numbers, no
  severity ratings, no attack scenarios.
- Exploitable bugs go through a GitHub security advisory with a temporary
  private fork, or a branch the maintainers agree to merge and release
  promptly. The release ships first; the advisory with the full write-up and
  credit is published afterwards.
- When in doubt, ask a maintainer before publishing anything. Edit history on
  GitHub is permanent, so a disclosure cannot be undone.
- Agents: see [AGENTS.md](AGENTS.md) for the same rules in operational form.

## Supported Versions

This project is pre-1.0 (`1.0.0-beta.x`). Only the latest published beta receives
security updates.
