# Metrics and Alerts Cheatsheet

**Roles:** [ADMIN] [ARCH] [DEV]   **Level:** Reference
**Prerequisites:** [Configuration cheatsheet](02-configuration-cheatsheet.md)

## What you will learn
- The JMX MBeans that matter on brokers, controllers, clients, Streams, Connect and MirrorMaker 2, and what "healthy" looks like
- Alert thresholds that are defensible starting points, and the first thing to do when each fires
- A Prometheus rule set for the twelve alerts every Kafka cluster needs, plus a Grafana dashboard layout

How to read the tables:

- **MBean / metric** is the JMX object name (`domain:type=...,name=...`) with the attribute in parentheses when it is not the obvious `Value`/`Count`/`OneMinuteRate`. Yammer meters expose `Count`, `OneMinuteRate`, `FiveMinuteRate`, `FifteenMinuteRate`, `MeanRate`; Yammer histograms/timers expose `Mean`, `Max`, `50thPercentile`, `75thPercentile`, `95thPercentile`, `98thPercentile`, `99thPercentile`, `999thPercentile`; Kafka-metrics (clients, KRaft, coordinator) expose plain attributes.
- **Healthy** and **Alert threshold** are indicative starting points for a general-purpose cluster; tune to your SLOs.
- Prometheus names in §9 follow the widely used `jmx_exporter` configuration (`kafka_server_replicamanager_underreplicatedpartitions` style). **Names depend entirely on your exporter's rewrite rules**; check with `curl :7071/metrics | grep -i underreplicated` before copying rules.

---

## 1. Broker metrics

### 1.1 Replication (ReplicaManager)

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions` | Partitions on this broker (as leader) with ISR < replica count | 0 | > 0 for 5 min (warn), > 0 for 15 min or > 10 % of partitions (crit) | Find the lagging follower: `kafka-topics.sh --describe --under-replicated-partitions`; check that broker's disk, GC, `ReplicaFetcherManager MaxLag`. |
| `kafka.server:type=ReplicaManager,name=UnderMinIsrPartitionCount` | Partitions whose ISR < `min.insync.replicas`; `acks=all` writes fail with `NotEnoughReplicas` | 0 | > 0 for 1 min (crit) | Same as above but urgent: producers are failing. Consider temporarily lowering `min.insync.replicas` only if durability can be traded. |
| `kafka.server:type=ReplicaManager,name=AtMinIsrPartitionCount` | Partitions with ISR exactly at `min.insync.replicas`; one more failure blocks writes | 0 | > 0 for 15 min (warn) | Investigate the missing replica before the next failure. |
| `kafka.server:type=ReplicaManager,name=OfflineReplicaCount` | Replicas on this broker that are offline (failed log dir) | 0 | > 0 | Check `LogManager OfflineLogDirectoryCount`, disk health, `dmesg`. |
| `kafka.server:type=ReplicaManager,name=IsrShrinksPerSec` / `IsrExpandsPerSec` | Rate of ISR membership changes | ≈ 0 outside restarts | shrinks > 0 sustained (flapping) | Flapping ISR = follower cannot keep up: network, disk, `replica.lag.time.max.ms` too tight, GC pauses. |
| `kafka.server:type=ReplicaManager,name=FailedIsrUpdatesPerSec` | ISR updates rejected by the controller | 0 | > 0 | Controller connectivity or stale broker epoch (KIP-903); check controller logs. |
| `kafka.server:type=ReplicaManager,name=PartitionCount` | Replicas hosted by this broker | balanced across brokers (± 10 %) | one broker > 1.5× median, or > 4000 per broker (indicative) | Rebalance with `kafka-reassign-partitions.sh` or Cruise Control. |
| `kafka.server:type=ReplicaManager,name=LeaderCount` | Leaders hosted by this broker | balanced | skew > 20 % | `kafka-leader-election.sh --election-type preferred --all-topic-partitions`; check `auto.leader.rebalance.enable`. |
| `kafka.server:type=ReplicaManager,name=ReassigningPartitions` | Partitions currently being reassigned | 0 outside maintenance | > 0 for > 24 h | Reassignment stuck: raise throttle, check target broker disk. |
| `kafka.server:type=ReplicaFetcherManager,name=MaxLag,clientId=Replica` | Max offset lag of this broker as a follower across all fetched partitions | small and stable (< a few thousand) | growing for 10 min | Follower cannot keep up: I/O saturation, `num.replica.fetchers` too low, throttles left behind. |
| `kafka.server:type=FetcherLagMetrics,name=ConsumerLag,clientId=ReplicaFetcherThread-*,topic=*,partition=*` | Per-partition follower lag | small | growing | Same; identifies which partition. |
| `kafka.server:type=ReplicaAlterLogDirsManager,name=MaxLag` | Lag of replicas moving between log dirs (JBOD) | 0 when idle | growing during moves | Raise `replica.alter.log.dirs.io.max.bytes.per.second`. |

### 1.2 Controller (KRaft)

Emitted by the **active controller**; on standby controllers most values are 0. Brokers emit their own metadata-consumption metrics (§1.3).

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.controller:type=KafkaController,name=ActiveControllerCount` | 1 on the active controller, 0 elsewhere | sum over controllers = 1 | sum ≠ 1 for 1 min | Quorum lost or split: `kafka-metadata-quorum.sh describe --status`; check controller connectivity and disks. |
| `kafka.controller:type=KafkaController,name=OfflinePartitionsCount` | Partitions without a leader (unavailable) | 0 | > 0 (crit) | Bring back the brokers holding ISR members; last resort `kafka-leader-election.sh --election-type unclean`. |
| `kafka.controller:type=KafkaController,name=GlobalPartitionCount` / `GlobalTopicCount` | Cluster-wide counts | within capacity plan | sudden jump | Auto-created topic storm? `auto.create.topics.enable`. |
| `kafka.controller:type=KafkaController,name=ActiveBrokerCount` / `FencedBrokerCount` | Registered brokers that are alive / fenced | fenced = 0 | fenced > 0 for 5 min | A broker cannot heartbeat: check its logs, `broker.session.timeout.ms`, network to controllers. |
| `kafka.controller:type=KafkaController,name=PreferredReplicaImbalanceCount` | Partitions whose leader is not the preferred replica | 0 | > 0 for 30 min | Preferred election; check `auto.leader.rebalance.enable`. |
| `kafka.controller:type=KafkaController,name=MetadataErrorCount` | Errors while applying metadata records | 0 | > 0 | Controller bug or corrupted record; collect logs, open an issue; do not restart blindly. |
| `kafka.controller:type=KafkaController,name=LastAppliedRecordOffset` / `LastCommittedRecordOffset` | Position of the controller in the metadata log | applied ≈ committed | applied lags committed by > 1000 records | Controller event queue saturated (see next rows). |
| `kafka.controller:type=KafkaController,name=LastAppliedRecordLagMs` | Age of the last applied record | < 1 s | > 10 s | Same. |
| `kafka.controller:type=KafkaController,name=TimedOutBrokerHeartbeatCount` | Broker heartbeats that timed out in the controller queue | 0 | > 0 | Controller overloaded; check `EventQueueTimeMs`. |
| `kafka.controller:type=KafkaController,name=EventQueueTimeMs` / `EventQueueProcessingTimeMs` (p99) | Time events wait in / are processed by the single controller thread | p99 < 100 ms | p99 > 1 s | Too many partitions/topics for the controller, or slow metadata log disk. |
| `kafka.controller:type=KafkaController,name=NewActiveControllersCount` | Controller failovers since start | rare | > 1 per hour | Controller flapping: quorum fetch timeouts, GC, disk. |
| `kafka.controller:type=ControllerEventManager,name=EventQueueTimeMs` | (legacy ZK controller) | — | — | ZK-mode only (≤ 3.9). |

