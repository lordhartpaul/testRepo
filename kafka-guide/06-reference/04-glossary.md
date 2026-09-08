# Glossary and Essential KIPs

**Roles:** [ARCH] [ADMIN] [DEV]   **Level:** Reference
**Prerequisites:** none

## What you will learn
- Precise, short definitions of the terms used throughout this guide, in alphabetical order
- Which KIPs (Kafka Improvement Proposals) shaped the platform and why each still matters

Conventions: configuration names are in backticks; a version in parentheses marks when the concept appeared or changed. Cross-references are in *italics*.

---

## 1. Glossary

### A

**Acks (`acks`)** – Producer setting for how many replicas must persist a batch before the broker acknowledges it: `0` (none), `1` (leader only), `all`/`-1` (every replica in the *ISR*, subject to `min.insync.replicas`). Default `all` since 3.0 (KIP-679).

**ACL (Access Control List)** – An authorization rule binding a principal, host, operation (`Read`, `Write`, `Create`, …) and permission (`ALLOW`/`DENY`) to a resource (topic, group, cluster, transactional id, delegation token). Stored in the metadata log by the KRaft `StandardAuthorizer`. Deny always wins over allow.

**Active controller** – The one controller node in the KRaft quorum that is currently Raft leader and therefore the sole writer of the cluster metadata log; it handles broker registration, leader election and topic changes. Other controllers are standby voters.

**Active segment** – The last, still-writable *log segment* of a partition. It is never eligible for retention or compaction until it rolls.

**Admin client (`AdminClient`)** – Java API (and the base of most CLI tools) for managing topics, configs, ACLs, quotas, consumer groups, offsets, reassignments and features over the Kafka protocol.

**Assignor (partition assignor)** – The strategy that maps partitions to consumer group members: client-side (`RangeAssignor`, `RoundRobinAssignor`, `StickyAssignor`, `CooperativeStickyAssignor`) in the classic protocol, server-side (`uniform`, `range`) in the KIP-848 protocol. Kafka Streams uses its own task assignor.

**At-least-once / at-most-once** – See *delivery semantics*.

**Auto offset reset (`auto.offset.reset`)** – What a consumer does when it has no committed offset or the committed offset no longer exists: `earliest`, `latest`, `none`, and since 4.0 `by_duration:<ISO-8601>` (KIP-1106).

### B

**Batch (record batch)** – The unit of transfer and storage: a set of records to one partition sharing a header (base offset, producer id/epoch, compression codec, CRC, timestamps). Compression applies to the whole batch. Producers build batches per partition up to `batch.size` / `linger.ms`.

**Bootstrap server (`bootstrap.servers`)** – One or more broker addresses a client contacts first to fetch cluster metadata; afterwards the client connects directly to whichever brokers lead the partitions it needs. Since 4.0 clients can re-bootstrap when all known brokers vanish (`metadata.recovery.strategy=rebootstrap`).

**Broker** – A Kafka server process that stores partitions, serves produce/fetch requests and replicates data. In KRaft a node with `process.roles=broker`.

**Broker epoch** – A monotonically increasing number assigned to a broker on each registration with the controller; used to fence requests from stale broker incarnations.

### C

**CDC (Change Data Capture)** – Streaming database changes (inserts, updates, deletes) into Kafka, typically by reading the database transaction log (Debezium) rather than polling tables.

**Changelog topic** – A compacted internal topic that backs a Kafka Streams state store (`<application.id>-<store>-changelog`); it is used to restore state on failover and to feed *standby replicas*.

**Checkpoint** – (1) Broker files (`replication-offset-checkpoint`, `recovery-point-offset-checkpoint`, `log-start-offset-checkpoint`) recording per-partition offsets. (2) Kafka Streams `.checkpoint` file recording the changelog offset up to which a local store is consistent. (3) MirrorMaker 2 record in `<source>.checkpoints.internal` mapping a group's source offset to the target offset.

**Claim check** – Integration pattern for oversized payloads: store the payload in object storage and publish only a reference (URL/id) to Kafka.

**Client id (`client.id`)** – Logical name a client sends with every request; used for quotas, logging, metrics and request tracing. Not unique per instance unless you make it so.

**Cluster id** – A 22-character base64 UUID identifying a Kafka cluster; generated with `kafka-storage.sh random-uuid` and stamped into every log directory's `meta.properties` at format time.

**Cluster linking** – Confluent-specific broker-level replication of topics between clusters that preserves offsets (byte-for-byte mirror topics). Not part of Apache Kafka; the open-source equivalent is *MirrorMaker 2*.

