# Kafka Guide – Authoring Style Guide

This file defines how every chapter in this guide is written so the book stays consistent as it grows.
Follow it for every new chapter, question set, or diagram.

## 1. Audience and roles

Every topic is written for three readers. Each chapter carries role tags in its header:

| Tag | Reader | What they need |
|-----|--------|----------------|
| `[ARCH]` | Kafka Architect | design trade-offs, sizing, topology, failure domains, cost, governance |
| `[ADMIN]` | Kafka Administrator / SRE | configuration, operations, runbooks, monitoring, security, upgrades |
| `[DEV]` | Kafka Developer | client APIs, Streams, Connect, serialization, error handling, testing |

## 2. Chapter template

```markdown
# <Chapter title>

**Roles:** [ARCH] [ADMIN] [DEV]   **Level:** Foundation | Intermediate | Advanced
**Prerequisites:** links to earlier chapters

## What you will learn
- 3 to 6 bullets

## 1. Concept
Explain the mechanism, not just the definition. Use a diagram when a picture shows flow, state, or topology.

## 2. How it works internally
Sequence / state / flow diagram plus prose.

## 3. Configuration that matters
Table: parameter | default | recommended | why

## 4. Failure modes and how to detect them
Table: symptom | likely cause | metric / log to check | fix

## 5. Design guidance (architect view)
Trade-offs, decision table, anti-patterns.

## 6. Hands-on
CLI commands or code, runnable and copy-pasteable.

## 7. Interview questions for this chapter
5 to 10 Q&A pairs, answer 3 to 8 lines each, labelled with role tag and difficulty.

## Key takeaways
- 3 to 6 bullets

## Further reading
Official docs / KIPs by name.
```

Not every section is mandatory for every chapter, but keep the order.

## 3. Diagrams

Diagrams are first-class content. Use them whenever a flow, sequence, topology, state, or decision is explained.

### 3.1 Mermaid (primary – renders on GitHub)

Use fenced blocks with the `mermaid` language tag.

- `flowchart LR/TD` for data flow, decision trees, topology
- `sequenceDiagram` for request/response and protocol interactions
- `stateDiagram-v2` for lifecycles (partition leader, consumer group, transaction)
- `classDiagram` sparingly for API structure
- `gantt` / `timeline` for migration plans

Rules:
- Keep to about 15 nodes per diagram; split large ones.
- Label edges with the message or condition.
- Wrap node labels containing special characters in quotes: `A["Broker 1 (leader)"]`.
- Never use `%%` comments inside a node label.

### 3.2 PlantUML (secondary – deployment, component, detailed sequence)

Use fenced blocks with the `plantuml` language tag and also save the source under `diagrams/` as a `.puml` file
named `<chapter-slug>-<diagram-slug>.puml`.

```plantuml
@startuml
skinparam shadowing false
skinparam defaultFontName Helvetica
' diagram body
@enduml
```

Render locally with:
```bash
java -jar plantuml.jar diagrams/*.puml
```
or paste into https://www.plantuml.com/plantuml/uml/ .

### 3.3 ASCII

Only for tiny layouts (log segment layout, byte formats) where a picture adds nothing.

## 4. Question bank format

```markdown
### Q<number>. <Question text>
**Role:** [ARCH] | **Difficulty:** ★★☆ | **Topic:** Replication

**Answer.**
Direct answer in the first sentence. Then the mechanism, then the trade-off or gotcha.
Include a config value, metric name, or command when it makes the answer concrete.

**Follow-up probes.** What an interviewer asks next.
```

Difficulty: ★☆☆ foundation, ★★☆ intermediate, ★★★ advanced/expert.

Scenario questions add a **Situation**, **Constraints**, **Expected reasoning**, and **Model answer** section.

## 5. Writing rules

- Lead with the answer, then the why.
- Prefer tables for configuration and comparisons.
- Every configuration name is in backticks: `min.insync.replicas`.
- State the Kafka version when behavior changed (for example "since 3.3 KRaft is production-ready", "since 4.0 ZooKeeper is removed").
- Commands are complete and runnable; include the `--bootstrap-server` flag.
- Call out anti-patterns in a blockquote starting with **Anti-pattern:**.
- Call out production tips in a blockquote starting with **Production tip:**.
- No marketing language. No unverified numbers presented as facts; when giving throughput figures say they are indicative.

## 6. Versioning content

- Baseline for this guide: Apache Kafka 3.9 / 4.0 (KRaft only). Mention ZooKeeper only for migration and legacy operations.
- When something is Confluent-specific, MSK-specific, or Redpanda-specific, say so explicitly.

## 7. Adding content later

1. Add or edit the chapter under the right role folder.
2. Add questions to the matching file in `05-question-bank/` and keep numbering sequential within that file.
3. Save new PlantUML sources under `diagrams/`.
4. Add a line to `CHANGELOG.md` with the date and what was added.
5. Update the index in `README.md` if a new chapter was created.