### 1.3 KRaft quorum (raft-metrics) and broker metadata

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.server:type=raft-metrics,name=current-state` | `leader`, `follower`, `candidate`, `prospective` (4.1 pre-vote), `observer` (brokers), `unattached`, `resigned` | exactly one leader; brokers observer | any node `candidate`/`unattached` > 30 s | Election cannot complete: check that a majority of voters can reach each other on the controller listener. |
| `kafka.server:type=raft-metrics,name=current-leader` / `current-epoch` / `current-vote` | Leader id, epoch, vote | stable | epoch increments > 2 per hour | Leader churn; look at `election-latency`, GC, `controller.quorum.fetch.timeout.ms`. |
| `kafka.server:type=raft-metrics,name=high-watermark` / `log-end-offset` | Metadata log positions | LEO − HW small | HW not advancing for 10 s | Majority not fetching; a voter is down or partitioned. |
| `kafka.server:type=raft-metrics,name=commit-latency-avg` / `commit-latency-max` | Time to replicate a metadata record to a majority | avg < 10 ms | max > 500 ms sustained | Slow controller disk (fsync) or network between controllers. |
| `kafka.server:type=raft-metrics,name=election-latency-avg` / `election-latency-max` | Time to elect a leader | rarely non-zero | > 5 s | Election storms. |
| `kafka.server:type=raft-metrics,name=fetch-records-rate` / `append-records-rate` | Metadata throughput | steady | sudden spike | Topic/partition churn or a client creating topics in a loop. |
| `kafka.server:type=raft-metrics,name=number-unknown-voter-connections` | Voters not connected | 0 | > 0 | Controller down or misconfigured `controller.quorum.voters` / bootstrap servers. |
| `kafka.server:type=raft-metrics,name=number-of-voters` / `number-of-observers` | Quorum size and observers | 3 or 5 voters; observers = brokers | voters ≠ configured | Dynamic quorum membership changed unexpectedly (3.9, KIP-853). |
| `kafka.server:type=raft-metrics,name=uncommitted-voter-change` | A voter add/remove is in flight (3.9) | 0 | 1 for > 5 min | `add-controller` did not complete; check the new controller's logs. |
| `kafka.server:type=raft-metrics,name=poll-idle-ratio-avg` | Fraction of time the raft thread is idle | > 0.5 | < 0.2 | Metadata log overloaded. |
| `kafka.server:type=broker-metadata-metrics,name=last-applied-record-offset` / `last-applied-record-timestamp` / `last-applied-record-lag-ms` | How far this **broker** is behind the metadata log | lag < 1 s | lag > 30 s | Broker cannot fetch from controllers or is stuck applying; check broker log for `MetadataLoader` errors. |
| `kafka.server:type=broker-metadata-metrics,name=metadata-load-error-count` / `metadata-apply-error-count` | Failures loading/applying metadata on the broker | 0 | > 0 | Same; possibly a metadata.version the broker cannot understand (downgrade attempt). |
| `kafka.server:type=MetadataLoader,name=CurrentMetadataVersion` | The `metadata.version` level this node runs | same on all nodes | differs across nodes | Rolling upgrade in progress or a node running an old binary. |
| `kafka.server:type=MetadataLoader,name=HandleLoadSnapshotCount` | Snapshots loaded since start | 1 at startup, rarely after | frequent increments | Broker keeps falling off the end of the metadata log (retention too short or long pauses). |
| `kafka.server:type=SnapshotEmitter,name=LatestSnapshotGeneratedBytes` / `LatestSnapshotGeneratedAgeMs` | Size and age of the newest metadata snapshot | age < `metadata.log.max.snapshot.interval.ms` | age > 2 h | Snapshot generation failing; controller disk full? |
| `kafka.server:type=KafkaServer,name=BrokerState` | 0 NOT_RUNNING, 1 STARTING, 2 RECOVERY, 3 RUNNING, 6 PENDING_CONTROLLED_SHUTDOWN, 7 SHUTTING_DOWN | 3 | ≠ 3 for 10 min | Long log recovery after unclean shutdown: raise `num.recovery.threads.per.data.dir` next time; check startup logs. |

### 1.4 Request metrics (per request type, with percentiles)

`request=` values: `Produce`, `FetchConsumer`, `FetchFollower`, `Metadata`, `OffsetCommit`, `OffsetFetch`, `JoinGroup`, `SyncGroup`, `Heartbeat`, `ConsumerGroupHeartbeat` (4.0), `FindCoordinator`, `InitProducerId`, `AddPartitionsToTxn`, `EndTxn`, `TxnOffsetCommit`, `ListOffsets`, `CreateTopics`, `DescribeConfigs`, `ApiVersions`, `BrokerHeartbeat`, `Fetch` (raft), and others.

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.network:type=RequestMetrics,name=TotalTimeMs,request=Produce` (`99thPercentile`) | End-to-end broker time for produce requests | p99 < 50 ms (acks=all, local SSD) | p99 > 250 ms for 5 min | Break it down with the components below. |
| `...name=TotalTimeMs,request=FetchConsumer` (p99) | Consumer fetch total time; includes long-poll wait (`fetch.max.wait.ms`) so up to ~500 ms is normal when idle | ≤ `fetch.max.wait.ms` + 50 ms | p99 > `fetch.max.wait.ms` + 500 ms | Look at `RemoteTimeMs` (purgatory wait, normal) vs `LocalTimeMs` (disk read, page-cache miss). |
| `...name=TotalTimeMs,request=FetchFollower` (p99) | Follower fetch time; same long-poll caveat (`replica.fetch.wait.max.ms` 500 ms) | ≤ 550 ms | p99 > 1 s | Replication path slow: disk on the leader, network. |
| `...name=RequestQueueTimeMs,request=*` (p99) | Time waiting for an I/O thread | < 5 ms | p99 > 50 ms | `num.io.threads` too low or handlers blocked on disk; see `RequestHandlerAvgIdlePercent`. |
| `...name=LocalTimeMs,request=Produce` (p99) | Leader append to local log (page cache write) | < 5 ms | > 50 ms | Disk saturation, `log.flush.*` set, huge batches, page cache thrashing. |
| `...name=RemoteTimeMs,request=Produce` (p99) | Waiting for followers (acks=all) in purgatory | < 20 ms | > 100 ms | Slow follower: `ReplicaFetcherManager MaxLag`, follower disk, `replica.fetch.wait.max.ms`. |
| `...name=ThrottleTimeMs,request=*` (p99) | Time a response was held back by quotas | 0 | > 0 unexpectedly | A client hit `producer_byte_rate`/`consumer_byte_rate`/`request_percentage`; decide whether the quota or the client is wrong. |
| `...name=ResponseQueueTimeMs` / `ResponseSendTimeMs` (p99) | Waiting for / sending on a network thread | < 5 ms | > 50 ms | `num.network.threads` too low; slow clients; TLS CPU. |
| `...name=MessageConversionsTimeMs,request=Produce|FetchConsumer` | Time spent down/up-converting record formats | 0 | > 0 | Old clients forcing conversion (irrelevant on 4.0, which rejects < 2.1 clients). |
| `kafka.network:type=RequestMetrics,name=RequestsPerSec,request=Produce,version=*` | Request rate by API and version | steady | drop to 0 on one broker | Broker isolated or clients failing over. |
| `kafka.network:type=RequestMetrics,name=ErrorsPerSec,request=*,error=*` | Errors by API and error code (`NONE` counts successes) | `NONE` only; small `NOT_LEADER_OR_FOLLOWER` around elections | any non-benign error rate > 1/s: `NOT_ENOUGH_REPLICAS`, `REQUEST_TIMED_OUT`, `UNKNOWN_TOPIC_OR_PARTITION`, `TOPIC_AUTHORIZATION_FAILED`, `SASL_AUTHENTICATION_FAILED`, `INVALID_PRODUCER_EPOCH` | Map the error to its cause: durability (ISR), auth (ACLs/creds), stale clients (metadata), transactions (fencing). |
| `kafka.network:type=RequestChannel,name=RequestQueueSize` / `ResponseQueueSize` | Queue depths | < 10 % of `queued.max.requests` | ≥ `queued.max.requests` (500) | Broker saturated: I/O threads or disk. Network threads stop reading sockets when the request queue is full. |
| `kafka.network:type=RequestMetrics,name=TemporaryMemoryBytes,request=Produce|Fetch` | Transient memory for conversions/decompression | small | growing | Broker-side recompression (`compression.type` ≠ producer) or conversions. |

