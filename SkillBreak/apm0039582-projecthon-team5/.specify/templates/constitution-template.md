# [PROJECT_NAME] Constitution

## Core Principle

### I. Design Authority

`DESIGN-v2.md` is authoritative for architecture, product behavior, security, and
cross-feature decisions. New feature specifications MUST read and follow it and
may add only feature-specific requirements and implementation details.

Feature specifications, plans, tasks, checklists, and implementation MUST NOT
redefine or contradict its architecture, authentication, authorization,
messaging, game flow, catalog, sandbox, Projection, SSE, or infrastructure
decisions. If a feature needs a change to `DESIGN-v2.md`, the conflict MUST be
explicitly surfaced and human approval obtained before finalizing the
specification or implementing the conflicting change.

Code is evidence of current implementation, not automatic authority over the
design. Differences are implementation gaps or design conflicts and MUST be
reported, not silently harmonized. Existing unresolved design questions,
including Q15, remain unresolved until approved; do not guess.

## Governance

This principle applies to every Spec Kit workflow and artifact. Changes to
design authority require explicit human approval. Before finalizing a
specification or implementation, review it against this principle. Workflow
guidance and templates point to this constitution rather than duplicating its
policy. Constitution amendments require human approval and update the
SemVer version and effective date.

**Version**: [CONSTITUTION_VERSION] | **Effective**: [EFFECTIVE_DATE]