**Committed offset** – The offset a consumer group has stored (in `__consumer_offsets`) for a partition: the position of the **next** record to process. Distinct from *high watermark* (the broker's notion of committed data).

**Compaction (log compaction)** – Retention mode (`cleanup.policy=compact`) that keeps at least the latest record for every key and removes older duplicates; *tombstones* delete a key. Run by the *log cleaner*.

**Compression** – Batch-level codec (`gzip`, `snappy`, `lz4`, `zstd`) chosen by the producer; the broker keeps it unless `compression.type` on the topic/broker forces recompression.

**Consumer group** – A set of consumers sharing a `group.id`; each partition of a subscribed topic is assigned to exactly one member at a time, giving parallelism with per-partition ordering. Membership and offsets are managed by the *group coordinator*.

**Controller quorum** – The set of KRaft controller nodes (usually 3 or 5) that replicate the metadata log with Raft. A majority must be available to make metadata changes. Static (`controller.quorum.voters`) or dynamic (`kraft.version=1`, 3.9, KIP-853).

**Cooperative rebalancing (incremental cooperative rebalancing)** – Rebalance protocol (2.4, KIP-429; Connect 2.3, KIP-415) in which members keep the partitions they retain and only revoke the ones that move, avoiding the stop-the-world of eager rebalancing. Default for KIP-848 groups.

**Co-partitioning** – Requirement for joins in Kafka Streams: both input topics must have the same number of partitions and the same partitioning of keys so that matching keys land in the same task. Violations cause `TopologyException` or, worse, silently wrong joins after a partition count change.

**Coordinator** – See *group coordinator*, *transaction coordinator*, *share coordinator*.

### D

**Dead letter topic (DLQ)** – A topic that receives records that could not be processed (deserialization failure, sink error) so that the pipeline can continue. Built into Connect sinks (`errors.deadletterqueue.topic.name`); application-defined in consumers and Streams.

**Delegation token** – A short-lived, renewable credential issued by brokers (`kafka-delegation-tokens.sh`) that lets a job authenticate with SASL/SCRAM-like tokens instead of distributing Kerberos keytabs or passwords, typical for Spark/Flink workers. Requires `delegation.token.secret.key`.

**Delivery semantics** – The guarantee between producer and consumer: **at-most-once** (may lose, never duplicates), **at-least-once** (never loses, may duplicate; default with `acks=all` and commit-after-process), **exactly-once** (neither; requires idempotent/transactional producer and `read_committed` consumer or Streams EOS).

**Deserialization exception handler** – Streams hook (`deserialization.exception.handler`, formerly `default.deserialization.exception.handler`) that decides whether a *poison pill* fails the task or is skipped.

**Dirty ratio (`min.cleanable.dirty.ratio`)** – Fraction of a compacted log (bytes not yet compacted / total bytes) above which the *log cleaner* will pick that log. Default 0.5.

**Diskless topics** – Proposed topic type (KIP-1150, under discussion) whose data is written directly to object storage by a leaderless set of brokers, trading latency for cross-AZ cost savings. See the roadmap chapter.

### E

**Eager rebalancing** – The original rebalance protocol where every member revokes all partitions before a new assignment is computed. Replaced by *cooperative rebalancing*.

**Eligible Leader Replicas (ELR)** – (4.0, KIP-966) Replicas that dropped out of the ISR only because the ISR shrank to `min.insync.replicas`, and are therefore known to hold every committed record. They may be elected leader when the ISR is empty, removing a class of data loss without *unclean leader election*.

**Epoch** – A monotonically increasing counter that fences stale actors: *leader epoch* (per partition, per leader change), *producer epoch* (per producer id, bumped on transactional init and, with transaction v2, on every commit), *broker epoch*, controller/Raft epoch, consumer *member epoch* (KIP-848).

**Exactly-once semantics (EOS)** – End-to-end guarantee built from the idempotent producer, transactions spanning output records and consumer offset commits, and `isolation.level=read_committed` on consumers. In Streams enabled with `processing.guarantee=exactly_once_v2`.

### F

**Feature (feature level)** – A versioned capability recorded in the metadata log and managed with `kafka-features.sh`: `metadata.version`, `kraft.version`, `transaction.version`, `group.version`, `eligible.leader.replicas.version`, `share.version`. Replaces `inter.broker.protocol.version`.

**Fencing** – Rejecting requests from an actor whose *epoch* is older than the current one: zombie producers (`ProducerFencedException`), stale brokers, old controllers, consumers with an outdated member epoch, and Streams tasks after failover.

**Fetch** – The request consumers and followers use to read records from a partition leader (or a follower with *follower fetching*). Long-polls up to `fetch.max.wait.ms` for `fetch.min.bytes`; uses incremental fetch sessions (KIP-227) to avoid resending the partition list.

**Follower** – A replica that is not the leader; it fetches from the leader to stay in sync and serves reads only when follower fetching is enabled.

**Follower fetching (fetch from follower)** – (2.4, KIP-392) Consumers with `client.rack` read from a replica in their own rack chosen by `replica.selector.class=RackAwareReplicaSelector`, cutting cross-AZ traffic at the cost of slightly higher lag.

### G

**Grace period** – In Streams windowed aggregations, how long after a window's end late records are still accepted (`ofSizeAndGrace`). After the grace period the window is closed and late records are dropped (`dropped-records` metric).

**Group coordinator** – The broker that owns a consumer group's partition of `__consumer_offsets` (chosen by hashing the group id) and handles joins, heartbeats, assignments and offset commits for that group.

**Group protocol (`group.protocol`)** – `classic` (client-side assignment, JoinGroup/SyncGroup) or `consumer` (4.0, KIP-848, server-side assignment via `ConsumerGroupHeartbeat`). Streams gets its own `streams` protocol (4.1, KIP-1071).

### H

**Header** – Optional key/value metadata on a record (0.11, KIP-82), used for tracing, schema ids, routing; ignored by the broker.

**Heartbeat** – Periodic liveness signal from a consumer to the group coordinator (`heartbeat.interval.ms`) or from a broker to the active controller (`broker.heartbeat.interval.ms`). Missing heartbeats beyond the session timeout evict the member / fence the broker.

**High watermark (HW)** – The offset up to which all *ISR* replicas have replicated; consumers can only read below it. Advances when the slowest ISR member catches up.

**Hopping window** – Fixed-size, overlapping time windows advanced by a fixed step (`TimeWindows.ofSizeAndGrace(size, grace).advanceBy(step)`); a record belongs to `size/step` windows.

### I

**Idempotent producer (`enable.idempotence`)** – Producer mode (0.11, KIP-98; default since 3.0) where each batch carries a producer id, epoch and sequence number so the broker can discard retried duplicates and enforce order within a partition.

**In-flight requests (`max.in.flight.requests.per.connection`)** – Number of unacknowledged produce requests a producer may have per broker connection. Up to 5 with idempotence while preserving order.

**Interactive queries (IQ)** – Streams API to read local state stores (and discover which instance holds a key) so that an application can serve queries directly from its materialized state. IQv2 (3.2, KIP-796) adds typed queries and position tracking.

**ISR (in-sync replicas)** – The subset of a partition's replicas that are caught up with the leader (fetched within `replica.lag.time.max.ms`). Only ISR members can be elected leader (unless unclean election is enabled) and `acks=all` waits for all of them.

**Isolation level (`isolation.level`)** – `read_uncommitted` (default) returns everything below the high watermark; `read_committed` returns only records below the *last stable offset*, hiding open and aborted transactions.

### J

**JBOD (just a bunch of disks)** – Running a broker with several independent log directories (`log.dirs`) instead of RAID; a failed disk takes only its partitions offline. Supported in KRaft since 3.7 (KIP-858).

### K

**Key** – Optional bytes on a record used by the *partitioner* to choose a partition and by *compaction* to identify the latest value. Records with the same key go to the same partition (as long as the partition count is unchanged).

**KIP (Kafka Improvement Proposal)** – The design document process for any user-facing change to Apache Kafka; numbered sequentially (KIP-1 in 2015, KIP-1150+ in 2025).

**KRaft** – Kafka's built-in Raft-based metadata quorum replacing ZooKeeper (KIP-500). Early access 2.8, production-ready 3.3, migration GA 3.6, dynamic quorum 3.9, the only mode in 4.0.

**KTable / KStream / GlobalKTable** – Streams DSL abstractions: an event stream, a changelog-backed table partitioned across instances, and a table fully replicated to every instance (for broadcast joins).

### L

**Lag** – Distance between a consumer's position (or committed offset) and the *log end offset*; measured in records (or seconds by lag exporters). For followers, the distance to the leader's LEO.

**Last stable offset (LSO)** – The offset below which every transaction is either committed or aborted; the upper bound of what `read_committed` consumers can see. A hanging transaction freezes the LSO.

**Leader** – The replica that handles all writes (and by default all reads) for a partition. Elected by the controller from the ISR; the first replica in the assignment is the *preferred leader*.

**Leader epoch** – Counter incremented on every leader change for a partition; stored in each batch and in `leader-epoch-checkpoint`. Followers and consumers use it to detect truncation and divergence (KIP-101, KIP-279, KIP-320).

**Linger (`linger.ms`)** – How long a producer waits for more records before sending a batch that is not yet full; the primary batching/latency knob.

**Listener** – A named broker endpoint (`listeners`, `advertised.listeners`, `listener.security.protocol.map`) with its own protocol, port and security settings; typical set: internal, external, controller.

**Log** – The append-only sequence of record batches for one partition, stored as *segments* on one broker (replica).

**Log cleaner** – Broker threads that perform *compaction* on `cleanup.policy=compact` logs, building an offset map of keys per pass.

**Log end offset (LEO)** – The offset of the next record to be appended to a replica's log. The leader's LEO minus the HW is the amount of unreplicated data.

**Log segment** – A file pair (`<baseOffset>.log` + `.index` + `.timeindex`, optionally `.txnindex`) holding a contiguous range of a partition's log. Rolled by `segment.bytes` / `segment.ms`; retention and compaction operate on whole closed segments.

**Log start offset** – The earliest offset still available in a partition; advances through retention or `kafka-delete-records.sh`.

### M

**Member epoch** – (KIP-848) Per-member counter in the new consumer protocol; a member whose epoch is behind must reconcile its assignment before it can commit offsets.

**Metadata log (`__cluster_metadata`)** – The single-partition Raft-replicated log in which KRaft controllers record every cluster change (topics, partitions, ISR, configs, ACLs, SCRAM, features, broker registrations). Brokers replay it into an in-memory *metadata image*.

**`metadata.version`** – The feature level that gates which metadata record formats and broker behaviours are enabled; bumped with `kafka-features.sh upgrade` after all nodes run the new binary. Levels look like `3.9-IV0`, `4.0-IV3`.

**Min in-sync replicas (`min.insync.replicas`)** – Minimum ISR size for an `acks=all` write to succeed; below it the leader rejects writes with `NotEnoughReplicasException`. The durability lever paired with replication factor.

**MirrorMaker 2 (MM2)** – Cross-cluster replication built on Connect (2.4, KIP-382): `MirrorSourceConnector` copies topics, `MirrorCheckpointConnector` translates consumer offsets, `MirrorHeartbeatConnector` emits liveness records. Runs on Connect or in dedicated mode (`connect-mirror-maker.sh`). MirrorMaker 1 was removed in 4.0.

### N

**Node id (`node.id`)** – Identifier of a broker or controller in KRaft; unique across both roles.

### O

**Observer** – In KRaft, a node that replicates the metadata log without voting: every broker is an observer of the controller quorum; standby controllers are voters.

**Offset** – The 64-bit, monotonically increasing position of a record within a partition, assigned by the leader on append. Not necessarily contiguous after compaction or transactions (control records occupy offsets).

**`__consumer_offsets`** – Internal compacted topic (50 partitions by default) storing committed offsets and group metadata; its partition leaders are the group coordinators.

**Outbox pattern** – Writing an event to an "outbox" table in the same database transaction as the business change, then publishing the table to Kafka with *CDC*; avoids dual-write inconsistencies.

### P

**Page cache** – Operating-system memory caching file contents; Kafka relies on it for both writes (no explicit fsync by default) and reads (caught-up consumers are served from RAM). The reason brokers run with small JVM heaps.

**Partition** – The unit of parallelism, ordering and replication: an ordered log that lives on one leader and N−1 followers. Topics are split into partitions; consumers in a group split partitions.

**Partitioner** – Producer component that chooses a partition: hash of the key (murmur2) when a key is present; sticky/uniform batching across partitions for null keys (3.3, KIP-794). Custom via `partitioner.class`.

**Poison pill** – A record that cannot be deserialized or processed and would block a consumer forever if it retried; handled with skip-and-log or a *dead letter topic*.

**Preferred leader** – The first replica in a partition's assignment; the controller moves leadership back to it (`auto.leader.rebalance.enable`) to keep load balanced.

**Principal** – The authenticated identity of a client (`User:alice`), derived from the SASL username, TLS certificate DN (via `ssl.principal.mapping.rules`) or a custom `principal.builder.class`.

**Process roles (`process.roles`)** – Which KRaft role(s) a node plays: `broker`, `controller`, or both (combined mode).

**Producer id (PID)** – Broker-assigned identifier for an idempotent/transactional producer session (`InitProducerId`); with its *epoch* and per-partition sequence numbers it enables deduplication and fencing.

**Purgatory** – Broker data structure holding requests that must wait for a condition: produce requests waiting for ISR acks, fetch requests waiting for `fetch.min.bytes`, delayed group operations. Sized by `PurgatorySize` metrics.

### Q

**Quota** – Broker-enforced limits per user/client-id/IP: bytes per second for produce and fetch, request-handler time percentage, controller mutation rate, connection creation rate. Enforced by delaying responses (throttle time), never by rejecting.

**Quorum** – See *controller quorum*.

### R

**Rack awareness** – Placing replicas across failure domains (`broker.rack`) so that a rack/AZ outage does not take all replicas of a partition; also drives *follower fetching* and rack-aware consumer/Streams assignment (KIP-881, KIP-925).

**Raft** – Consensus algorithm KRaft uses for the metadata log: leader election by majority vote, log replication, snapshots.

**Rebalance** – The process of reassigning partitions among consumer group members (or tasks among Streams instances / Connect workers) when membership or subscriptions change.

**Record** – A key, value, timestamp, headers, and (once stored) offset and partition. Also called message or event.

**Remote storage** – See *tiered storage*.

**Repartition topic** – Internal Streams topic (`<application.id>-<name>-repartition`) created when a key-changing operation (`selectKey`, `map`, `groupBy`) is followed by a stateful one; re-partitions records so that equal keys are co-located.

**Replica** – One copy of a partition's log on a broker; the *leader* or a *follower*.

**Replication factor** – Number of replicas per partition (`--replication-factor`, `default.replication.factor`). RF 3 with `min.insync.replicas=2` is the standard durability setup.

**Retention** – Policy deleting old data: time (`retention.ms`), size per partition (`retention.bytes`), or *compaction*. With *tiered storage*, `local.retention.*` govern the on-disk hot set.

**RocksDB** – Embedded LSM key-value store used by Kafka Streams for persistent state stores; memory (block cache, memtables) lives off-heap and must be bounded with a `RocksDBConfigSetter`.

### S

**Saga** – A distributed transaction pattern implemented as a sequence of local transactions with compensating actions, often coordinated through Kafka events instead of two-phase commit.

**SASL** – Simple Authentication and Security Layer; Kafka supports `PLAIN`, `SCRAM-SHA-256/512`, `GSSAPI` (Kerberos), `OAUTHBEARER` (including OIDC since 3.1, KIP-768).

**Schema Registry** – A service (Confluent, Karapace, Apicurio) that stores versioned Avro/Protobuf/JSON schemas per *subject*, enforces compatibility rules, and hands out schema ids that serializers embed in the payload.

**SCRAM** – Salted Challenge Response Authentication Mechanism; password-based SASL where brokers store salted, iterated hashes (in the metadata log in KRaft; bootstrapped with `kafka-storage.sh format --add-scram`).

**Segment** – See *log segment*.

**Sendfile / zero-copy** – Broker optimisation that transfers segment bytes from the page cache to the socket via `sendfile(2)` without copying through user space; it is lost when TLS or record conversion is in the path (TLS moves the copy to the JVM).

**Session window** – Streams window that groups records by key into sessions separated by a gap of inactivity (`SessionWindows.ofInactivityGapAndGrace`); windows merge when a record bridges two sessions.

**Share group** – (4.0 early access, 4.1 preview, KIP-932) A "queue-like" consumption model where records of a partition can be spread across many consumers with per-record acknowledgement, redelivery and delivery-count limits, without the one-consumer-per-partition constraint.

**Share coordinator** – Broker component (4.0+) that persists share-group state (`__share_group_state` topic).

**Sliding window** – Streams window (2.7, KIP-450) defined relative to each record's timestamp (`SlidingWindows.ofTimeDifferenceAndGrace`), producing one aggregate per distinct set of records within the time difference.

**SMT (Single Message Transform)** – Connect plugin applied per record between the connector and Kafka (`transforms`), such as `RegexRouter`, `ExtractField`, `InsertField`, `MaskField`, `TimestampConverter`; chained and optionally guarded by predicates.

**Snapshot (metadata snapshot)** – A compacted image of the entire metadata state written by KRaft nodes (`<offset>-<epoch>.checkpoint` in `__cluster_metadata-0`), allowing the log before it to be truncated and new nodes to bootstrap quickly.

**Standby replica (standby task)** – Streams task that passively replays a changelog to keep a warm copy of a state store on another instance (`num.standby.replicas`), shortening failover restore time.

**Static membership (`group.instance.id`)** – (2.3, KIP-345) Consumer identity that survives restarts so a bouncing member does not trigger a rebalance as long as it returns within the session timeout.

**Sticky partitioner** – Producer behaviour for keyless records that fills one partition's batch before switching to another (2.4, KIP-480), refined to strictly uniform distribution in 3.3 (KIP-794).

**Stream time** – In Streams, the maximum record timestamp seen so far per task; drives window closing, grace periods and punctuation (`PunctuationType.STREAM_TIME`).

**Stretch cluster** – A single Kafka cluster whose brokers (and controllers) span multiple data centres or AZs with rack-aware placement; requires low inter-site latency and an odd number of controller sites (or a tie-breaker).

**Subject** – Schema Registry namespace under which schema versions are registered; by default `<topic>-key` / `<topic>-value` (`TopicNameStrategy`).

**Suppress** – Streams DSL operator (`suppress(untilWindowCloses(...))`) that holds intermediate aggregation results and emits only the final value per window, at the cost of buffering.

### T

**Tiered storage** – (3.6 early access, 3.9 production-ready; KIP-405) Moving closed segments to object storage via a `RemoteStorageManager` plugin while keeping recent data locally; enables long retention without large disks and faster broker rebuilds.

**Timestamp extractor** – Streams interface deciding which timestamp drives processing: record timestamp (`FailOnInvalidTimestamp` default, `LogAndSkipOnInvalidTimestamp`), wall clock (`WallclockTimestampExtractor`), or a payload field.

**Tombstone** – A record with a null value on a compacted topic; signals deletion of the key and is itself removed after `delete.retention.ms`.

**Topic** – A named, partitioned, replicated log; the unit of subscription, ACLs and configuration. Identified internally by a topic id (UUID) since 2.8.

**Topic id** – Immutable UUID assigned at creation (KIP-516) so that delete-and-recreate with the same name is distinguishable by brokers and clients.

**Transaction coordinator** – The broker leading a partition of `__transaction_state` for a given `transactional.id`; assigns producer id/epoch, tracks partitions in the transaction, and writes commit/abort markers.

**Transactional id (`transactional.id`)** – Stable logical name of a transactional producer; the coordinator uses it to fence earlier instances (zombies) and to recover the transaction state across restarts.

**Tumbling window** – Fixed-size, non-overlapping time window (`TimeWindows.ofSizeAndGrace`); a special case of hopping window where advance = size.

### U

**Unclean leader election (`unclean.leader.election.enable`)** – Allowing a replica outside the ISR to become leader when no ISR member is available; restores availability at the cost of losing acknowledged records. Off by default; can be triggered manually with `kafka-leader-election.sh --election-type unclean`.

**Under-replicated partition (URP)** – A partition whose ISR is smaller than its replica set; the primary replication health signal (`UnderReplicatedPartitions`).

### V

**Voter** – A KRaft controller that participates in Raft elections and log commit decisions; a quorum is a majority of voters.

### W

**Watermark** – In Kafka: see *high watermark*. In stream processing generally: a marker of event-time progress; Streams uses *stream time* plus *grace period* rather than explicit watermarks.

**Worker** – A Kafka Connect process; workers with the same `group.id` form a Connect cluster that shares connectors and tasks.

### Z

**Zombie producer** – An old instance of a transactional/idempotent producer still trying to write after a replacement started; fenced by the *producer epoch* (`ProducerFencedException`).

**ZooKeeper** – The coordination service Kafka used for metadata until KRaft; deprecated in 3.5, removed in 4.0. Relevant only for migrating 3.x clusters (KIP-866).

**Zstd** – Compression codec (2.1, KIP-110) with the best ratio/CPU trade-off for most JSON/Avro payloads; needs clients ≥ 2.1.

---

## 2. KIPs every Kafka professional should know

Versions are the first release that shipped the feature; "EA" = early access, "GA" = production-ready.

| KIP | Title | Version | Why it matters |
|-----|-------|---------|----------------|
| KIP-4 | Command line and centralized administrative operations | 0.10–1.0 | Introduced the Admin protocol APIs behind `AdminClient` and every modern CLI tool. |
| KIP-32 / KIP-33 | Add timestamps to Kafka message; time-based index | 0.10.0 | Record timestamps and `.timeindex`; enable time-based retention, `--to-datetime` offset resets and stream time. |
| KIP-74 | Add fetch response size limit in bytes | 0.10.1 | `fetch.max.bytes` / `replica.fetch.response.max.bytes`; made per-partition limits soft so one big record cannot stall consumption. |
| KIP-82 | Add record headers | 0.11.0 | Headers for tracing, schema ids, routing without touching the payload. |
| KIP-91 | Provide intuitive user timeouts in the producer | 2.1 | `delivery.timeout.ms` replaces reasoning about `retries`. |
| KIP-97 | Improved Kafka client RPC compatibility policy | 0.10.2 | Clients negotiate API versions, so newer clients work against older brokers and vice versa. |
| KIP-98 | Exactly Once Delivery and Transactional Messaging | 0.11.0 | Idempotent producer and transactions; the foundation of EOS in Streams and Connect. |
| KIP-101 | Alter replication protocol to use leader epoch rather than high watermark for truncation | 0.11.0 | Leader epochs prevent log divergence after leader failover. |
| KIP-110 | Add codec for Zstandard compression | 2.1 | Best default compression codec for most payloads. |
| KIP-226 | Dynamic broker configuration | 1.1 | Change thread counts, TLS keystores, log settings without restarts (`kafka-configs.sh --entity-type brokers`). |
| KIP-227 | Introduce incremental FetchRequests to increase partition scalability | 1.1 | Fetch sessions; brokers with tens of thousands of partitions became practical. |
| KIP-255 | OAuth authentication via SASL/OAUTHBEARER | 2.0 | Token-based auth; KIP-768 (3.1) added production-ready OIDC support. |
| KIP-279 | Fix log divergence between leader and follower after fast leader fail over | 2.0 | Closes the remaining truncation edge case with leader epoch checkpoints. |
| KIP-320 | Allow fetchers to detect and handle log truncation | 2.1 | Consumers receive leader epochs and can detect truncation instead of silently reading diverged data. |
| KIP-345 | Introduce static membership protocol to reduce consumer rebalances | 2.3 | `group.instance.id`; rolling restarts without rebalance storms. |
| KIP-360 | Improve reliability of idempotent/transactional producer | 2.5 | Producers recover from `UNKNOWN_PRODUCER_ID`, making idempotence safe to enable by default later. |
| KIP-382 | MirrorMaker 2.0 | 2.4 | Connect-based replication with offset translation; replaces MirrorMaker 1 (removed in 4.0). |
| KIP-392 | Allow consumers to fetch from closest replica | 2.4 | Rack-aware follower fetching; cuts cross-AZ egress cost. |
| KIP-405 | Kafka Tiered Storage | 3.6 EA, 3.9 GA | Segments in object storage; decouples retention from broker disk. |
| KIP-415 | Incremental cooperative rebalancing in Kafka Connect | 2.3 | Connect no longer stops every task on each rebalance. |
| KIP-429 | Kafka Consumer Incremental Rebalance Protocol | 2.4 | `CooperativeStickyAssignor`; consumers keep unaffected partitions during rebalances. |
| KIP-447 | Producer scalability for exactly once semantics | 2.5 | One transactional producer per thread instead of per input partition; enables `exactly_once_v2` in Streams (KIP-732). |
| KIP-455 | Create an Administrative API for Replica Reassignment | 2.4 | Reassignments through the Kafka protocol with cancel support, no ZooKeeper writes. |
| KIP-480 | Sticky Partitioner | 2.4 | Larger batches for keyless records; refined by KIP-794. |
| KIP-500 | Replace ZooKeeper with a Self-Managed Metadata Quorum | 2.8 EA, 3.3 GA, 4.0 only mode | The KRaft architecture: fewer moving parts, faster failover, millions of partitions. |
| KIP-516 | Topic Identifiers | 2.8 | Topic UUIDs; safe delete/recreate and cheaper metadata. |
| KIP-580 | Exponential Backoff for Kafka Clients | 3.7 | `retry.backoff.max.ms`; avoids retry storms during broker outages. |
| KIP-584 | Versioning scheme for features | 2.7 / 3.x | The feature-level mechanism behind `kafka-features.sh` and `metadata.version`. |
| KIP-595 | A Raft Protocol for the Metadata Quorum | 2.8 | The KRaft replication protocol. |
| KIP-618 | Exactly-Once Support for Source Connectors | 3.3 | Transactional source connectors (`exactly.once.source.support`). |
| KIP-630 | Kafka Raft Snapshot | 3.0–3.1 | Metadata snapshots; bounded metadata log and fast bootstrap of new nodes. |
| KIP-631 | The Quorum-based Kafka Controller | 2.8 | Controller design in KRaft: broker registration, heartbeats, fencing, the metadata record types. |
| KIP-653 | Upgrade log4j to log4j2 | 4.0 | Brokers, Connect and tools log with log4j2 (`log4j2.yaml`). |
| KIP-679 | Producer will enable the strongest delivery guarantee by default | 3.0 | `acks=all`, `enable.idempotence=true` defaults; `IdempotentWrite` ACL implied by `Write`. |
| KIP-714 | Client metrics and observability | 3.7 | Clients push metrics to brokers; operators see client-side latency and lag without instrumenting applications. |
| KIP-724 | Drop support for message formats v0 and v1 | 3.0 deprecate, 4.0 remove | Only record format v2 exists; no conversion overhead. |
| KIP-732 | Deprecate eos-alpha and replace eos-beta with eos-v2 | 3.0 | `processing.guarantee=exactly_once_v2` naming. |
| KIP-750 / KIP-1013 | Drop support for Java 8 / Java 11 (brokers) | 4.0 | Brokers, Connect and tools need Java 17; clients and Streams need Java 11. |
| KIP-794 | Strictly Uniform Sticky Partitioner | 3.3 | Fixes skew of the original sticky partitioner; adaptive partitioning avoids slow brokers. |
| KIP-833 | Mark KRaft as Production Ready | 3.3 | The go-ahead for running KRaft in production. |
| KIP-848 | The Next Generation of the Consumer Rebalance Protocol | 3.7 EA, 4.0 GA | Server-side assignment, incremental reconciliation, no more global sync barrier; `group.protocol=consumer`. |
| KIP-853 | KRaft Controller Membership Changes | 3.9 | Dynamic controller quorum: add/remove controllers without restarts; `kraft.version=1`. |
| KIP-858 | Handle JBOD broker disk failure in KRaft | 3.7 | JBOD parity with ZooKeeper mode; removed the last migration blocker for many clusters. |
| KIP-866 | ZooKeeper to KRaft Migration | 3.4 EA, 3.6 GA | Online migration path; must be completed on 3.9 before upgrading to 4.0. |
| KIP-875 | First-class offsets support in Kafka Connect | 3.5–3.6 | `STOPPED` state, read/alter/reset connector offsets via REST. |
| KIP-890 | Transactions Server-Side Defense | 3.6 part 1, 4.0 part 2 | Verification then transaction v2: closes the hanging-transaction bug, removes a round trip per transaction. |
| KIP-896 | Remove old client protocol API versions in Kafka 4.0 | 4.0 | Brokers accept only clients ≥ 2.1; simplifies the protocol surface. |
| KIP-919 | Allow AdminClient to talk directly with the KRaft controller quorum | 3.7 | `--bootstrap-controller`; administer the quorum when brokers are down. |
| KIP-932 | Queues for Kafka | 4.0 EA, 4.1 preview | Share groups: queue semantics with per-record acknowledgement. |
| KIP-937 | Improve message timestamp validation | 3.6 | Rejects records with absurd timestamps that would break time-based retention. |
| KIP-939 | Support participation in 2PC | in progress (4.x) | Lets Kafka transactions join external two-phase commits (Flink, databases). |
| KIP-950 | Tiered Storage Disablement | 3.9 | Turn tiered storage off per topic (`remote.log.copy.disable`, `remote.log.delete.on.disable`). |
| KIP-966 | Eligible Leader Replicas | 4.0 (ELR), unclean recovery later | Safer leader election when the ISR collapses; reduces need for unclean election. |
| KIP-980 | Allow creating connectors in a stopped state | 3.7 | Create, set offsets, then start; clean migrations between Connect clusters. |
| KIP-996 | Pre-Vote | 4.1 | Prevents disruptive KRaft elections by partitioned or restarted controllers. |
| KIP-1000 | List Client Metrics Configuration Resources | 3.7 | Discover KIP-714 subscriptions (`ListClientMetricsResources`). |
| KIP-1004 | Enforce tasks.max property in Kafka Connect | 3.8 | Connectors can no longer exceed `tasks.max` silently. |
| KIP-1022 | Formatting and Updating Features | 3.8 | Multiple feature levels, `--release-version`, `version-mapping`, `feature-dependencies`. |
| KIP-1030 | Change constraints and default values for various configurations | 4.x (partial) | Safer defaults (for example proposed `linger.ms=5`, minimum RF/ISR checks); watch release notes for which parts landed. |
| KIP-1033 | Add Kafka Streams exception handler for exceptions occurring during processing | 3.9 | `processing.exception.handler`; no more thread death on a single bad record in user code. |
| KIP-1071 | Streams Rebalance Protocol | 4.1 EA | Broker-side task assignment for Streams (`group.protocol=streams`), built on KIP-848. |
| KIP-1102 | Enable clients to rebootstrap based on timeout or error code | 4.0 | `metadata.recovery.strategy=rebootstrap` default; clients survive full broker set replacement. |
| KIP-1150 | Diskless Topics | under discussion (2025–) | Leaderless topics on object storage to cut cross-AZ replication cost; the biggest proposed storage change since KIP-405. |

---

## Key takeaways
- Most operational vocabulary reduces to four families: log structure (segment, offset, HW/LEO/LSO), replication (leader, ISR, epoch, URP), coordination (controller quorum, group/transaction coordinators, rebalance) and guarantees (acks, idempotence, transactions, isolation level).
- Every "epoch" exists to fence something stale; when you see a fencing exception, ask which epoch moved and why.
- The KIPs from 2.4 to 4.0 (429, 447, 500, 848, 853, 890, 966, 405) explain why a 4.0 cluster behaves so differently from a 2.x one.

## Further reading
- Apache Kafka documentation §1 "Getting Started" (terminology) and §4 "Design".
- The KIP index on the Apache Kafka wiki ("Kafka Improvement Proposals").