### 1.5 Thread pools, network and connections

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.server:type=KafkaRequestHandlerPool,name=RequestHandlerAvgIdlePercent` (`OneMinuteRate`, 0–1) | Fraction of time I/O (request handler) threads are idle | > 0.5 | < 0.3 for 5 min (warn), < 0.1 (crit) | Raise `num.io.threads` if CPU allows; otherwise the disk is the bottleneck (`LocalTimeMs`). Frequently caused by one slow log dir. |
| `kafka.network:type=SocketServer,name=NetworkProcessorAvgIdlePercent` (0–1) | Fraction of time network threads are idle | > 0.5 | < 0.3 | Raise `num.network.threads`; check TLS overhead and connection churn. |
| `kafka.network:type=SocketServer,name=ExpiredConnectionsKilledCount` | Connections closed for re-authentication expiry | small | growing fast | Clients not re-authenticating (`connections.max.reauth.ms`). |
| `kafka.network:type=SocketServer,name=MemoryPoolAvailable` / `MemoryPoolUsed` | Request memory pool (`queued.max.request.bytes`) | available > 0 | used ≈ limit | Broker back-pressuring reads. |
| `kafka.server:type=socket-server-metrics,listener=*,networkProcessor=*,name=connection-count` | Open connections per network thread | balanced, within `max.connections` | approaching `max.connections` or `max.connections.per.ip` | Find the leaking client (`ss -tn`), set per-IP limits. |
| `...name=connection-creation-rate` / `connection-close-rate` | Connection churn per second | low (< 10/s) | > 100/s sustained | Clients reconnecting in a loop (auth failures, short-lived producers). |
| `...name=failed-authentication-rate` / `failed-authentication-total` | Failed SASL/SSL handshakes | 0 | > 1/s | Wrong credentials, expired certificates, clock skew (Kerberos/OIDC). |
| `...name=successful-authentication-rate` / `successful-reauthentication-rate` | | steady | | |
| `...name=io-wait-ratio` / `io-ratio` | Network thread selector time | | | |
| `kafka.server:type=socket-server-metrics,name=broker-connection-accept-rate` / `connection-accept-throttle-time` | Broker-wide accept throttling (`max.connection.creation.rate`) | throttle 0 | throttle > 0 | Either a storm or a too-low limit. |
| `kafka.server:type=socket-server-metrics,listener=*,name=connection-accept-rate` | Per-listener accept rate | | | |

### 1.6 Topic and log throughput (BrokerTopicMetrics)

All exist cluster-wide (no `topic=` tag) and per topic (`,topic=<name>`).

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.server:type=BrokerTopicMetrics,name=MessagesInPerSec` | Records appended (leader) | per capacity plan | drop > 50 % vs 1 h ago (per topic) | Upstream producer down, or leader moved (check per-broker). |
| `...name=BytesInPerSec` / `BytesOutPerSec` | Client bytes in/out (compressed) | | > 80 % of NIC or per-broker plan | Rebalance leaders/partitions; scale out. |
| `...name=ReplicationBytesInPerSec` / `ReplicationBytesOutPerSec` | Inter-broker replication bytes | ≈ `BytesIn × (RF − 1)` cluster-wide | spike outside reassignments | Reassignment running or a follower catching up after restart. |
| `...name=BytesRejectedPerSec` | Bytes rejected (`MESSAGE_TOO_LARGE`) | 0 | > 0 | A producer exceeds `max.message.bytes`. |
| `...name=FailedProduceRequestsPerSec` / `FailedFetchRequestsPerSec` | Requests that returned an error | 0 | > 1/s | Cross-check `ErrorsPerSec` by error code. |
| `...name=TotalProduceRequestsPerSec` / `TotalFetchRequestsPerSec` | Request rates | | | Ratio bytes/requests tells you batching efficiency. |
| `...name=ProduceMessageConversionsPerSec` / `FetchMessageConversionsPerSec` | Format conversions | 0 | > 0 | Old clients. |
| `...name=NoKeyCompactedTopicRecordsPerSec` / `InvalidMagicNumberRecordsPerSec` / `InvalidMessageCrcRecordsPerSec` / `InvalidOffsetOrSequenceRecordsPerSec` | Rejected records by reason | 0 | > 0 | Producer bug (null key to compacted topic), corruption on the wire, idempotent sequence errors. |
| `...name=RemoteCopyBytesPerSec` / `RemoteFetchBytesPerSec` / `RemoteCopyRequestsPerSec` / `RemoteFetchRequestsPerSec` / `RemoteDeleteRequestsPerSec` | Tiered storage traffic (3.6+, KIP-963 in 3.7) | steady | copy rate 0 while local retention exceeded | Remote storage plugin failing; see error rates below. |
| `...name=RemoteCopyErrorsPerSec` / `RemoteFetchErrorsPerSec` / `RemoteDeleteErrorsPerSec` / `BuildRemoteLogAuxStateErrorsPerSec` | Tiered storage failures | 0 | > 0 | Object store credentials/network; local disk will fill if copy fails. |
| `kafka.server:type=BrokerTopicMetrics,name=RemoteLogSizeBytes,topic=*` / `RemoteLogMetadataCount` | Remote log size per topic | | | |
| `kafka.server:type=DelayedFetchMetrics,name=ExpiresPerSec,fetcherType=consumer|follower` | Fetches that timed out waiting for `fetch.min.bytes` | any | | Informational; high values mean consumers poll idle partitions. |

### 1.7 Log manager, segments and flush

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.log:type=LogManager,name=OfflineLogDirectoryCount` | Log dirs marked offline after I/O errors | 0 | > 0 (crit) | Disk failure; replicas on that dir are offline. Replace disk, restart broker (JBOD in KRaft since 3.7, KIP-858). |
| `kafka.log:type=LogManager,name=LogDirectoryOffline,logDirectory=*` | Per-dir flag (0/1) | 0 | 1 | Same. |
| `kafka.log:type=Log,name=Size,topic=*,partition=*` | Bytes on disk per partition | | one partition ≫ others (hot key) | Key skew; consider a different partitioner or more partitions. |
| `kafka.log:type=Log,name=LogEndOffset` / `LogStartOffset` / `NumLogSegments` | Per-partition log bounds | | `NumLogSegments` in thousands | Segment size too small for the throughput; raise `segment.bytes`. |
| `kafka.log:type=LogFlushStats,name=LogFlushRateAndTimeMs` (p99) | fsync latency when the log flushes (segment roll, explicit flush) | p99 < 100 ms | p99 > 1 s | Disk latency; check `iostat -x` await, RAID cache, other tenants on the disk. |
| `kafka.server:type=KafkaServer,name=linux-disk-read-bytes` / `linux-disk-write-bytes` | Process-level disk I/O (Linux) | reads ≈ 0 when consumers are caught up | reads ≫ 0 sustained | Consumers reading from disk (page-cache misses): lagging consumers, too little RAM, or tiered fetches. |
| `kafka.server:type=ReplicaManager,name=LeaderCount` × avg partition size vs disk | | | disk > 75 % (warn), > 85 % (crit) | Retention, partition moves, tiered storage. Watch `log.retention.bytes` is per partition. |

### 1.8 Purgatory

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.server:type=DelayedOperationPurgatory,name=PurgatorySize,delayedOperation=Produce` | Produce requests waiting for followers (acks=all) | tens to hundreds, proportional to in-flight | thousands and growing | Followers slow; correlates with `RemoteTimeMs`. |
| `...delayedOperation=Fetch` | Fetch requests waiting for data (long-poll) | ≈ number of active consumers × partitions | sudden growth | Normal for idle consumers; abnormal if `RequestQueueSize` also grows. |
| `...delayedOperation=DeleteRecords`, `ElectLeader`, `Heartbeat`, `Rebalance`, `topic`, `RemoteFetch`, `RemoteListOffsets` | Other delayed operations | small | growing | Points at the subsystem (group coordinator, tiered fetch). |
| `kafka.server:type=DelayedOperationPurgatory,name=NumDelayedOperations,delayedOperation=*` | Operations including expired-but-not-purged entries | | | Housekeeping; informational. |

### 1.9 Log cleaner (compaction)

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.log:type=LogCleaner,name=DeadThreadCount` | Cleaner threads that died (uncaught exception) | 0 | > 0 (crit) | Compaction has stopped: `__consumer_offsets` will grow until the broker is restarted. Check `log-cleaner.log` for the exception (corrupt segment, dedupe buffer too small for a single segment). |
| `kafka.log:type=LogCleaner,name=max-buffer-utilization-percent` | Dedupe buffer usage during the last clean | < 90 | ≥ 100 | Raise `log.cleaner.dedupe.buffer.size`; the cleaner does multiple passes otherwise. |
| `kafka.log:type=LogCleaner,name=cleaner-recopy-percent` | Percentage of bytes re-written in the last clean | low (< 50) | > 90 repeatedly | Wasted I/O; usually tied to buffer size or very high dirty ratio. |
| `kafka.log:type=LogCleaner,name=max-clean-time-secs` | Duration of the longest recent clean | minutes | > 1 h | A giant compacted partition; split the topic or raise `log.cleaner.threads`. |
| `kafka.log:type=LogCleaner,name=max-compaction-delay-secs` | How late compaction is relative to `max.compaction.lag.ms` | 0 | > 0 | Cleaner cannot keep up: threads, I/O throttle (`log.cleaner.io.max.bytes.per.second`). |
| `kafka.log:type=LogCleanerManager,name=max-dirty-percent` | Dirtiest log's dirty ratio × 100 | < 50 (with default 0.5 ratio) | > 80 for hours | Cleaner starved or dead. |
| `kafka.log:type=LogCleanerManager,name=time-since-last-run-ms` | Time since the cleaner last ran | < `log.cleaner.backoff.ms` + clean time | > 1 h | Dead thread or nothing cleanable. |
| `kafka.log:type=LogCleanerManager,name=uncleanable-partitions-count,logDirectory=*` / `uncleanable-bytes,logDirectory=*` | Partitions the cleaner gave up on after errors | 0 | > 0 | Corrupt segment; find the partition in `log-cleaner.log`, fix or rebuild the replica. |

### 1.10 Group coordinator and transactions

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.coordinator.group:type=GroupMetadataManager,name=NumGroups` / `NumGroupsStable` / `NumGroupsPreparingRebalance` / `NumGroupsCompletingRebalance` / `NumGroupsEmpty` / `NumGroupsDead` | Group counts by state on this coordinator (classic groups) | most Stable | `PreparingRebalance` > 0 for > 5 min | A group is stuck rebalancing: a member does not rejoin (`max.poll.interval.ms`), or a static member conflict. |
| `kafka.coordinator.group:type=GroupMetadataManager,name=NumOffsets` | Committed offsets held in memory | proportional to groups × partitions | growth without new groups | Offset expiration not running; `offsets.retention.minutes`. |
| `kafka.server:type=group-coordinator-metrics,name=group-count,protocol=classic|consumer` | Groups by protocol (3.7+ new coordinator runtime) | | | Track adoption of KIP-848. |
| `kafka.server:type=group-coordinator-metrics,name=consumer-group-count,state=empty|assigning|reconciling|stable|dead` | KIP-848 groups by state | mostly `stable` | `reconciling` > 0 for > 5 min | A member is not acknowledging revocations; check that consumer's `poll()` loop. |
| `kafka.server:type=group-coordinator-metrics,name=offset-commit-rate` / `offset-expiration-rate` / `offset-deletion-rate` | Coordinator write rates | steady | commit-rate drops to 0 | Consumers dead or coordinator moved. |
| `kafka.server:type=group-coordinator-metrics,name=group-completed-rebalance-rate` / `consumer-group-rebalance-rate` | Rebalances per second | ≈ 0 outside deploys | > 0.1/s sustained | Rebalance storm; find the group with `kafka-consumer-groups.sh --describe --state`. |
| `kafka.server:type=group-coordinator-metrics,name=event-queue-size` / `event-queue-time-ms-p99` / `event-processing-time-ms-p99` / `thread-idle-ratio` | Coordinator runtime health (3.7+) | queue small, p99 < 50 ms, idle > 0.5 | p99 > 500 ms | Raise `group.coordinator.threads`; check `__consumer_offsets` partition leaders are spread. |
| `kafka.server:type=group-coordinator-metrics,name=num-partitions,state=loading|active|failed` | `__consumer_offsets` partitions by state | `failed` = 0, `loading` = 0 after startup | `loading` > 0 for > 2 min | Coordinator loading a huge offsets partition; compaction may be broken (§1.9). |
| `kafka.server:type=transaction-coordinator-metrics,name=partition-load-time-avg` / `partition-load-time-max` | Time to load `__transaction_state` partitions on failover | < 1 s | > 10 s | Transaction log not compacting or too many transactional ids. |
| `kafka.coordinator.transaction:type=TransactionMarkerChannelManager,name=UnknownDestinationQueueSize` / `LogAppendRetryQueueSize` | Transaction markers waiting to be written | 0 | > 0 sustained | Partition leaders unavailable; markers cannot complete → LSO stalls for `read_committed` consumers. |
| `kafka.server:type=AddPartitionsToTxnVerification,name=VerificationTimeMs` / `VerificationFailureRate` | KIP-890 verification (3.6+) | failures 0 | failures > 0 | Producers writing outside their transaction (hanging-transaction defence working as designed; fix the producer). |
| `kafka.network:type=RequestMetrics,name=ErrorsPerSec,request=EndTxn,error=INVALID_PRODUCER_EPOCH|PRODUCER_FENCED` | Fenced producers | ≈ 0 | > 0 sustained | Two instances share a `transactional.id`, or transaction timeouts. |

