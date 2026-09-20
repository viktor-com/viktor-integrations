# ADR-0006: One language-neutral spec for the delegate tool, errors and recipes

Status: accepted (2026-09-20)

## Decision

- `spec/delegate-tool.json` defines the "delegate to Viktor" tool once: name `delegate_to_viktor`,
  description, input schema (`task`, optional `thread_id`, `response_schema`, `speed`,
  `timeout_seconds`) and output schema (`status`, `markdown`, `json`, `artifacts`, `thread_id`,
  `run_id`). Every adapter in both languages loads it; a test asserts the adapter's tool schema equals it.
- `spec/errors.json` is the error table; core error classes and the README error tables come from it.
- `spec/recipes.yaml` is the framework × surface matrix from which `docs/recipes/*.md` is generated.
- The delegate tool runs over the native REST API, not the compat wire: no 600 s cap, explicit
  `requires_action`, files as signed URLs, explicit thread reuse.

## Consequences

A wording or schema change is one edit. Tool behaviour is identical across frameworks, which also
makes cross-framework evals comparable.
