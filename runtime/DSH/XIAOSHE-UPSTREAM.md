# Xiaoshe maintained DSH snapshot

- Upstream: https://github.com/deepseek-ai/deepseek-harness
- Tag: `dsh-v0.1.5-rc.2` (release candidate, not a stable release)
- Commit: `fb2c4b9e698e30edb738bca4cf0618587db7d203`
- Imported on: 2026-09-12
- Previous snapshot: `dsh-v0.1.0-rc.8`, `141eb6fef83422698aef7a981029e843e8161534`

This directory is a maintained source snapshot, not an unmodified upstream checkout.
Future upgrades must compare the official base, the new upstream and the entire local working tree.
Do not replace it wholesale: Xiaoshe retains settings CAS/degraded-state recovery, owned file-lock recovery,
public-network validation, request cancellation, product identity, tool evidence and local event migrations.

The official Session Log and public Remote services remain authoritative. Xiaoshe's client adapter,
terminal transport, task timeline and completion receipts consume them; they do not introduce a second log.
Native PTC call/result evidence and four Xiaoshe durable event types are preserved in V3 migration.
The generic upstream chat root is not mounted over Xiaoshe's existing product UI.

Local compatibility tests remain connected through this package's standard `test` entry, before the
upstream native/Vitest suite. Host/client compilation, browser mounting, real RPC and owned desktop
startup are separate checks. Passing Windows checks does not certify macOS, installers or code signing.
The detailed local verification record is in the XS root's `output/stabilization/dsh-upgrade-20260912/`.