### 1.11 Quotas

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.server:type=Produce,user=*,client-id=*,name=byte-rate` / `throttle-time` | Per-principal produce rate and throttle time (ms) | throttle 0 | throttle > 0 | Client at quota; raise quota or fix client. |
| `kafka.server:type=Fetch,user=*,client-id=*,name=byte-rate` / `throttle-time` | Same for fetch | | | |
| `kafka.server:type=Request,user=*,client-id=*,name=request-time` / `throttle-time` | CPU-time quota (`request_percentage`) | | | Chatty client (tiny batches, tight poll loop). |
| `kafka.server:type=ControllerMutation,user=*,client-id=*,name=mutation-rate` / `throttle-time` | Topic mutation quota | | | CI/automation creating topics in a loop. |
| `kafka.server:type=socket-server-metrics,listener=*,name=connection-accept-throttle-time` | IP connection quota | 0 | > 0 | |

### 1.12 ZooKeeper (legacy, ≤ 3.9 ZK mode only)

| MBean / metric | What it means | Alert threshold | First action |
|----------------|---------------|-----------------|--------------|
| `kafka.server:type=SessionExpireListener,name=ZooKeeperDisconnectsPerSec` / `ZooKeeperExpiresPerSec` | Broker lost its ZK session | > 0 | GC pauses on the broker or ZK overload; session expiry causes controller failover and ISR churn. |
| `kafka.server:type=ZooKeeperClientMetrics,name=ZooKeeperRequestLatencyMs` (p99) | ZK round trip | > 100 ms | ZK disk (fsync) or network. |
| `kafka.server:type=SessionExpireListener,name=SessionState` | `CONNECTED` expected | ≠ CONNECTED | |
| `kafka.controller:type=KafkaController,name=ActiveControllerCount` | 1 across all brokers in ZK mode | ≠ 1 | ZK connectivity. |

Since 4.0 these do not exist; migrate with KIP-866 on 3.9 first.

---

## 2. Producer client metrics

Domain `kafka.producer`. Tags: `client-id`, plus `topic` for `producer-topic-metrics` and `node-id` for `producer-node-metrics`.

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.producer:type=producer-metrics,client-id=*,name=record-send-rate` / `record-send-total` | Records sent per second | matches application rate | drops to 0 while app is busy | Producer blocked: check `bufferpool-wait-ratio`, `waiting-threads`, broker errors. |
| `...name=record-error-rate` / `record-error-total` | Records that failed permanently (after retries) | 0 | > 0 | Read the callback exception: `TimeoutException` (delivery timeout), `RecordTooLargeException`, `NotEnoughReplicasException`, auth errors. |
| `...name=record-retry-rate` / `record-retry-total` | Retried batches | ≈ 0 | > 1 % of send rate | Leader changes, `NOT_LEADER_OR_FOLLOWER`, `REQUEST_TIMED_OUT`; check broker health. |
| `...name=request-latency-avg` / `request-latency-max` | Produce request round trip (ms) | avg < 20 ms LAN | avg > 100 ms | Broker `TotalTimeMs,request=Produce`; network. |
| `...name=record-queue-time-avg` / `record-queue-time-max` | Time records wait in the accumulator (ms) | ≈ `linger.ms` | ≫ `linger.ms` | Batches waiting for in-flight slots: broker slow or `max.in.flight` too low. |
| `...name=batch-size-avg` / `batch-size-max` | Bytes per batch | close to `batch.size` under load | tiny batches (< 1 KiB) at high rate | Raise `linger.ms`; check partition count per producer (batches are per partition). |
| `...name=records-per-request-avg` | Records per produce request | > 10 under load | ≈ 1 | Same. |
| `...name=compression-rate-avg` | Compressed / uncompressed ratio | 0.2–0.5 for JSON | ≈ 1 with compression on | Payloads incompressible or batches too small to compress well. |
| `...name=buffer-available-bytes` / `buffer-total-bytes` | Free accumulator memory | available > 20 % | available ≈ 0 | Broker cannot absorb the rate; `send()` will block up to `max.block.ms`. |
| `...name=bufferpool-wait-ratio` / `bufferpool-wait-time-ns-total` | Fraction of time `send()` blocked waiting for buffer | 0 | > 0.1 | Same; raise `buffer.memory` only if the bottleneck is transient. |
| `...name=waiting-threads` | Application threads blocked in `send()` | 0 | > 0 | Same. |
| `...name=produce-throttle-time-avg` / `produce-throttle-time-max` | Broker quota throttling (ms) | 0 | > 0 | Quota. |
| `...name=outgoing-byte-rate` / `incoming-byte-rate` | Network throughput | | | |
| `...name=connection-count` / `connection-creation-rate` / `connection-close-rate` | Connections to brokers | ≈ number of brokers with leaders | churn > 0 | Auth failures, idle timeouts, broker restarts. |
| `...name=io-wait-ratio` / `io-ratio` / `io-time-ns-avg` | Sender thread busy-ness | io-wait high (idle) | io-ratio > 0.8 | Sender thread saturated; more producers or bigger batches. |
| `...name=metadata-age` | Age of cached metadata (s) | < `metadata.max.age.ms` | > 600 s | Metadata refresh failing (all brokers unreachable). |
| `...name=txn-init-time-ns-total` / `txn-begin-time-ns-total` / `txn-send-offsets-time-ns-total` / `txn-commit-time-ns-total` / `txn-abort-time-ns-total` | Time spent in transaction API calls | commit time small | commit avg > 500 ms | Coordinator slow (`__transaction_state` leader), many partitions per transaction. |
| `...name=flush-time-ns-total` | Time in `flush()` | | | |
| `kafka.producer:type=producer-topic-metrics,client-id=*,topic=*,name=record-send-rate` / `byte-rate` / `record-error-rate` / `record-retry-rate` / `compression-rate` | Per-topic breakdown | | error rate > 0 | Identify the topic (size limit, ACL). |
| `kafka.producer:type=producer-node-metrics,client-id=*,node-id=node-<id>,name=request-latency-avg` / `request-rate` / `response-rate` / `outgoing-byte-rate` | Per-broker breakdown | uniform across nodes | one node's latency ≫ others | That broker is slow; check its disk and `TotalTimeMs`. |

### 2.1 Consumer client metrics

