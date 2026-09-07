# Diagram Catalogue

Every PlantUML diagram embedded in the guide has its source here so it can be re-rendered, edited, or reused in slides.

## Rendering

```bash
# One-time: download PlantUML (needs Java 17+ and Graphviz for some diagram types)
curl -L -o plantuml.jar https://github.com/plantuml/plantuml/releases/latest/download/plantuml.jar

# Render every diagram to PNG and SVG next to its source
java -jar plantuml.jar -tpng diagrams/*.puml
java -jar plantuml.jar -tsvg diagrams/*.puml

# Or use the helper script
./diagrams/render.sh
```

Mermaid diagrams are embedded directly in the chapters and render natively on GitHub, GitLab, VS Code (with the
Markdown Preview Mermaid Support extension), Obsidian, and most documentation sites.
To export Mermaid to images use `npx @mermaid-js/mermaid-cli -i chapter.md -o out.md`.

## Naming

`<chapter-slug>-<diagram-slug>.puml`, for example `cluster-architecture-replication-sequence.puml`.

## Index

| Source | Chapter |
|--------|---------|
| `01-core-concepts-producer-consumer-flow.puml` | [01-fundamentals/01-core-concepts.md](../01-fundamentals/01-core-concepts.md) |
| `02-cluster-architecture-deployment.puml` | [01-fundamentals/02-cluster-architecture.md](../01-fundamentals/02-cluster-architecture.md) |
| `03-storage-internals-tiered-storage.puml` | [01-fundamentals/03-storage-internals.md](../01-fundamentals/03-storage-internals.md) |
| `04-producer-internals-idempotent-produce.puml` | [01-fundamentals/04-producer-internals.md](../01-fundamentals/04-producer-internals.md) |
| `05-consumer-internals-rebalance.puml` | [01-fundamentals/05-consumer-internals.md](../01-fundamentals/05-consumer-internals.md) |
| `admin-01-installation-and-deployment-topology.puml` | [03-admin/01-installation-and-deployment.md](../03-admin/01-installation-and-deployment.md) |
| `admin-02-configuration-reference-change-flow.puml` | [03-admin/02-configuration-reference.md](../03-admin/02-configuration-reference.md) |
| `admin-03-topic-and-partition-management-reassignment.puml` | [03-admin/03-topic-and-partition-management.md](../03-admin/03-topic-and-partition-management.md) |
| `admin-04-cluster-operations-rolling-restart.puml` | [03-admin/04-cluster-operations.md](../03-admin/04-cluster-operations.md) |
| `admin-05-monitoring-and-observability-pipeline.puml` | [03-admin/05-monitoring-and-observability.md](../03-admin/05-monitoring-and-observability.md) |
| `admin-06-security-multi-listener-topology.puml` | [03-admin/06-security.md](../03-admin/06-security.md) |
| `admin-07-backup-recovery-and-dr-multi-region-deployment.puml` | [03-admin/07-backup-recovery-and-dr.md](../03-admin/07-backup-recovery-and-dr.md) |
| `admin-08-upgrades-and-migration-zk-to-kraft-phases.puml` | [03-admin/08-upgrades-and-migration.md](../03-admin/08-upgrades-and-migration.md) |
| `admin-09-troubleshooting-runbooks-incident-handling.puml` | [03-admin/09-troubleshooting-runbooks.md](../03-admin/09-troubleshooting-runbooks.md) |
| `capacity-planning-and-sizing-storage-stack.puml` | [04-architect/01-capacity-planning-and-sizing.md](../04-architect/01-capacity-planning-and-sizing.md) |
| `cloud-and-managed-kafka-msk-reference-architecture.puml` | [04-architect/06-cloud-and-managed-kafka.md](../04-architect/06-cloud-and-managed-kafka.md) |
| `consumer-api-poll-commit-sequence.puml` | [02-developer/02-consumer-api.md](../02-developer/02-consumer-api.md) |
| `design-scenarios-and-case-studies-payments-platform.puml` | [04-architect/08-design-scenarios-and-case-studies.md](../04-architect/08-design-scenarios-and-case-studies.md) |
| `error-handling-and-patterns-outbox-cdc.puml` | [02-developer/07-error-handling-and-patterns.md](../02-developer/07-error-handling-and-patterns.md) |
| `governance-multitenancy-and-platform-platform-components.puml` | [04-architect/07-governance-multitenancy-and-platform.md](../04-architect/07-governance-multitenancy-and-platform.md) |
| `integration-and-data-architecture-patterns-outbox-cdc-sequence.puml` | [04-architect/05-integration-and-data-architecture-patterns.md](../04-architect/05-integration-and-data-architecture-patterns.md) |
| `kafka-connect-cluster-architecture.puml` | [02-developer/04-kafka-connect.md](../02-developer/04-kafka-connect.md) |
| `kafka-streams-task-assignment.puml` | [02-developer/03-kafka-streams.md](../02-developer/03-kafka-streams.md) |
| `multi-datacenter-and-multi-region-active-active-deployment.puml` | [04-architect/04-multi-datacenter-and-multi-region.md](../04-architect/04-multi-datacenter-and-multi-region.md) |
| `performance-tuning-latency-anatomy.puml` | [04-architect/02-performance-tuning.md](../04-architect/02-performance-tuning.md) |
| `producer-api-send-sequence.puml` | [02-developer/01-producer-api.md](../02-developer/01-producer-api.md) |
| `resiliency-and-high-availability-reference-architecture.puml` | [04-architect/03-resiliency-and-high-availability.md](../04-architect/03-resiliency-and-high-availability.md) |
| `schema-registry-serialization-flow.puml` | [02-developer/05-schema-registry-serialization.md](../02-developer/05-schema-registry-serialization.md) |
| `testing-and-local-dev-ci-flow.puml` | [02-developer/08-testing-and-local-dev.md](../02-developer/08-testing-and-local-dev.md) |
| `transactions-exactly-once-sequence.puml` | [02-developer/06-transactions-exactly-once.md](../02-developer/06-transactions-exactly-once.md) |
