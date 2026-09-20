# ADR-0008: Independent adapter versions, peer ranges, and a min/latest/next CI matrix

Status: accepted (2026-09-20)

## Decision

- Each adapter has its own semver and declares the upstream framework as a peer (npm) or a ranged
  dependency (PyPI): current major, plus the previous major while upstream maintains it.
- CI runs every adapter against `min`, `latest` and `next` (pre-release or default branch) of its
  upstream. `min` and `latest` gate merges; `next` runs nightly and opens an issue on failure.
- Every README states the tested upstream versions and date, generated from the CI matrix file.
- Core changes are released first; adapters depend on a caret range of the core.

## Consequences

Upstream breakage is seen weeks before it ships, per adapter, without blocking unrelated work.