Domain `kafka.consumer`. Types: `consumer-metrics`, `consumer-coordinator-metrics`, `consumer-fetch-manager-metrics` (with optional `topic`/`partition` tags), `consumer-node-metrics`.

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.consumer:type=consumer-fetch-manager-metrics,client-id=*,name=records-lag-max` | Max lag (records) across assigned partitions, measured at last fetch | small and stable | growing for 10 min, or > SLO | Consumer too slow: scale out (up to partition count), raise `max.poll.records`/`fetch.max.bytes`, fix slow processing. Compare with group-level lag from `kafka-consumer-groups.sh`. |
| `...client-id=*,topic=*,partition=*,name=records-lag` / `records-lag-avg` / `records-lag-max` | Per-partition lag | | one partition ≫ others | Hot partition (key skew) or a stuck task in Streams. |
| `...name=records-lead-min` / `records-lead` (per partition) | Distance from the consumer position to the **log start** offset | ≫ 0 | < 1000 or shrinking | Retention is about to delete unread data → silent data loss. Raise retention or speed up the consumer. |
| `...name=fetch-latency-avg` / `fetch-latency-max` | Fetch round trip (includes long-poll wait) | ≤ `fetch.max.wait.ms` | ≫ 500 ms | Broker `TotalTimeMs,request=FetchConsumer`. |
| `...name=fetch-rate` / `fetch-size-avg` / `fetch-size-max` / `records-per-request-avg` | Fetch efficiency | fetch-size close to `max.partition.fetch.bytes` × partitions when lagging | many tiny fetches | Raise `fetch.min.bytes` to reduce broker load. |
| `...name=records-consumed-rate` / `bytes-consumed-rate` (also per topic) | Throughput | matches producer rate | < producer rate sustained | Lag will grow. |
| `...name=fetch-throttle-time-avg` / `fetch-throttle-time-max` | Quota throttling | 0 | > 0 | Quota. |
| `...name=preferred-read-replica` (per partition) | Replica the consumer fetches from (KIP-392) | leader or same-rack follower | unexpected | `client.rack` / `replica.selector.class` misconfigured. |
| `kafka.consumer:type=consumer-coordinator-metrics,client-id=*,name=commit-latency-avg` / `commit-latency-max` / `commit-rate` / `commit-total` | Offset commit performance | avg < 20 ms | max > 1 s | Coordinator slow or `__consumer_offsets` under-replicated (commits need `acks=all`). |
| `...name=assigned-partitions` | Partitions assigned to this member | > 0 | 0 while others have many | Assignor skew; more members than partitions. |
| `...name=rebalance-rate-per-hour` / `rebalance-total` / `rebalance-latency-avg` / `rebalance-latency-max` / `rebalance-latency-total` | Rebalance frequency and duration | ≈ 0/h in steady state; latency < 5 s (cooperative) | > 4/h, or latency > 30 s | Find the trigger: `max.poll.interval.ms` exceeded (`last-poll-seconds-ago`), member restarts, session timeouts. Use static membership and cooperative assignor. |
| `...name=failed-rebalance-rate-per-hour` / `failed-rebalance-total` | Rebalances that failed | 0 | > 0 | Coordinator moved mid-rebalance, or member errors during `onPartitionsRevoked`. |
| `...name=last-rebalance-seconds-ago` | Time since last rebalance | large | small repeatedly | Rebalance storm. |
| `...name=join-rate` / `join-time-avg` / `sync-rate` / `sync-time-avg` | Classic protocol join/sync phases | | join-time > `max.poll.interval.ms`/2 | Members slow to rejoin (long processing in `poll()` loop). |
| `...name=heartbeat-rate` / `heartbeat-response-time-max` / `last-heartbeat-seconds-ago` | Liveness signalling | last-heartbeat < `heartbeat.interval.ms`/1000 | > `session.timeout.ms`/3000 | Heartbeat thread starved (GC) or network. |
| `...name=partition-revoked-latency-avg` / `partition-assigned-latency-avg` / `partition-lost-latency-avg` | Time in rebalance listener callbacks | ms | seconds | Slow `onPartitionsRevoked` (e.g. flushing to a DB) lengthens every rebalance. |
| `kafka.consumer:type=consumer-metrics,client-id=*,name=time-between-poll-avg` / `time-between-poll-max` | Gap between `poll()` calls (ms) | ≪ `max.poll.interval.ms` | max > 0.8 × `max.poll.interval.ms` | Processing too slow per batch; lower `max.poll.records` or process asynchronously with pause/resume. |
| `...name=last-poll-seconds-ago` | Seconds since last `poll()` | < 1 | > `max.poll.interval.ms`/2000 | Consumer stuck (deadlock, blocked I/O). |
| `...name=poll-idle-ratio-avg` | Fraction of time inside `poll()` (waiting) vs processing | > 0.3 | < 0.05 | Consumer CPU-bound in user code. |
| `...name=commit-sync-time-ns-total` / `committed-time-ns-total` | Time blocked in `commitSync()`/`committed()` | | | |
| `...name=connection-count` / `io-wait-ratio` / `io-ratio` | Network health | | | |
| `...name=background-event-queue-size` / `application-event-queue-size` / `unsent-requests-queue-size` / `time-between-network-thread-poll-avg` | Async consumer internals (4.0 `AsyncKafkaConsumer`, KIP-848) | small | growing | Background thread stalled; report with thread dump. |
| `kafka.consumer:type=consumer-node-metrics,client-id=*,node-id=*,name=request-latency-avg` / `incoming-byte-rate` | Per-broker | uniform | | One slow broker. |

Group-level lag (what `kafka-consumer-groups.sh` prints) is `log-end-offset − committed offset`; client-side `records-lag` is `log-end-offset − consumer position`, which can be lower because records fetched but not yet committed are excluded. For alerting, prefer an external exporter (kafka_exporter, Burrow, kafka-lag-exporter) that also covers dead consumers (which emit no metrics).

---

## 3. Kafka Streams metrics

Domain `kafka.streams`. Tags: `client-id`, `thread-id`, `task-id`, `processor-node-id`, `rocksdb-state-id` / `in-memory-state-id` / `rocksdb-window-state-id` / `rocksdb-session-state-id`. Recording level `INFO` unless marked DEBUG (`metrics.recording.level`).

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.streams:type=stream-metrics,client-id=*,name=state` | Client state: CREATED, REBALANCING, RUNNING, PENDING_SHUTDOWN, NOT_RUNNING, PENDING_ERROR, ERROR | RUNNING | REBALANCING > 5 min, ERROR | ERROR means all threads died; look at the uncaught exception handler logs. |
| `...name=alive-stream-threads` / `failed-stream-threads` | Thread counts | alive = `num.stream.threads`, failed = 0 | failed > 0 | Thread replaced or dead (`StreamsUncaughtExceptionHandler` decision); find the exception. |
| `...name=client-state` / `topology-description` / `version` / `commit-id` | Informational | | | |
| `kafka.streams:type=stream-thread-metrics,thread-id=*,name=process-rate` / `process-total` | Records processed per second per thread | matches input rate | drops to 0 while lag grows | Thread blocked (state store, external call, `punctuate`). |
| `...name=process-latency-avg` / `process-latency-max` | Time per `process()` batch (ms) | ms | > `max.poll.interval.ms`/10 | Slow processor or store. |
| `...name=process-ratio` / `poll-ratio` / `commit-ratio` / `punctuate-ratio` | Fraction of thread time per phase | process high, poll low when busy | poll-ratio ≈ 1 with lag | Thread waiting on fetch → broker or `fetch.*` tuning. commit-ratio high → `commit.interval.ms` too low or EOS overhead. |
| `...name=poll-latency-avg` / `poll-rate` / `poll-records-avg` / `poll-records-max` | Consumer poll behaviour | | poll-records tiny with lag | Raise `max.poll.records`, `fetch.max.bytes`. |
| `...name=commit-latency-avg` / `commit-latency-max` / `commit-rate` | Commit (and with EOS, transaction commit) time | avg < 100 ms | max > 1 s | Many tasks per thread × EOS; changelog producer slow; raise `commit.interval.ms`. |
| `...name=punctuate-latency-avg` / `punctuate-latency-max` / `punctuate-rate` | Punctuator cost | small | max > seconds | A punctuator scanning a whole store; blocks the thread and delays heartbeats/polls. |
| `...name=task-created-rate` / `task-closed-rate` | Task churn | ≈ 0 | > 0 sustained | Rebalances. |
| `...name=blocked-time-ns-total` / `thread-start-time` | Total time blocked on producer/consumer/admin calls (KIP-761) | | derivative ≈ 1 (fully blocked) | Broker-side latency. |
| `...name=thread-state` | Thread state | RUNNING | PARTITIONS_REVOKED/ASSIGNED for long | |
| `kafka.streams:type=stream-thread-metrics,thread-id=*,name=active-restoring-tasks` / `standby-updating-tasks` / `active-paused-tasks` / `standby-paused-tasks` | State updater thread (3.5+, KIP-869) | restoring 0 in steady state | restoring > 0 for > 10 min | Restore from changelog is slow: changelog partition count, `restore.consumer.*` fetch sizes, disk. Consider `num.standby.replicas=1`. |
| `...name=restore-records-rate` / `restore-call-rate` / `active-restore-ratio` / `standby-update-ratio` / `idle-ratio` / `checkpoint-ratio` | State updater throughput | | restore-records-rate low while restoring | Same. |
| `kafka.streams:type=stream-task-metrics,thread-id=*,task-id=*,name=restore-remaining-records-total` / `restore-total` / `restore-rate` / `update-total` / `update-rate` | Per-task restoration progress (KIP-869) | remaining → 0 | remaining not decreasing | Same; identifies the task. |
| `kafka.streams:type=stream-task-metrics,...,name=process-rate` / `process-latency-avg` / `commit-latency-avg` | Per-task | balanced across tasks | one task ≫ others | Key skew or expensive keys. |
| `...name=record-lateness-avg` / `record-lateness-max` | How late records arrive vs stream time (ms) | < grace period | > grace period | Records dropped from windows; tune `grace` or fix upstream timestamps. |
| `...name=dropped-records-rate` / `dropped-records-total` | Records dropped (late, null key on join, deserialization skip, invalid timestamp) | 0 | > 0 | Check which handler/window is dropping; `record-lateness-max`. |
| `...name=enforced-processing-rate` / `enforced-processing-total` | Times the task processed despite an empty input partition (`max.task.idle.ms` expired) | 0 when idling disabled | > 0 with idling on | Out-of-order joins possible; raise `max.task.idle.ms` or accept. |
| `...name=active-process-ratio` | Fraction of thread time this task got | proportional | | |
| `...name=active-buffer-count` / `input-buffer-bytes-total` / `cache-size-bytes-total` | Buffering | < `input.buffer.max.bytes` | at limit | Consumer paused for back-pressure. |
| `kafka.streams:type=stream-processor-node-metrics,...,processor-node-id=*,name=process-rate` / `process-total` (DEBUG) | Per-node throughput | | | Locate the slow node. |
| `...name=record-e2e-latency-avg` / `record-e2e-latency-min` / `record-e2e-latency-max` (INFO on source/sink nodes, KIP-613) | Record timestamp → node processing time (ms); end-to-end latency including upstream | per SLO | p99 > SLO | Upstream lag, restore, slow processing. |
| `...name=emitted-records-rate` / `idempotent-update-skip-rate` (DEBUG) | Windowed aggregation emit behaviour | | | |
| `...name=records-consumed-total` / `bytes-consumed-total` / `records-produced-total` / `bytes-produced-total` (source/sink nodes, per topic) | Volume in/out | | | |
| `kafka.streams:type=stream-state-metrics,...,name=put-rate` / `get-rate` / `fetch-rate` / `range-rate` / `delete-rate` / `flush-rate` / `restore-rate` (DEBUG for rates; latencies `*-latency-avg/max`) | Store operation rates/latencies | latency µs–ms | get-latency-avg > 5 ms | RocksDB cache misses; tune block cache, compaction; check `write-stall-duration`. |
| `...name=suppression-buffer-size-avg` / `suppression-buffer-size-max` / `suppression-buffer-count-avg` / `suppression-buffer-count-max` | `suppress()` buffer usage | < configured limit | at limit | `BufferConfig` too small → shutdown or emit-early depending on strategy. |
| `...name=num-open-iterators` / `iterator-duration-avg` / `iterator-duration-max` / `oldest-open-iterator-age-ms` (3.7, KIP-989) | Leaked iterators (IQ or processors) | open ≈ 0, age small | oldest age > 60 s | Close iterators in `try-with-resources`; leaked iterators pin RocksDB memory and block compaction. |
| `...name=record-e2e-latency-*` (state stores) | Latency at store level | | | |

