# ADR-0002: Backend stack traces are collected via OpenTelemetry, not merged in the log pipeline

- **Status:** Accepted (2026-07-06)
- **Deciders:** Hans Kristian Flaatten (platform), real-boot validation 2026-07-06
- **Related:** [[0001-state-in-grafana-shared-db]] (style), the backend-exceptions
  how-to (docs/observability/apm/how-to/backend-exceptions-as-issues.md),
  helm-charts#425, helm-charts#426

## Context

The Issues tab groups backend exceptions read from Loki. How coherent an Issue
is depends entirely on how the exception reaches Loki, and the platform reads
three shapes:

- **Shape A** — OTLP log export: `exception.type/message/stacktrace` land as
  Loki structured metadata; the Issue carries the class and the full stack.
- **Shape B** — structured JSON on stdout: the stack lives in the JSON body
  (`stack_trace`/`stack`); grouped by message, stack readable in the drawer.
- **Shape C** — plaintext stack trace on stdout: lossy.

The problem is specific to shape C. A multi-line plaintext stack trace printed
to stdout is not one Loki entry — fluentbit ships each physical line as its own
log record, so one exception fragments into N separate Loki entries (proven
live: a single `SocketException` became **36 entries**). The Issue then shows
the lead line with no coherent stack attached.

The tempting fix is to make the log pipeline reassemble those N lines back into
one record — a multiline merge in fluentbit or fluentd. This ADR records why we
are not doing that, and where a coherent stack trace comes from instead.

## Decision

Backend stack traces are reported through one of two application-side paths:

- **Shape A — OpenTelemetry (OTLP log export).** The collector sends each log
  record to Loki's OTLP endpoint; the semconv exception attributes become
  structured metadata. This is the only path to a first-class Issue.
- **Shape B — structured JSON logging to stdout,** with the stack trace in the
  JSON body. Grouped by message, stack readable in the occurrence drawer.

The platform will **not** merge plaintext stack traces in the log pipeline.
Plaintext stdout stays shape C and stays lossy, and we accept that. Teams that
want a coherent stack enable OTLP log export (shape A) or log structured JSON
(shape B) — both are application-side changes, not platform work.

## Options evaluated

### fluentbit tail multiline — rejected

The apparently-cheap fix: have the fluentbit **tail** input reassemble the
fragmented lines with a multiline parser. Real-boot testing (fluent-bit v5.0.8)
proved it **merges nothing**:

- On the tail input, `multiline.parser` and the `parser` / `key_content`
  settings are **inert** — line reassembly by a custom regex is a multiline
  *filter* feature, and the FluentbitAgent CRD (v6.7.0) does not expose that
  filter. Tail multiline is first-match only and cannot chain `cri` with a
  custom parser, so it can't strip the CRI envelope *and* merge.
- Worse, forcing it on **regresses CRI envelope stripping fleet-wide**: the
  operator drops `Parser cri` when a tail multiline parser is set, so every
  service's log lines keep their raw CRI envelope.

The decisive lesson: `helm template`, `fluent-bit --dry-run`, and static review
all passed this configuration — only a real boot on a live agent exposed that it
did nothing and broke envelope stripping (see helm-charts#425, helm-charts#426).

### fluentd concat / detect_exceptions — rejected

Technically viable: `fluent-plugin-concat` or `detect_exceptions` can stitch
multi-line traces back together. But it is a **fleet-wide log-pipeline change**
whose blast radius is all log collection for every service, and it merges only
*plaintext* traces. With OTLP already providing a coherent, structured path
(shape A), that blast radius is not justified.

## Consequences

- A proper stack trace comes from OTLP (shape A) or JSON stdout (shape B). No
  platform log-merging work is on the roadmap, and none is implied as "coming".
- Plaintext stdout (shape C) remains lossy by design — fragmented across Loki
  entries, lead line only. This is documented in the backend-exceptions how-to.
- Teams reach first-class Issues by enabling OTLP log export; the ceiling on the
  default stdout path is shape B (structured JSON with the stack in the body).
- Validation lesson carried forward: for log-pipeline changes, `--dry-run` and
  `helm template` are insufficient gates — a real agent boot is required.