### 3.1 RocksDB (per store, `rocksdb-state-id` etc.)

INFO-level "statistics" are sampled every minute (`metrics.recording.level=INFO` since 3.x for properties; rates require DEBUG in older versions).

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.streams:type=stream-state-metrics,...,name=write-stall-duration-avg` / `write-stall-duration-total` | Time writes were stalled by RocksDB back-pressure (ms) | 0 | > 0 | Compaction cannot keep up: more background threads (`RocksDBConfigSetter`: `setMaxBackgroundJobs`), faster disk, larger write buffers. |
| `...name=memtable-hit-ratio` / `block-cache-data-hit-ratio` / `block-cache-index-hit-ratio` / `block-cache-filter-hit-ratio` | Cache effectiveness | data hit > 0.8 | < 0.5 | Increase block cache (`LRUCache`) in `RocksDBConfigSetter`; pin index/filter blocks. |
| `...name=bytes-written-rate` / `bytes-read-rate` / `memtable-bytes-flushed-rate` / `bytes-read-compaction-rate` / `bytes-written-compaction-rate` | I/O rates | | compaction bytes ≫ write bytes (write amplification > 20×) | Tune level sizes; consider fewer, larger stores. |
| `...name=memtable-flush-time-avg` / `compaction-time-avg` / `compaction-time-max` | Background work latency | | compaction-time-max > 30 s | Disk or CPU. |
| `...name=number-open-files` / `number-file-errors-total` | File handles and errors | errors 0 | errors > 0, or open files near ulimit | Raise `ulimit -n`; set `setMaxOpenFiles`. |
| `...name=num-immutable-mem-table` / `cur-size-active-mem-table` / `cur-size-all-mem-tables` / `size-all-mem-tables` / `num-entries-active-mem-table` / `num-entries-imm-mem-tables` / `num-deletes-active-mem-table` | Memtable state | immutable memtables 0–1 | immutable > 2 | Flush backlog. |
| `...name=estimate-num-keys` / `estimate-table-readers-mem` / `total-sst-files-size` / `live-sst-files-size` | Store size | per plan | grows without bound | Missing retention on window stores, or tombstones not compacting. |
| `...name=estimate-pending-compaction-bytes` / `num-running-compactions` / `num-running-flushes` / `background-errors` | Compaction backlog | pending small, errors 0 | pending > several GiB, errors > 0 | Same as stalls. |
| `...name=block-cache-capacity` / `block-cache-usage` / `block-cache-pinned-usage` | Cache accounting | usage ≤ capacity | usage ≈ capacity with low hit ratio | Bigger cache or fewer stores per instance. Bound total memory with a shared `Cache` + `WriteBufferManager` in the config setter. |
| `...name=num-live-versions` | Superblock versions held (open iterators keep them alive) | 1–2 | growing | Leaked iterators. |

> **Production tip:** the JVM heap does not include RocksDB memory. Alert on container RSS vs limit, not only on heap; an unbounded block cache across dozens of stores is the most common cause of OOM-killed Streams pods.

---

## 4. Kafka Connect metrics

Domain `kafka.connect`. Tags: `connector`, `task`, `client-id`. Task producers/consumers also emit standard `kafka.producer`/`kafka.consumer` metrics with `client-id=connector-producer-<name>-<task>` / `connector-consumer-<name>-<task>`.

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.connect:type=connector-metrics,connector=*,name=status` | Connector state: `running`, `paused`, `stopped`, `failed`, `unassigned`, `restarting` | running (or paused/stopped intentionally) | failed | `GET /connectors/{n}/status` for the trace; fix config/plugin; `POST .../restart?includeTasks=true&onlyFailed=true`. |
| `...name=connector-class` / `connector-type` / `connector-version` | Informational | | | |
| `kafka.connect:type=connector-task-metrics,connector=*,task=*,name=status` | Task state | running | failed, or unassigned > 5 min | Task trace in status; unassigned = no worker has capacity or rebalance pending (`scheduled.rebalance.max.delay.ms`). |
| `...name=running-ratio` / `pause-ratio` | Fraction of time running/paused | running ≈ 1 | | |
| `...name=batch-size-avg` / `batch-size-max` | Records per put/poll batch | | tiny batches at high rate | Tune `consumer.override.max.poll.records` (sink) or connector batching. |
| `...name=offset-commit-avg-time-ms` / `offset-commit-max-time-ms` / `offset-commit-success-percentage` / `offset-commit-failure-percentage` | Offset commit health | success 100 % | failure > 0 | Sink: consumer commit failed (rebalance, timeout). Source: offsets topic unavailable. |
| `kafka.connect:type=connect-worker-metrics,name=connector-count` / `task-count` | Work on this worker | balanced across workers | one worker ≫ others | Rebalance (eager if `connect.protocol=eager`); check `connect-worker-rebalance-metrics`. |
| `...name=connector-startup-attempts-total` / `connector-startup-success-total` / `connector-startup-failure-total` / `connector-startup-failure-percentage` / `connector-startup-success-percentage` | Startup outcomes | failure 0 | failure > 0 | Missing plugin (`plugin.path`), bad config. |
| `...name=task-startup-attempts-total` / `task-startup-failure-percentage` | Same for tasks | | | |
| `kafka.connect:type=connect-worker-metrics,connector=*,name=connector-total-task-count` / `connector-running-task-count` / `connector-failed-task-count` / `connector-paused-task-count` / `connector-unassigned-task-count` / `connector-destroyed-task-count` / `connector-restarting-task-count` | Task state counts per connector, per worker | failed 0, unassigned 0 | failed > 0 | Restart failed tasks after fixing the cause; a task that fails repeatedly on the same record needs `errors.tolerance=all` + DLQ. |
| `kafka.connect:type=connect-worker-rebalance-metrics,name=rebalancing` / `completed-rebalances-total` / `rebalance-avg-time-ms` / `rebalance-max-time-ms` / `time-since-last-rebalance-ms` / `epoch` / `leader-name` / `connect-protocol` | Worker group rebalances | rebalancing 0; rare | rebalancing = 1 for > 5 min, or completed-total climbing | A worker is flapping (GC, `session.timeout.ms`), or connectors are being created/deleted in a loop. Every rebalance stops task progress briefly. |
| `kafka.connect:type=source-task-metrics,connector=*,task=*,name=source-record-poll-rate` / `source-record-poll-total` | Records polled from the source system | steady | 0 while source has data | Source connector stuck (DB lock, API throttle); check its logs. |
| `...name=source-record-write-rate` / `source-record-write-total` | Records written to Kafka (after SMTs; dropped records are not counted) | ≈ poll rate | ≪ poll rate | SMT/predicate filtering, or producer back-pressure. |
| `...name=source-record-active-count` / `source-record-active-count-avg` / `source-record-active-count-max` | Records polled but not yet acked by Kafka | small | growing | Producer slow (`producer-metrics` for the task); broker. |
| `...name=poll-batch-avg-time-ms` / `poll-batch-max-time-ms` | Time per `poll()` in the connector | | max > 60 s | Source system latency. |
| `...name=transaction-size-avg` / `transaction-size-max` / `transaction-size-min` | EOS source transactions (3.3+) | | | |
| `kafka.connect:type=sink-task-metrics,connector=*,task=*,name=sink-record-read-rate` / `sink-record-read-total` | Records read from Kafka | matches producer rate | 0 with lag | Consumer stuck; check `connector-consumer-*` metrics. |
| `...name=sink-record-send-rate` / `sink-record-send-total` | Records passed to `put()` (after SMTs) | | | |
| `...name=sink-record-active-count` / `sink-record-active-count-avg` / `sink-record-active-count-max` | Records read but not yet committed | small | growing | Slow `put()`/`flush()` in the sink system. |
| `...name=sink-record-lag-max` | Max lag across partitions (as seen by the task) | small | growing | Same; scale `tasks.max` up to the partition count. |
| `...name=partition-count` | Partitions assigned to the task | balanced | 0 while others > 0 | More tasks than partitions. |
| `...name=put-batch-avg-time-ms` / `put-batch-max-time-ms` | Time per `put()` | | max > `consumer.override.max.poll.interval.ms`/2 | Sink system slow; risk of consumer being kicked. |
| `...name=offset-commit-seq-no` / `offset-commit-completion-rate` / `offset-commit-completion-total` / `offset-commit-skip-rate` / `offset-commit-skip-total` | Sink commit bookkeeping | skip 0 | skip > 0 | Commits skipped because a previous one was still in flight; sink `flush()` too slow. |
| `kafka.connect:type=task-error-metrics,connector=*,task=*,name=total-record-errors` | Errors seen in the connector pipeline (converter, SMT, put) | 0 | rate > 0 | Inspect DLQ headers (`__connect.errors.exception.message`) or logs (`errors.log.enable=true`). |
| `...name=total-record-failures` | Errors that exhausted retries | 0 | > 0 | Same. |
| `...name=total-records-skipped` | Records skipped under `errors.tolerance=all` | 0 | > 0 (rate) | Data loss unless the DLQ is consumed. |
| `...name=total-retries` / `total-errors-logged` | Retry and log counters | | retries climbing | Transient sink failures. |
| `...name=deadletterqueue-produce-requests` / `deadletterqueue-produce-failures` | DLQ writes and failures | failures 0 | failures > 0 | DLQ topic missing/unauthorized → records are lost silently. |
| `...name=last-error-timestamp` | Epoch ms of the last error | old | recent | |
| `kafka.connect:type=connect-coordinator-metrics,client-id=*,name=assigned-connectors` / `assigned-tasks` | Worker's share of the assignment | balanced | | |

---

## 5. MirrorMaker 2 metrics

Domain `kafka.connect.mirror`. Emitted by the MM2 connectors (in dedicated mode and when deployed on Connect). Tags: `source`, `target`, `topic`, `partition` (and `group` for checkpoints). Topic names are the **source** names.

| MBean / metric | What it means | Healthy | Alert threshold | First action |
|----------------|---------------|---------|-----------------|--------------|
| `kafka.connect.mirror:type=MirrorSourceConnector,source=*,target=*,topic=*,partition=*,name=replication-latency-ms-avg` / `-max` / `-min` | Time from record timestamp (source) to write on the target (ms) | avg < 1 s LAN, < a few s WAN | avg > 30 s for 5 min | MM2 lagging: `tasks.max`, producer batching (`<tgt>.producer.*`), consumer fetch sizes (`<src>.consumer.*`), WAN bandwidth. |
| `...name=record-age-ms-avg` / `-max` / `-min` | Age of records when MM2 **reads** them (source consumer lag in time) | small | growing | Same, but distinguishes read-side (consumer) from write-side (producer) lag: high record-age with low replication-latency delta = consumer slow. |
| `...name=record-count` / `record-rate` | Records replicated | matches source rate | 0 while source active | Task failed (`connector-task-metrics status`), or topic filtered by `topics`/`topics.exclude`. |
| `...name=byte-count` / `byte-rate` | Bytes replicated | | | Capacity planning for the WAN link. |
| `kafka.connect.mirror:type=MirrorCheckpointConnector,source=*,target=*,group=*,topic=*,partition=*,name=checkpoint-latency-ms-avg` / `-max` / `-min` | Age of the latest checkpoint (offset translation) for a group | < `emit.checkpoints.interval.seconds` × 2 | > 5 min | Checkpoint task failed; offset-syncs topic unavailable; group filtered by `groups`/`groups.exclude`. Failover would resume from stale offsets. |
| `kafka.connect:type=connector-task-metrics,connector=MirrorSourceConnector|MirrorCheckpointConnector|MirrorHeartbeatConnector,...,name=status` | Task health of the three MM2 connectors | running | failed | Restart after fixing; heartbeat connector failure breaks `heartbeats` topic and upstream discovery. |
| Consumer lag of group `<mm2 alias>` on the source cluster (`kafka-consumer-groups.sh` / exporter) | MM2's own read position (MM2 commits offsets for monitoring since 3.x) | small | growing | Same as replication latency; use for alerting from the source side. |
| `heartbeats` topic on the target: age of the newest record | End-to-end liveness of the flow | < `emit.heartbeats.interval.seconds` × 5 | > 60 s | Flow stopped entirely. |

---

## 6. JVM and OS

| Metric | What it means | Healthy | Alert threshold | First action |
|--------|---------------|---------|-----------------|--------------|
| `java.lang:type=GarbageCollector,name=G1 Young Generation` / `G1 Old Generation` / `ZGC Cycles` (`CollectionCount`, `CollectionTime`) | GC activity | young pauses < 50 ms; old/full ≈ 0 | full GC > 0 per hour; GC time > 5 % of wall clock | Heap too small or too large (page cache starved); brokers: 6–8 GiB heap is typical (indicative), rest to page cache. Old-gen growth on brokers usually = fetch sessions or huge requests. |
| `java.lang:type=Memory` (`HeapMemoryUsage.used/max`, `NonHeapMemoryUsage`) | Heap usage | after-GC used < 70 % of max | > 85 % after GC | Heap leak or undersized. |
| `java.lang:type=OperatingSystem` (`OpenFileDescriptorCount` / `MaxFileDescriptorCount`) | FDs: every segment, index, socket | < 60 % of max | > 80 % | Raise `ulimit -n` (≥ 100000 for brokers); check segment counts. |
| `java.lang:type=OperatingSystem` (`SystemCpuLoad`, `ProcessCpuLoad`) | CPU | < 70 % | > 85 % sustained | TLS, compression (`compression.type` on broker), request rate. |
| `java.lang:type=Threading` (`ThreadCount`) | Threads | stable | growing | Leak in a plugin (Connect) or client. |
| Page cache: `node_memory_Cached_bytes`, `vmstat` `bi` | Kafka reads from page cache; disk reads mean cache misses | disk reads ≈ 0 with caught-up consumers | sustained disk reads | Lagging consumers, too little RAM, other processes evicting cache. |
| Disk: `node_filesystem_avail_bytes{mountpoint=/data/*}` | Free space per log dir | > 25 % | < 15 % (warn), < 10 % (crit) | Kafka does not stop writing when full; the dir goes offline. Lower retention, move partitions, add disk. |
| Disk latency: `node_disk_write_time_seconds_total` / `node_disk_writes_completed_total` (await), `iostat -x` `%util` | I/O latency and saturation | await < 10 ms SSD | await > 50 ms, util > 90 % | Correlates with `LocalTimeMs`, `LogFlushRateAndTimeMs`. |
| Network: `node_network_transmit_bytes_total` vs NIC speed; `node_netstat_Tcp_RetransSegs` | Saturation and packet loss | < 70 % of NIC; retrans ≈ 0 | > 85 %; retrans growing | Leader skew, replication storms, cross-AZ traffic (use fetch-from-follower). |
| `node_sockstat_TCP_inuse`, `node_nf_conntrack_entries` | Connection counts and conntrack | | near limits | Connection storms; conntrack table full drops packets silently. |
| Clock: `node_timex_offset_seconds` | NTP offset | < 100 ms | > 1 s | Kerberos/OIDC auth failures, timestamp validation rejects, `LogAppendTime` skew. |
| Swap: `node_memory_SwapCached_bytes`, `vmstat si/so` | Swapping | 0 | > 0 | `vm.swappiness=1`; never let a broker swap. |

---

## 7. Prometheus alert rules (top 12)

Metric names below assume the common `jmx_exporter` configuration for Kafka (lower-cased `domain_type_name` with tags as labels) plus `kafka_exporter` for consumer lag and `node_exporter` for the OS. **Verify the exact names in your `/metrics` output before deploying**; some exporter configs use `kafka_server_replicamanager_underreplicatedpartitions_value` or `..._count` suffixes, and Strimzi/Confluent dashboards use their own rewrite rules.

```yaml
groups:
  - name: kafka-broker
    rules:
      - alert: KafkaUnderReplicatedPartitions
        expr: sum by (instance) (kafka_server_replicamanager_underreplicatedpartitions) > 0
        for: 5m
        labels: {severity: warning}
        annotations:
          summary: "Under-replicated partitions on {{ $labels.instance }}"
          runbook: "kafka-topics.sh --describe --under-replicated-partitions; check follower broker disk/GC"

      - alert: KafkaUnderMinIsrPartitions
        expr: sum by (instance) (kafka_server_replicamanager_underminisrpartitioncount) > 0
        for: 1m
        labels: {severity: critical}
        annotations:
          summary: "Partitions below min.insync.replicas on {{ $labels.instance }} — acks=all producers are failing"

      - alert: KafkaOfflinePartitions
        expr: sum (kafka_controller_kafkacontroller_offlinepartitionscount) > 0
        for: 1m
        labels: {severity: critical}
        annotations:
          summary: "{{ $value }} partitions have no leader"

      - alert: KafkaActiveControllerCountNotOne
        expr: sum (kafka_controller_kafkacontroller_activecontrollercount) != 1
        for: 1m
        labels: {severity: critical}
        annotations:
          summary: "Active controller count is {{ $value }} (expected 1)"
          runbook: "kafka-metadata-quorum.sh describe --status"

      - alert: KafkaBrokerDown
        expr: up{job="kafka-broker"} == 0
        for: 2m
        labels: {severity: critical}
        annotations:
          summary: "Broker {{ $labels.instance }} is not exporting metrics"

      - alert: KafkaRequestHandlerSaturated
        # jmx_exporter usually exposes the OneMinuteRate of this Yammer meter as the value (0..1)
        expr: kafka_server_kafkarequesthandlerpool_requesthandleravgidlepercent < 0.3
        for: 5m
        labels: {severity: warning}
        annotations:
          summary: "I/O threads on {{ $labels.instance }} are {{ $value | humanizePercentage }} idle"
          runbook: "check LocalTimeMs/disk latency before raising num.io.threads"

      - alert: KafkaNetworkProcessorSaturated
        expr: kafka_network_socketserver_networkprocessoravgidlepercent < 0.3
        for: 5m
        labels: {severity: warning}
        annotations:
          summary: "Network threads on {{ $labels.instance }} are {{ $value | humanizePercentage }} idle"

      - alert: KafkaProduceLatencyHigh
        expr: kafka_network_requestmetrics_totaltimems{request="Produce",quantile="0.99"} > 250
        for: 5m
        labels: {severity: warning}
        annotations:
          summary: "p99 produce time on {{ $labels.instance }} is {{ $value }} ms"
          runbook: "split by RequestQueueTimeMs / LocalTimeMs / RemoteTimeMs"

      - alert: KafkaOfflineLogDirectory
        expr: kafka_log_logmanager_offlinelogdirectorycount > 0
        for: 1m
        labels: {severity: critical}
        annotations:
          summary: "Log directory offline on {{ $labels.instance }} (disk failure)"

      - alert: KafkaLogCleanerDead
        expr: kafka_log_logcleaner_deadthreadcount > 0
        for: 5m
        labels: {severity: critical}
        annotations:
          summary: "Log cleaner thread died on {{ $labels.instance }}; compaction (incl. __consumer_offsets) has stopped"

      - alert: KafkaDiskAlmostFull
        expr: (node_filesystem_avail_bytes{mountpoint=~"/data.*"} / node_filesystem_size_bytes{mountpoint=~"/data.*"}) < 0.15
        for: 10m
        labels: {severity: warning}
        annotations:
          summary: "Kafka log dir {{ $labels.mountpoint }} on {{ $labels.instance }} has {{ $value | humanizePercentage }} free"

      - alert: KafkaConsumerGroupLagHigh
        # kafka_exporter naming; kafka-lag-exporter uses kafka_consumergroup_group_lag / _lag_seconds
        expr: sum by (consumergroup, topic) (kafka_consumergroup_lag) > 100000
        for: 15m
        labels: {severity: warning}
        annotations:
          summary: "Group {{ $labels.consumergroup }} lags {{ $value }} records on {{ $labels.topic }}"

  - name: kafka-kraft-extra
    rules:
      - alert: KafkaMetadataLagHigh
        expr: kafka_server_broker_metadata_metrics_last_applied_record_lag_ms > 30000
        for: 5m
        labels: {severity: warning}
        annotations:
          summary: "Broker {{ $labels.instance }} is {{ $value }} ms behind the metadata log"

      - alert: KafkaControllerElectionChurn
        expr: increase(kafka_server_raft_metrics_current_epoch[1h]) > 2
        for: 0m
        labels: {severity: warning}
        annotations:
          summary: "KRaft leader epoch changed {{ $value }} times in the last hour"

      - alert: KafkaIsrFlapping
        expr: rate(kafka_server_replicamanager_isrshrinks_total[10m]) > 0.05
        for: 10m
        labels: {severity: warning}
        annotations:
          summary: "ISR shrinking repeatedly on {{ $labels.instance }}"
```

---

## 8. Grafana dashboard panel list

One dashboard per audience; every panel filtered by `cluster` and `instance` variables.

**Row 1 – Cluster health (single-stat tiles)**
1. Active controllers (sum, expect 1)
2. Offline partitions (expect 0)
3. Under-replicated partitions (sum)
4. Under-min-ISR partitions (sum)
5. Brokers up / registered (and fenced count in KRaft)
6. Metadata version and KRaft leader epoch (stat)

**Row 2 – Throughput**
7. Messages in/s per broker (stacked)
8. Bytes in/out/s per broker, with replication bytes in/out on a second axis
9. Top 10 topics by bytes in (table, `topic` tag)
10. Produce/Fetch requests/s per broker

**Row 3 – Latency**
11. Produce `TotalTimeMs` p50/p99/p999 per broker
12. Produce breakdown p99: `RequestQueueTimeMs`, `LocalTimeMs`, `RemoteTimeMs`, `ResponseQueueTimeMs`, `ResponseSendTimeMs` (stacked)
13. FetchConsumer / FetchFollower `TotalTimeMs` p99
14. `ThrottleTimeMs` p99 per request type

**Row 4 – Saturation**
15. Request handler idle % and network processor idle % (0–1, thresholds at 0.3)
16. Request queue size and response queue size
17. Purgatory size: Produce, Fetch
18. Connections per listener, connection creation rate, failed authentications

**Row 5 – Replication and controller**
19. ISR shrinks / expands per second
20. Replica fetcher `MaxLag` per broker
21. Controller `EventQueueTimeMs` p99, `LastAppliedRecordLagMs`
22. KRaft: commit latency, current-state per node (state timeline), high-watermark vs LEO

**Row 6 – Storage**
23. Disk free % per log dir with 15 %/10 % thresholds
24. Log flush latency p99
25. Log cleaner: `max-dirty-percent`, `time-since-last-run-ms`, dead threads, buffer utilization
26. Disk await/util from node_exporter; page-cache read bytes

**Row 7 – Coordinator and consumers**
27. Groups by state (stacked) and rebalance rate
28. Consumer lag by group (top N table) and lag trend for selected group
29. Offset commit rate; `__consumer_offsets` partition load state
30. Transaction marker queue sizes; `EndTxn` error rates

**Row 8 – JVM/OS**
31. Heap used after GC, GC pause time %, full GC count
32. CPU %, open file descriptors % of max, threads
33. NIC utilisation, TCP retransmits, conntrack usage

**Client dashboards (separate)**
- Producer: `record-send-rate`, `record-error-rate`, `request-latency-avg`, `batch-size-avg`, `buffer-available-bytes`, `record-queue-time-avg`, `produce-throttle-time-avg`.
- Consumer: `records-lag-max` per partition, `records-lead-min`, `fetch-latency-avg`, `time-between-poll-max` vs `max.poll.interval.ms`, `rebalance-rate-per-hour`, `commit-latency-avg`.
- Streams: client state timeline, alive/failed threads, process-rate per thread, commit-latency, restore-remaining-records per task, record-e2e-latency p99, dropped-records, RocksDB write-stall and block-cache hit ratio, container RSS vs limit.
- Connect: connector/task status table, failed task count, rebalancing flag + time since last rebalance, source poll/write rates, sink read/send rates, `sink-record-lag-max`, task-error totals and DLQ produce failures.
- MM2: replication-latency-ms avg/max per topic, record-age-ms, byte-rate per flow, checkpoint-latency per group, heartbeat age.

---

## Key takeaways
- Five broker numbers tell you whether the cluster is healthy right now: `ActiveControllerCount` = 1, `OfflinePartitionsCount` = 0, `UnderReplicatedPartitions` = 0, `UnderMinIsrPartitionCount` = 0, request handler idle > 0.3.
- Latency is diagnosed by decomposition: `TotalTimeMs` = queue + local (disk) + remote (followers/purgatory) + response; each points at a different fix.
- Consumer lag is not a broker metric; export it from a lag exporter and pair it with `records-lead-min` to catch retention-induced data loss.
- Streams and Connect are applications: alert on state (ERROR/failed), on restore progress, on dropped/errored records, and on container memory (RocksDB lives outside the heap).
- Exporter metric names are a convention, not a standard; validate every alert expression against your own `/metrics` endpoint.

## Further reading
- Apache Kafka documentation §6.8 "Monitoring" (broker, producer, consumer, Streams, Connect, MM2 metric tables).
- KIP-869 (Streams restoration metrics), KIP-613 (Streams e2e latency), KIP-714 (client metrics push), KIP-853/595 (KRaft metrics), KIP-963 (tiered storage metrics), KIP-989 (iterator metrics).
- `prometheus/jmx_exporter` example config `kafka-2_0_0.yml`; `danielqsj/kafka_exporter`; `seglo/kafka-lag-exporter`; Strimzi and Confluent Grafana dashboards as name references.
