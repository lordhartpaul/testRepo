# CLI Cheatsheet: Every Kafka Script, Copy-Pasteable

**Roles:** [ARCH] [ADMIN] [DEV]   **Level:** Reference
**Prerequisites:** [Core concepts](../01-fundamentals/01-core-concepts.md)

## What you will learn
- The exact syntax of every Kafka CLI script that matters day to day, grouped by task
- How to authenticate the tools against SASL_SSL or mTLS clusters with a `client.properties` file
- The Connect REST, Schema Registry REST and `kcat` equivalents of the shell scripts
- A set of common operational recipes (purge, lag, drain a broker, rotate a certificate, quorum health)

Conventions used on this page:

- `broker:9092` is a bootstrap broker; `controller:9093` is a KRaft controller listener.
- Every command that talks to a secured cluster takes `--command-config client.properties` (or `--producer.config` / `--consumer.config`). The templates are in [section 12](#12-clientproperties-templates).
- On Windows the same scripts exist under `bin/windows/*.bat`. Confluent Platform packages ship the same scripts without the `.sh` suffix (`kafka-topics` instead of `kafka-topics.sh`).
- Since 4.0 the `--zookeeper` flag has been removed from every tool; everything goes through `--bootstrap-server` or `--bootstrap-controller`.

> **Production tip:** put `export KAFKA_OPTS="-Djava.security.auth.login.config=/etc/kafka/jaas.conf"` and `export KAFKA_HEAP_OPTS="-Xmx1g"` in the admin shell profile so every tool picks them up. Never run the tools with the broker's heap settings.

---

## 1. Topics

### 1.1 `kafka-topics.sh`

| Task | Command |
|------|---------|
| Create | `kafka-topics.sh --bootstrap-server broker:9092 --create --topic orders --partitions 12 --replication-factor 3` |
| Create with configs | `kafka-topics.sh --bootstrap-server broker:9092 --create --topic orders --partitions 12 --replication-factor 3 --config retention.ms=604800000 --config min.insync.replicas=2 --config cleanup.policy=delete --config compression.type=zstd` |
| Create compacted | `kafka-topics.sh --bootstrap-server broker:9092 --create --topic customer-state --partitions 6 --replication-factor 3 --config cleanup.policy=compact --config min.cleanable.dirty.ratio=0.2 --config delete.retention.ms=86400000` |
| Create with explicit replica placement | `kafka-topics.sh --bootstrap-server broker:9092 --create --topic orders --replica-assignment 1:2:3,2:3:1,3:1:2` (one `leader:follower:follower` group per partition; do not combine with `--partitions`) |
| Create only if absent | add `--if-not-exists` |
| List | `kafka-topics.sh --bootstrap-server broker:9092 --list` |
| List, hiding internal topics | `kafka-topics.sh --bootstrap-server broker:9092 --list --exclude-internal` |
| Describe one topic | `kafka-topics.sh --bootstrap-server broker:9092 --describe --topic orders` |
| Describe by topic id (since 3.x) | `kafka-topics.sh --bootstrap-server broker:9092 --describe --topic-id 5b1e7YTNQzO7cWv-DkV9Bg` |
| Describe all topics | `kafka-topics.sh --bootstrap-server broker:9092 --describe` |
| Describe topics with non-default configs | `kafka-topics.sh --bootstrap-server broker:9092 --describe --topics-with-overrides` |
| Under-replicated partitions | `kafka-topics.sh --bootstrap-server broker:9092 --describe --under-replicated-partitions` |
| Partitions at exactly `min.insync.replicas` | `kafka-topics.sh --bootstrap-server broker:9092 --describe --at-min-isr-partitions` |
| Partitions below `min.insync.replicas` | `kafka-topics.sh --bootstrap-server broker:9092 --describe --under-min-isr-partitions` |
| Partitions with no leader | `kafka-topics.sh --bootstrap-server broker:9092 --describe --unavailable-partitions` |
| Add partitions (never shrink) | `kafka-topics.sh --bootstrap-server broker:9092 --alter --topic orders --partitions 24` |
| Delete | `kafka-topics.sh --bootstrap-server broker:9092 --delete --topic orders` |
| Delete only if present | add `--if-exists` |
| Secured cluster | append `--command-config client.properties` to any of the above |

Notes:

- Topic-level configuration is changed with `kafka-configs.sh` (section 3), not with `kafka-topics.sh --alter --config`; that flag was removed in 3.0.
- Adding partitions changes key-to-partition mapping for keyed topics and breaks co-partitioning with joined topics. Treat it as a schema change.
- `--delete` marks the topic for deletion; the actual log directories are removed asynchronously (`log.segment.delete.delay.ms`, default 60 s). With `delete.topic.enable=false` on the brokers the request is rejected.

Example describe output and how to read it:

```text
Topic: orders  TopicId: 5b1e7YTNQzO7cWv-DkV9Bg  PartitionCount: 3  ReplicationFactor: 3  Configs: min.insync.replicas=2,retention.ms=604800000
    Topic: orders  Partition: 0  Leader: 1  Replicas: 1,2,3  Isr: 1,2,3  Elr:  LastKnownElr:
    Topic: orders  Partition: 1  Leader: 2  Replicas: 2,3,1  Isr: 2,3
    Topic: orders  Partition: 2  Leader: none  Replicas: 3,1,2  Isr: 3
```

- Partition 1 is under-replicated (ISR has 2 of 3 replicas). Partition 2 is unavailable (`Leader: none`). `Elr`/`LastKnownElr` columns appear when `eligible.leader.replicas.version` is enabled (KIP-966, 4.0).

---

## 2. Console producer and consumer

### 2.1 `kafka-console-producer.sh`

```bash
# plain values, one record per line
kafka-console-producer.sh --bootstrap-server broker:9092 --topic orders

# key:value with a custom separator
kafka-console-producer.sh --bootstrap-server broker:9092 --topic orders \
  --property parse.key=true --property key.separator=:

# headers + key + value (since 3.2, KIP-798). Input line: h1=v1,h2=v2<TAB>key:value
kafka-console-producer.sh --bootstrap-server broker:9092 --topic orders \
  --property parse.headers=true --property parse.key=true \
  --property headers.delimiter='\t' --property headers.separator=',' \
  --property headers.key.separator='=' --property key.separator=:

# send a null value (tombstone) on a compacted topic: type  key:NULL
kafka-console-producer.sh --bootstrap-server broker:9092 --topic customer-state \
  --property parse.key=true --property key.separator=: --property null.marker=NULL

# producer tuning through the standard producer configs
kafka-console-producer.sh --bootstrap-server broker:9092 --topic orders \
  --producer-property acks=all --producer-property linger.ms=20 \
  --producer-property compression.type=zstd --producer-property enable.idempotence=true

# SASL_SSL cluster with a properties file
kafka-console-producer.sh --bootstrap-server broker:9093 --topic orders \
  --producer.config client.properties

# produce a file, one record per line
kafka-console-producer.sh --bootstrap-server broker:9092 --topic orders < orders.jsonl

# pin to a partition or send in batches with a timeout
kafka-console-producer.sh --bootstrap-server broker:9092 --topic orders \
  --batch-size 200 --timeout 1000 --max-block-ms 5000
```

Useful `--property` keys: `parse.key`, `key.separator`, `parse.headers`, `headers.delimiter`, `headers.separator`, `headers.key.separator`, `null.marker`, `ignore.error`, `key.serializer`, `value.serializer`. Standard producer configs go through `--producer-property k=v` or `--producer.config file`.

### 2.2 `kafka-console-consumer.sh`

```bash
# tail a topic (new records only)
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic orders

# from the beginning, with everything printed
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic orders --from-beginning \
  --property print.key=true --property print.timestamp=true --property print.headers=true \
  --property print.partition=true --property print.offset=true \
  --property key.separator=' | ' --property headers.separator=','

# a fixed number of records, then exit
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic orders --from-beginning --max-messages 10

# exit when there is nothing to read for 5 s (useful in scripts)
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic orders --from-beginning --timeout-ms 5000

# one partition from a specific offset (offset may be a number, earliest or latest)
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic orders --partition 3 --offset 1200 --max-messages 5

# join a consumer group (commits offsets under that group id)
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic orders --group debug-reader

# only committed transactional records
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic payments --from-beginning \
  --isolation-level read_committed

# several topics by regex (--whitelist was removed in 4.0; use --include)
kafka-console-consumer.sh --bootstrap-server broker:9092 --include 'orders.*' --from-beginning

# skip records that fail deserialization instead of dying
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic orders --skip-message-on-error

# deserialize keys/values with explicit deserializers
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic metrics --from-beginning \
  --key-deserializer org.apache.kafka.common.serialization.StringDeserializer \
  --value-deserializer org.apache.kafka.common.serialization.LongDeserializer

# SASL_SSL cluster
kafka-console-consumer.sh --bootstrap-server broker:9093 --topic orders --consumer.config client.properties

# inspect __consumer_offsets in human-readable form
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic __consumer_offsets --from-beginning \
  --formatter "org.apache.kafka.tools.consumer.group.GroupMetadataMessageFormatter" \
  --consumer-property exclude.internal.topics=false

# inspect __transaction_state
kafka-console-consumer.sh --bootstrap-server broker:9092 --topic __transaction_state --from-beginning \
  --formatter "org.apache.kafka.tools.consumer.TransactionLogMessageFormatter" \
  --consumer-property exclude.internal.topics=false
```

Notes:

- Without `--group` the console consumer generates a `console-consumer-<random>` group and does not commit offsets; a stray `--group` on a production group will steal partitions from the real application.
- `--partition` and `--group` are mutually exclusive (manual assignment vs group subscription).
- `--offset` only works with `--partition`. `--from-beginning` is ignored when the group already has committed offsets.
- The formatter class names for `__consumer_offsets` moved to `org.apache.kafka.tools.consumer.group.*` in 3.8/4.0 (the old `kafka.coordinator.group.GroupMetadataManager$OffsetsMessageFormatter` was removed in 4.0). Available: `OffsetsMessageFormatter`, `GroupMetadataMessageFormatter`. For Confluent Schema Registry use `io.confluent.kafka.formatter.AvroMessageFormatter` with `--property schema.registry.url=...` (via `kafka-avro-console-consumer`).

---

## 3. Consumer groups: `kafka-consumer-groups.sh`

```bash
# list all groups
kafka-consumer-groups.sh --bootstrap-server broker:9092 --list

# list by state (Stable, Empty, PreparingRebalance, CompletingRebalance, Dead, Assigning, Reconciling)
kafka-consumer-groups.sh --bootstrap-server broker:9092 --list --state Stable,Empty

# list by protocol type (4.0, KIP-848): classic | consumer
kafka-consumer-groups.sh --bootstrap-server broker:9092 --list --type consumer

# describe offsets and lag (the default view)
kafka-consumer-groups.sh --bootstrap-server broker:9092 --describe --group order-service

# describe every group at once
kafka-consumer-groups.sh --bootstrap-server broker:9092 --describe --all-groups

# members and their assignments
kafka-consumer-groups.sh --bootstrap-server broker:9092 --describe --group order-service --members
kafka-consumer-groups.sh --bootstrap-server broker:9092 --describe --group order-service --members --verbose

# state, coordinator, assignor, member count
kafka-consumer-groups.sh --bootstrap-server broker:9092 --describe --group order-service --state
```

Example describe output:

```text
GROUP          TOPIC   PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG   CONSUMER-ID                        HOST         CLIENT-ID
order-service  orders  0          10402           10402           0     consumer-order-service-1-4f2e...   /10.0.1.12   order-service-1
order-service  orders  1          9911            10388           477   consumer-order-service-2-91ab...   /10.0.1.13   order-service-2
order-service  orders  2          -               10120           -     -                                  -            -
```

- `CURRENT-OFFSET -` means no committed offset for that partition. A partition with no `CONSUMER-ID` is unassigned (group is Empty or has fewer members than partitions).

### 3.1 Reset offsets

The group must be **inactive** (no live members) for a reset. Always run with `--dry-run` first (the default), then repeat with `--execute`.

```bash
# to earliest / latest
kafka-consumer-groups.sh --bootstrap-server broker:9092 --group order-service --reset-offsets --topic orders --to-earliest --dry-run
kafka-consumer-groups.sh --bootstrap-server broker:9092 --group order-service --reset-offsets --topic orders --to-latest --execute

# to a specific offset on selected partitions
kafka-consumer-groups.sh --bootstrap-server broker:9092 --group order-service --reset-offsets --topic orders:0,1 --to-offset 5000 --execute

# shift forward/backward relative to the current committed offset
kafka-consumer-groups.sh --bootstrap-server broker:9092 --group order-service --reset-offsets --topic orders --shift-by -1000 --execute

# to a timestamp (ISO-8601, local time unless a zone is given) — uses the record timestamp index
kafka-consumer-groups.sh --bootstrap-server broker:9092 --group order-service --reset-offsets --topic orders --to-datetime 2026-09-01T00:00:00.000 --execute

# to "now minus a duration" (ISO-8601 duration)
kafka-consumer-groups.sh --bootstrap-server broker:9092 --group order-service --reset-offsets --all-topics --by-duration PT2H --execute

# re-commit the current position (useful to materialize offsets before a group is deleted)
kafka-consumer-groups.sh --bootstrap-server broker:9092 --group order-service --reset-offsets --all-topics --to-current --execute

# export the plan, edit it, then apply from file (CSV: topic,partition,offset)
kafka-consumer-groups.sh --bootstrap-server broker:9092 --group order-service --reset-offsets --all-topics --to-current --export > offsets.csv
kafka-consumer-groups.sh --bootstrap-server broker:9092 --group order-service --reset-offsets --from-file offsets.csv --execute
```

### 3.2 Delete groups and offsets

```bash
# delete a whole group (must be empty)
kafka-consumer-groups.sh --bootstrap-server broker:9092 --delete --group order-service --group old-reader

# delete committed offsets for one topic only (group must not be actively consuming that topic)
kafka-consumer-groups.sh --bootstrap-server broker:9092 --delete-offsets --group order-service --topic orders

# per-command timeout (ms) for slow coordinators
kafka-consumer-groups.sh --bootstrap-server broker:9092 --describe --group order-service --timeout 15000
```

> **Anti-pattern:** resetting offsets while the application is running. The reset is rejected with "Assignments can only be reset if the group is inactive", and if you stop only one member the remaining members will rebalance and commit their own positions over yours. Stop every instance, reset, verify with `--describe`, then start.

### 3.3 Share groups (4.0 early access, 4.1 preview, KIP-932)

```bash
kafka-share-groups.sh --bootstrap-server broker:9092 --list
kafka-share-groups.sh --bootstrap-server broker:9092 --describe --group inbox-workers
kafka-share-groups.sh --bootstrap-server broker:9092 --describe --group inbox-workers --members
kafka-share-groups.sh --bootstrap-server broker:9092 --reset-offsets --group inbox-workers --topic tasks --to-earliest --execute
kafka-share-groups.sh --bootstrap-server broker:9092 --delete --group inbox-workers
```

Share groups require the `share.version` feature (4.1) and, in 4.0, `unstable.api.versions.enable=true` plus `group.coordinator.rebalance.protocols=classic,consumer,share`.

---

## 4. Configuration: `kafka-configs.sh`

Entity types: `topics`, `brokers`, `broker-loggers`, `users`, `clients`, `ips`, `client-metrics` (3.7, KIP-714), `groups` (4.0, KIP-848). Shorthand flags exist: `--topic`, `--broker`, `--user`, `--client`, `--ip`, `--broker-defaults`, `--user-defaults`, `--client-defaults`, `--ip-defaults`.

### 4.1 Topics

```bash
# show overrides only
kafka-configs.sh --bootstrap-server broker:9092 --describe --entity-type topics --entity-name orders
# show every config including defaults and where they come from
kafka-configs.sh --bootstrap-server broker:9092 --describe --entity-type topics --entity-name orders --all

# set / change
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type topics --entity-name orders \
  --add-config retention.ms=259200000,min.insync.replicas=2,max.message.bytes=2097152

# remove an override (revert to broker default)
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type topics --entity-name orders \
  --delete-config retention.ms

# list-valued configs use brackets
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type topics --entity-name orders \
  --add-config 'leader.replication.throttled.replicas=[0:1,0:2],follower.replication.throttled.replicas=[0:3]'
```

### 4.2 Brokers (dynamic configs, KIP-226)

```bash
# describe one broker's dynamic configs / all with defaults
kafka-configs.sh --bootstrap-server broker:9092 --describe --entity-type brokers --entity-name 1
kafka-configs.sh --bootstrap-server broker:9092 --describe --entity-type brokers --entity-name 1 --all

# per-broker override
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type brokers --entity-name 1 \
  --add-config log.cleaner.threads=2,num.io.threads=16

# cluster-wide default (applies to every broker, persisted in metadata log)
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type brokers --entity-default \
  --add-config log.retention.ms=604800000,message.max.bytes=2097152,unclean.leader.election.enable=false

# revert
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type brokers --entity-default --delete-config log.retention.ms

# per-listener TLS keystore rotation (see recipe 13.4)
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type brokers --entity-name 1 \
  --add-config listener.name.external.ssl.keystore.location=/etc/kafka/ssl/broker1-2026.p12,listener.name.external.ssl.keystore.password=changeit

# change a logger level at runtime
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type broker-loggers --entity-name 1 \
  --add-config kafka.request.logger=DEBUG
kafka-configs.sh --bootstrap-server broker:9092 --describe --entity-type broker-loggers --entity-name 1
```

Only configs marked `read-only=false` (dynamic) can be altered. `--describe --all` prints the source of each value: `DYNAMIC_BROKER_CONFIG`, `DYNAMIC_DEFAULT_BROKER_CONFIG`, `STATIC_BROKER_CONFIG`, `DEFAULT_CONFIG`.

### 4.3 Users: SCRAM credentials

```bash
# create / update credentials (SCRAM-SHA-256 or SCRAM-SHA-512)
kafka-configs.sh --bootstrap-server broker:9092 --command-config admin.properties --alter \
  --entity-type users --entity-name alice \
  --add-config 'SCRAM-SHA-512=[iterations=8192,password=alice-secret]'

# both mechanisms at once
kafka-configs.sh --bootstrap-server broker:9092 --command-config admin.properties --alter \
  --entity-type users --entity-name alice \
  --add-config 'SCRAM-SHA-256=[password=alice-secret],SCRAM-SHA-512=[password=alice-secret]'

# list credentials (shows mechanism and iterations, never the password)
kafka-configs.sh --bootstrap-server broker:9092 --command-config admin.properties --describe --entity-type users --entity-name alice
kafka-configs.sh --bootstrap-server broker:9092 --command-config admin.properties --describe --entity-type users

# revoke
kafka-configs.sh --bootstrap-server broker:9092 --command-config admin.properties --alter \
  --entity-type users --entity-name alice --delete-config 'SCRAM-SHA-512'
```

In KRaft, the very first SCRAM user (the one the brokers use for inter-broker auth) must be created at format time with `kafka-storage.sh format --add-scram` (section 8), because there is no cluster to talk to yet.

### 4.4 Quotas (users, clients, user+client, IPs)

Quota keys: `producer_byte_rate`, `consumer_byte_rate`, `request_percentage`, `controller_mutation_rate`; IP entities: `connection_creation_rate`.

```bash
# per user
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type users --entity-name alice \
  --add-config 'producer_byte_rate=10485760,consumer_byte_rate=20971520,request_percentage=200'

# per client-id (any user)
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type clients --entity-name batch-loader \
  --add-config 'producer_byte_rate=52428800'

# user + client-id combination (most specific, wins over user-only and client-only)
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type users --entity-name alice \
  --entity-type clients --entity-name batch-loader --add-config 'producer_byte_rate=5242880'

# default for all users / all clients of a user
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type users --entity-default --add-config 'consumer_byte_rate=104857600'
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type users --entity-name alice --entity-type clients --entity-default --add-config 'request_percentage=100'

# topic/partition mutation rate (create/delete/add partitions) per principal
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type users --entity-name ci-bot --add-config 'controller_mutation_rate=5'

# connection creation rate per source IP; --entity-default = all IPs
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type ips --entity-name 10.0.5.17 --add-config 'connection_creation_rate=20'
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type ips --entity-default --add-config 'connection_creation_rate=100'

# describe / remove
kafka-configs.sh --bootstrap-server broker:9092 --describe --entity-type users --entity-name alice
kafka-configs.sh --bootstrap-server broker:9092 --describe --entity-type ips
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type users --entity-name alice --delete-config producer_byte_rate
```

Quota precedence (most to least specific): `/config/users/<user>/clients/<client-id>` > `/config/users/<user>/clients/<default>` > `/config/users/<user>` > `/config/users/<default>/clients/<client-id>` > `/config/users/<default>/clients/<default>` > `/config/users/<default>` > `/config/clients/<client-id>` > `/config/clients/<default>`. Quotas are per broker, not cluster-wide.

### 4.5 Client metrics subscriptions (3.7, KIP-714) and group configs (4.0)

```bash
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type client-metrics --entity-name java-producers \
  --add-config 'metrics=org.apache.kafka.producer.,interval.ms=30000,match=client_software_name=apache-kafka-java'
kafka-configs.sh --bootstrap-server broker:9092 --describe --entity-type client-metrics

# per-group overrides for the new consumer protocol
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type groups --entity-name order-service \
  --add-config consumer.session.timeout.ms=60000,consumer.heartbeat.interval.ms=10000
```

---

## 5. ACLs: `kafka-acls.sh`

Requires an authorizer on the brokers (`authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer` in KRaft) and a principal with `Alter` on `Cluster` (or `super.users`).

```bash
# producer shortcut: Write + Describe + Create on the topic (Create only if the topic may be auto-created)
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --add \
  --allow-principal User:order-producer --producer --topic orders

# consumer shortcut: Read + Describe on the topic, Read on the group
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --add \
  --allow-principal User:order-service --consumer --topic orders --group order-service

# transactional producer: Write + Describe on the transactional id, plus --producer on the topic
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --add \
  --allow-principal User:payments --producer --topic payments \
  --transactional-id payments-svc- --resource-pattern-type prefixed

# prefixed pattern on topics and groups (all topics starting with "orders-")
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --add \
  --allow-principal User:analytics --operation Read --operation Describe \
  --topic orders- --resource-pattern-type prefixed --group analytics- --resource-pattern-type prefixed

# explicit operations
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --add \
  --allow-principal User:admin-tool --operation Create --operation Delete --operation Alter \
  --operation AlterConfigs --operation DescribeConfigs --cluster

# Kafka Streams application: topics, group, internal topics by prefix, Create on cluster is NOT needed when internal topics use the prefix
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --add \
  --allow-principal User:fraud-app --operation All --topic fraud-app- --resource-pattern-type prefixed \
  --group fraud-app --transactional-id fraud-app- --resource-pattern-type prefixed

# host restriction and deny rules (deny always wins over allow)
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --add \
  --allow-principal User:etl --operation Read --topic orders --allow-host 10.0.7.10 --allow-host 10.0.7.11
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --add \
  --deny-principal User:contractor --operation All --topic pii- --resource-pattern-type prefixed

# wildcard principal / wildcard resource
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --add \
  --allow-principal 'User:*' --operation Describe --topic '*'

# delegation tokens: allow a user to create tokens for another principal (KIP-373)
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --add \
  --allow-principal User:token-issuer --operation CreateTokens --user-principal User:alice

# list
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --list
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --list --topic orders
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --list --principal User:order-service
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --list --topic orders-eu --resource-pattern-type match   # shows literal, prefixed and wildcard ACLs that apply

# remove (--force skips the confirmation prompt)
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --remove \
  --allow-principal User:order-service --operation Read --topic orders --group order-service --force
kafka-acls.sh --bootstrap-server broker:9092 --command-config admin.properties --remove --topic old-topic --force
```

Operations: `Read`, `Write`, `Create`, `Delete`, `Alter`, `Describe`, `ClusterAction`, `DescribeConfigs`, `AlterConfigs`, `IdempotentWrite` (implicit for principals with `Write` on any topic since 2.8, KIP-679), `CreateTokens`, `DescribeTokens`, `All`. Resource types: `--topic`, `--group`, `--cluster`, `--transactional-id`, `--delegation-token`, `--user-principal`. Pattern types: `literal` (default), `prefixed`, `match` (list only), `any` (list/remove only).

---

## 6. Partition placement and leadership

### 6.1 `kafka-reassign-partitions.sh`

```bash
# 1. topics to move
cat > topics.json <<'EOF'
{"version":1,"topics":[{"topic":"orders"},{"topic":"payments"}]}
EOF

# 2. generate a proposal spread over the given brokers (rack-aware unless --disable-rack-aware)
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --generate \
  --topics-to-move-json-file topics.json --broker-list 1,2,3,4
# copy "Current partition replica assignment" to rollback.json and "Proposed" to plan.json

# 3. execute with a throttle (bytes/s per broker for inter-broker replication)
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --execute \
  --reassignment-json-file plan.json --throttle 100000000

# 3b. also throttle intra-broker moves between log dirs (JBOD)
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --execute \
  --reassignment-json-file plan.json --throttle 100000000 --replica-alter-log-dirs-throttle 50000000

# 4. verify progress; when everything is complete this call ALSO removes the throttles
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --verify --reassignment-json-file plan.json
# keep throttles after verify (3.x)
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --verify --reassignment-json-file plan.json --preserve-throttles

# list all in-flight reassignments
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --list

# cancel in-flight reassignments (reverts to the original replica set)
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --cancel --reassignment-json-file plan.json

# add a reassignment while another is in progress
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --execute --reassignment-json-file plan2.json --additional

# change the throttle of a running reassignment: re-run --execute with the same file and a new --throttle
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --execute --reassignment-json-file plan.json --throttle 300000000
```

Plan file format (`log_dirs` is optional; `"any"` lets the broker choose; a path moves the replica to that log dir):

```json
{"version":1,"partitions":[
  {"topic":"orders","partition":0,"replicas":[2,3,4],"log_dirs":["any","any","/data/disk2"]},
  {"topic":"orders","partition":1,"replicas":[3,4,1]}
]}
```

- The first replica in `replicas` becomes the preferred leader.
- Changing replication factor is a reassignment with more (or fewer) replicas per partition.
- Throttle applies to `leader.replication.throttled.rate` / `follower.replication.throttled.rate` on the brokers and to the throttled-replicas topic configs. If a reassignment is aborted before `--verify` completes, remove the throttle by hand with `kafka-configs.sh --delete-config`.

### 6.2 `kafka-leader-election.sh`

```bash
# preferred leader election for everything (what auto.leader.rebalance.enable does on a schedule)
kafka-leader-election.sh --bootstrap-server broker:9092 --election-type preferred --all-topic-partitions

# one partition
kafka-leader-election.sh --bootstrap-server broker:9092 --election-type preferred --topic orders --partition 3

# a list from a file
cat > partitions.json <<'EOF'
{"partitions":[{"topic":"orders","partition":0},{"topic":"orders","partition":1}]}
EOF
kafka-leader-election.sh --bootstrap-server broker:9092 --election-type preferred --path-to-json-file partitions.json

# UNCLEAN election: elects an out-of-sync replica, accepts data loss. Last resort for an offline partition.
kafka-leader-election.sh --bootstrap-server broker:9092 --election-type unclean --topic orders --partition 2
```

### 6.3 `kafka-log-dirs.sh`

```bash
# sizes and offset lag of every replica per log dir (JSON)
kafka-log-dirs.sh --bootstrap-server broker:9092 --describe
kafka-log-dirs.sh --bootstrap-server broker:9092 --describe --broker-list 1,2 --topic-list orders,payments

# quick "which topic eats my disk" one-liner
kafka-log-dirs.sh --bootstrap-server broker:9092 --describe --broker-list 1 | grep '^{' | \
  jq -r '.brokers[].logDirs[].partitions[] | "\(.size) \(.partition)"' | sort -nr | head -20
```

Output includes `size` (bytes on disk), `offsetLag` (how far behind the replica is), `isFuture` (replica being moved between log dirs), and since 3.3 `totalBytes`/`usableBytes` per log dir (KIP-827).

### 6.4 `kafka-get-offsets.sh`

```bash
# log-end offsets (latest) for all partitions of a topic
kafka-get-offsets.sh --bootstrap-server broker:9092 --topic orders --time latest       # or -1
# earliest available offsets (log-start)
kafka-get-offsets.sh --bootstrap-server broker:9092 --topic orders --time earliest     # or -2
# offset of the record with the highest timestamp
kafka-get-offsets.sh --bootstrap-server broker:9092 --topic orders --time max-timestamp # or -3
# first offset >= a timestamp (epoch millis)
kafka-get-offsets.sh --bootstrap-server broker:9092 --topic orders --time 1756684800000
# selected partitions, or a regex over topic:partition ranges
kafka-get-offsets.sh --bootstrap-server broker:9092 --topic orders --partitions 0,1,2 --time latest
kafka-get-offsets.sh --bootstrap-server broker:9092 --topic-partitions 'orders:0-5,payments:.*' --time latest
# tiered storage (3.9, KIP-1005): earliest-local (-4) and latest-tiered (-5)
kafka-get-offsets.sh --bootstrap-server broker:9092 --topic orders --time earliest-local
```

### 6.5 `kafka-delete-records.sh`

Advances the log start offset; records below it are deleted asynchronously. Offset `-1` means "up to the high watermark".

```bash
cat > delete.json <<'EOF'
{"version":1,"partitions":[
  {"topic":"orders","partition":0,"offset":150000},
  {"topic":"orders","partition":1,"offset":-1}
]}
EOF
kafka-delete-records.sh --bootstrap-server broker:9092 --offset-json-file delete.json
```

---

## 7. Inspecting logs on disk: `kafka-dump-log.sh`

Runs on the broker host against files in `log.dirs`. Read-only; safe on a live broker (it uses the page cache like the broker does).

```bash
# batch headers only
kafka-dump-log.sh --files /var/lib/kafka/orders-0/00000000000000000000.log

# every record with key/value payloads
kafka-dump-log.sh --files /var/lib/kafka/orders-0/00000000000000000000.log --deep-iteration --print-data-log

# offset index / time index / transaction index / producer snapshot
kafka-dump-log.sh --files /var/lib/kafka/orders-0/00000000000000000000.index
kafka-dump-log.sh --files /var/lib/kafka/orders-0/00000000000000000000.timeindex
kafka-dump-log.sh --files /var/lib/kafka/orders-0/00000000000000000000.txnindex
kafka-dump-log.sh --files /var/lib/kafka/orders-0/00000000000000012345.snapshot

# verify index consistency without printing
kafka-dump-log.sh --files /var/lib/kafka/orders-0/00000000000000000000.index --index-sanity-check
kafka-dump-log.sh --files /var/lib/kafka/orders-0/00000000000000000000.log --verify-index-only

# decode internal topics
kafka-dump-log.sh --files /var/lib/kafka/__consumer_offsets-12/00000000000000000000.log --offsets-decoder --deep-iteration
kafka-dump-log.sh --files /var/lib/kafka/__transaction_state-3/00000000000000000000.log --transaction-log-decoder --deep-iteration
kafka-dump-log.sh --files /var/lib/kafka/__cluster_metadata-0/00000000000000000000.log --cluster-metadata-decoder --deep-iteration
kafka-dump-log.sh --files /var/lib/kafka/__cluster_metadata-0/00000000000000042000-0000000004.checkpoint --cluster-metadata-decoder
kafka-dump-log.sh --files /var/lib/kafka/__remote_log_metadata-0/00000000000000000000.log --remote-log-metadata-decoder   # 3.9, KIP-1057
kafka-dump-log.sh --files /var/lib/kafka/__share_group_state-0/00000000000000000000.log --share-group-state-decoder      # 4.0+

# custom decoders for application payloads
kafka-dump-log.sh --files /var/lib/kafka/orders-0/00000000000000000000.log --deep-iteration --print-data-log \
  --key-decoder-class kafka.serializer.StringDecoder --value-decoder-class kafka.serializer.StringDecoder \
  --skip-record-metadata
```

Fields in a batch header worth knowing: `baseOffset`, `lastOffset`, `producerId`, `producerEpoch`, `baseSequence`, `isTransactional`, `isControl` (commit/abort markers), `compresscodec`, `crc`, `magic` (2 since 0.11; v0/v1 are rejected by 4.0 brokers, KIP-724), `position`, `CreateTime`/`LogAppendTime`.

---

## 8. KRaft cluster lifecycle

### 8.1 `kafka-storage.sh`

```bash
# 1. one cluster id per cluster
KAFKA_CLUSTER_ID=$(kafka-storage.sh random-uuid)

# 2. format every node's log.dirs (and metadata.log.dir) BEFORE first start
kafka-storage.sh format -t "$KAFKA_CLUSTER_ID" -c /etc/kafka/server.properties
# idempotent in provisioning scripts
kafka-storage.sh format -t "$KAFKA_CLUSTER_ID" -c /etc/kafka/server.properties --ignore-formatted

# pin the feature levels written at format time
kafka-storage.sh format -t "$KAFKA_CLUSTER_ID" -c /etc/kafka/server.properties --release-version 4.0
kafka-storage.sh format -t "$KAFKA_CLUSTER_ID" -c /etc/kafka/server.properties --feature metadata.version=25 --feature kraft.version=1

# bootstrap SCRAM credentials for inter-broker / admin auth (3.5, KIP-900)
kafka-storage.sh format -t "$KAFKA_CLUSTER_ID" -c /etc/kafka/server.properties \
  --add-scram 'SCRAM-SHA-512=[name=admin,password=admin-secret]' \
  --add-scram 'SCRAM-SHA-512=[name=broker,password=broker-secret]'

# dynamic quorum (3.9, KIP-853): single-node controller bootstrap
kafka-storage.sh format -t "$KAFKA_CLUSTER_ID" -c /etc/kafka/controller.properties --standalone

# dynamic quorum: bootstrap three controllers at once. Format: id@host:port:directory-id
kafka-storage.sh format -t "$KAFKA_CLUSTER_ID" -c /etc/kafka/controller.properties \
  --initial-controllers "1@controller-1:9093:A1b2C3d4E5f6G7h8I9j0KA,2@controller-2:9093:B1b2C3d4E5f6G7h8I9j0KB,3@controller-3:9093:C1b2C3d4E5f6G7h8I9j0KC"

# brokers (or controllers joining later) in a dynamic-quorum cluster
kafka-storage.sh format -t "$KAFKA_CLUSTER_ID" -c /etc/kafka/server.properties --no-initial-controllers

# show what is on disk
kafka-storage.sh info -c /etc/kafka/server.properties

# feature helpers (3.8/4.0, KIP-1022)
kafka-storage.sh version-mapping --release-version 4.0
kafka-storage.sh feature-dependencies --feature kraft.version=1
```

The directory id used in `--initial-controllers` must match the `directory.id` that `format` writes into `meta.properties` on that node; generate them with `kafka-storage.sh random-uuid` and pass the same value to every node's `--initial-controllers` string. With the static quorum (`controller.quorum.voters`) you omit `--standalone` / `--initial-controllers`.

### 8.2 `kafka-metadata-quorum.sh`

```bash
# overall quorum status: leader id, epoch, high watermark, current voters and observers with lag
kafka-metadata-quorum.sh --bootstrap-server broker:9092 describe --status

# per-replica replication state (LogEndOffset, Lag, LastFetchTimestamp, LastCaughtUpTimestamp)
kafka-metadata-quorum.sh --bootstrap-server broker:9092 describe --replication
kafka-metadata-quorum.sh --bootstrap-server broker:9092 describe --replication --human-readable

# talk to the controllers directly (3.7, KIP-919), for example when brokers are down
kafka-metadata-quorum.sh --bootstrap-controller controller-1:9093 describe --status

# dynamic quorum membership (3.9, KIP-853). Run add-controller ON the new controller node,
# after it has been formatted with --no-initial-controllers and started; it reads its own config.
kafka-metadata-quorum.sh --bootstrap-server broker:9092 --command-config /etc/kafka/controller.properties add-controller

# remove a controller by id + directory id (get both from describe --status)
kafka-metadata-quorum.sh --bootstrap-server broker:9092 remove-controller --controller-id 3 --controller-directory-id C1b2C3d4E5f6G7h8I9j0KC
```

Healthy `describe --status` looks like:

```text
ClusterId:              5L6g3nShT-eMCtK--X86sw
LeaderId:               1
LeaderEpoch:            17
HighWatermark:          812345
MaxFollowerLag:         0
MaxFollowerLagTimeMs:   0
CurrentVoters:          [{"id": 1, "directoryId": "...", "endpoints": ["CONTROLLER://controller-1:9093"]}, ...]
CurrentObservers:       [{"id": 101, ...}, {"id": 102, ...}, {"id": 103, ...}]
```

Brokers appear as observers. A follower with a growing `Lag` and an old `LastCaughtUpTimestamp` is the one to investigate.

### 8.3 `kafka-metadata.sh` (metadata shell)

Offline browser for the metadata log or a snapshot; run on a controller host or on a copy of `__cluster_metadata-0`.

```bash
# open a snapshot
kafka-metadata.sh --snapshot /var/lib/kafka/__cluster_metadata-0/00000000000000042000-0000000004.checkpoint
# or the whole directory (log + snapshots)
kafka-metadata.sh --directory /var/lib/kafka/__cluster_metadata-0

# non-interactive
kafka-metadata.sh --snapshot .../00000000000000042000-0000000004.checkpoint ls /image/topics/byName
kafka-metadata.sh --snapshot .../00000000000000042000-0000000004.checkpoint cat /image/topics/byName/orders
kafka-metadata.sh --snapshot .../00000000000000042000-0000000004.checkpoint cat /image/brokers/1
kafka-metadata.sh --snapshot .../00000000000000042000-0000000004.checkpoint cat /image/configs/BROKER/1
kafka-metadata.sh --snapshot .../00000000000000042000-0000000004.checkpoint cat /image/features/metadata.version
kafka-metadata.sh --snapshot .../00000000000000042000-0000000004.checkpoint tree /image/acls
```

Shell commands: `ls`, `cat`, `cd`, `pwd`, `find`, `tree`, `history`, `man`, `help`, `exit`. Tree roots: `/image` (the loaded metadata image: `topics`, `brokers`, `configs`, `features`, `acls`, `clientQuotas`, `scram`, `producerIds`, `delegationTokens`) and `/local` (`version`, `commitId`).

### 8.4 `kafka-features.sh`

```bash
# what the cluster runs and what it supports
kafka-features.sh --bootstrap-server broker:9092 describe

# upgrade everything to the levels of a release (preferred since 3.8, KIP-1022)
kafka-features.sh --bootstrap-server broker:9092 upgrade --release-version 4.0
kafka-features.sh --bootstrap-server broker:9092 upgrade --release-version 4.0 --dry-run

# upgrade one feature
kafka-features.sh --bootstrap-server broker:9092 upgrade --feature metadata.version=25
kafka-features.sh --bootstrap-server broker:9092 upgrade --feature transaction.version=2
kafka-features.sh --bootstrap-server broker:9092 upgrade --feature group.version=1
kafka-features.sh --bootstrap-server broker:9092 upgrade --feature kraft.version=1          # static -> dynamic quorum (3.9)
kafka-features.sh --bootstrap-server broker:9092 upgrade --feature eligible.leader.replicas.version=1

# older syntax still accepted for metadata.version (3.x)
kafka-features.sh --bootstrap-server broker:9092 upgrade --metadata 3.9

# downgrade (only to a level that does not require dropping metadata; --unsafe forces lossy downgrades)
kafka-features.sh --bootstrap-server broker:9092 downgrade --feature transaction.version=1
kafka-features.sh --bootstrap-server broker:9092 downgrade --feature metadata.version=21 --unsafe
kafka-features.sh --bootstrap-server broker:9092 disable --feature eligible.leader.replicas.version

# mapping helpers
kafka-features.sh --bootstrap-server broker:9092 version-mapping --release-version 4.0
kafka-features.sh --bootstrap-server broker:9092 feature-dependencies --feature transaction.version=2
```

Features in 4.0: `metadata.version`, `kraft.version`, `transaction.version`, `group.version`, `eligible.leader.replicas.version`; 4.1 adds `share.version` and `streams.version`. `metadata.version` can only be bumped after **every** broker and controller runs the new binary; bumping is the "second phase" of a rolling upgrade.

### 8.5 `kafka-cluster.sh` and `kafka-broker-api-versions.sh`

```bash
kafka-cluster.sh cluster-id --bootstrap-server broker:9092
# remove a decommissioned broker's registration so the controller stops waiting for it (3.x, KRaft)
kafka-cluster.sh unregister --bootstrap-server broker:9092 --id 7

# supported API versions per broker; quick way to see which broker version you talk to
kafka-broker-api-versions.sh --bootstrap-server broker:9092
kafka-broker-api-versions.sh --bootstrap-server broker:9093 --command-config client.properties | head -5
```

---

## 9. Performance and verification tools

### 9.1 `kafka-producer-perf-test.sh` / `kafka-consumer-perf-test.sh`

```bash
# 1M records of 1 KiB, unthrottled, idempotent, acks=all
kafka-producer-perf-test.sh --topic perf --num-records 1000000 --record-size 1024 --throughput -1 \
  --producer-props bootstrap.servers=broker:9092 acks=all linger.ms=10 batch.size=131072 compression.type=lz4 \
  --print-metrics

# throttled to 50k rec/s with a properties file (SASL_SSL) and realistic payloads from a file
kafka-producer-perf-test.sh --topic perf --num-records 500000 --throughput 50000 \
  --payload-file sample-orders.jsonl --payload-delimiter '\n' \
  --producer.config client.properties --producer-props bootstrap.servers=broker:9093

# transactional producer benchmark
kafka-producer-perf-test.sh --topic perf --num-records 100000 --record-size 512 --throughput -1 \
  --producer-props bootstrap.servers=broker:9092 --transactional-id perf-tx --transaction-duration-ms 1000

# consumer side
kafka-consumer-perf-test.sh --bootstrap-server broker:9092 --topic perf --messages 1000000 \
  --group perf-reader --timeout 30000 --show-detailed-stats --reporting-interval 5000 --print-metrics
kafka-consumer-perf-test.sh --bootstrap-server broker:9093 --topic perf --messages 1000000 --consumer.config client.properties
```

Output columns of the consumer test: `start.time, end.time, data.consumed.in.MB, MB.sec, data.consumed.in.nMsg, nMsg.sec, rebalance.time.ms, fetch.time.ms, fetch.MB.sec, fetch.nMsg.sec`. Numbers from a single client are a client benchmark, not a cluster benchmark; run several in parallel to saturate brokers.

### 9.2 `kafka-replica-verification.sh`

Checks that replicas of every partition have the same content at the same offsets. Useful after a reassignment or a suspected disk corruption.

```bash
kafka-replica-verification.sh --broker-list broker:9092 --topics-include 'orders.*' --report-interval-ms 5000 --time -1
```

Note the flag is `--broker-list`, not `--bootstrap-server`. Prints `max lag is 0 for partition ... at offset ... among N partitions` when consistent.

### 9.3 `kafka-verifiable-producer.sh` / `kafka-verifiable-consumer.sh`

Used by the system tests; they emit one JSON line per event and are the easiest way to prove "no loss / no duplicates" during a chaos test or rolling restart.

```bash
kafka-verifiable-producer.sh --bootstrap-server broker:9092 --topic chaos --max-messages 100000 --throughput 2000 --acks -1 \
  --producer.config client.properties > producer.log
kafka-verifiable-consumer.sh --bootstrap-server broker:9092 --topic chaos --group-id chaos-check --max-messages 100000 \
  --verbose --reset-policy earliest --consumer.config client.properties > consumer.log

# compare what was acked with what was consumed
jq -r 'select(.name=="producer_send_success") | "\(.partition):\(.offset)"' producer.log | sort > sent.txt
jq -r 'select(.name=="records_consumed") | .partitions[] | "\(.partition):\(.minOffset)-\(.maxOffset)"' consumer.log | head
```

---

## 10. Kafka Connect and MirrorMaker 2

### 10.1 Starting workers

```bash
# distributed worker (one per host; they form a cluster via group.id)
connect-distributed.sh /etc/kafka/connect-distributed.properties
# run in background with its own log4j2 config and heap
KAFKA_HEAP_OPTS="-Xms2g -Xmx2g" KAFKA_LOG4J_OPTS="-Dlog4j2.configurationFile=/etc/kafka/connect-log4j2.yaml" \
  connect-distributed.sh -daemon /etc/kafka/connect-distributed.properties

# standalone (single process, offsets in a local file; dev and edge use only)
connect-standalone.sh /etc/kafka/connect-standalone.properties /etc/kafka/connectors/file-source.properties /etc/kafka/connectors/file-sink.properties

# MirrorMaker 2 dedicated mode (one process runs the three MM2 connectors per flow)
connect-mirror-maker.sh /etc/kafka/mm2.properties
# only start flows that target a specific cluster (useful when the same file is deployed on both sides)
connect-mirror-maker.sh /etc/kafka/mm2.properties --clusters dr
```

Minimal `mm2.properties`:

```properties
clusters = primary, dr
primary.bootstrap.servers = primary-broker:9092
dr.bootstrap.servers = dr-broker:9092
primary->dr.enabled = true
primary->dr.topics = orders.*, payments
dr->primary.enabled = false
replication.factor = 3
checkpoints.topic.replication.factor = 3
heartbeats.topic.replication.factor = 3
offset-syncs.topic.replication.factor = 3
sync.group.offsets.enabled = true
emit.checkpoints.interval.seconds = 30
tasks.max = 8
```

### 10.2 Connect REST API cheatsheet

`CONNECT=http://connect:8083` below. Add `-u user:pass` or a bearer header when the REST layer is secured. Bodies are JSON (`-H 'Content-Type: application/json'`).

```bash
# worker info and health
curl -s $CONNECT/ | jq                                  # version, commit, kafka_cluster_id
curl -s $CONNECT/health | jq                            # 4.0, KIP-1017: 200 healthy / 503 not ready

# plugins
curl -s $CONNECT/connector-plugins | jq                 # connectors only
curl -s "$CONNECT/connector-plugins?connectorsOnly=false" | jq   # + converters, transforms, predicates (3.2)
curl -s $CONNECT/connector-plugins/io.debezium.connector.postgresql.PostgresConnector/config | jq   # config definitions (3.2)

# validate a config before creating
curl -s -X PUT $CONNECT/connector-plugins/org.apache.kafka.connect.file.FileStreamSinkConnector/config/validate \
  -H 'Content-Type: application/json' \
  -d '{"connector.class":"org.apache.kafka.connect.file.FileStreamSinkConnector","tasks.max":"1","topics":"orders","file":"/tmp/orders.out"}' \
  | jq '.error_count, .configs[] | select(.value.errors | length > 0) | {name: .value.name, errors: .value.errors}'

# create
curl -s -X POST $CONNECT/connectors -H 'Content-Type: application/json' -d '{
  "name": "orders-sink",
  "config": {
    "connector.class": "org.apache.kafka.connect.file.FileStreamSinkConnector",
    "tasks.max": "2",
    "topics": "orders",
    "file": "/tmp/orders.out",
    "key.converter": "org.apache.kafka.connect.storage.StringConverter",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "false",
    "errors.tolerance": "all",
    "errors.deadletterqueue.topic.name": "dlq.orders-sink",
    "errors.deadletterqueue.context.headers.enable": "true",
    "errors.log.enable": "true"
  }}' | jq

# create in STOPPED state to set offsets first (3.7, KIP-980)
curl -s -X POST $CONNECT/connectors -H 'Content-Type: application/json' -d '{"name":"cdc-source","config":{...},"initial_state":"STOPPED"}'

# create-or-update (idempotent; PUT the config map only)
curl -s -X PUT $CONNECT/connectors/orders-sink/config -H 'Content-Type: application/json' -d '{ "connector.class": "...", "tasks.max": "4", "topics": "orders" }'

# read
curl -s $CONNECT/connectors | jq
curl -s "$CONNECT/connectors?expand=status&expand=info" | jq          # everything in one call
curl -s $CONNECT/connectors/orders-sink | jq
curl -s $CONNECT/connectors/orders-sink/config | jq
curl -s $CONNECT/connectors/orders-sink/status | jq
curl -s $CONNECT/connectors/orders-sink/tasks | jq
curl -s $CONNECT/connectors/orders-sink/tasks/0/status | jq
curl -s $CONNECT/connectors/orders-sink/topics | jq                    # topics actively used (KIP-558)
curl -s -X PUT $CONNECT/connectors/orders-sink/topics/reset

# restart
curl -s -X POST $CONNECT/connectors/orders-sink/restart                              # connector instance only
curl -s -X POST "$CONNECT/connectors/orders-sink/restart?includeTasks=true"          # connector + all tasks (3.0, KIP-745)
curl -s -X POST "$CONNECT/connectors/orders-sink/restart?includeTasks=true&onlyFailed=true"   # only FAILED ones
curl -s -X POST $CONNECT/connectors/orders-sink/tasks/1/restart

# lifecycle
curl -s -X PUT $CONNECT/connectors/orders-sink/pause      # tasks stay allocated, stop polling
curl -s -X PUT $CONNECT/connectors/orders-sink/stop       # tasks released, offsets editable (3.5, KIP-875)
curl -s -X PUT $CONNECT/connectors/orders-sink/resume
curl -s -X DELETE $CONNECT/connectors/orders-sink

# offsets (3.5/3.6, KIP-875); connector must be STOPPED for PATCH / DELETE
curl -s $CONNECT/connectors/orders-sink/offsets | jq
# sink connector: partition = {kafka_topic, kafka_partition}, offset = {kafka_offset}
curl -s -X PATCH $CONNECT/connectors/orders-sink/offsets -H 'Content-Type: application/json' -d '{
  "offsets": [ {"partition": {"kafka_topic": "orders", "kafka_partition": 0}, "offset": {"kafka_offset": 12000}} ]}'
# source connector: partition/offset maps are connector-specific (example: JDBC incrementing column)
curl -s -X PATCH $CONNECT/connectors/jdbc-source/offsets -H 'Content-Type: application/json' -d '{
  "offsets": [ {"partition": {"protocol": "1", "table": "public.orders"}, "offset": {"incrementing": 500000}} ]}'
# reset to nothing (source re-reads from scratch, sink restarts from auto.offset.reset)
curl -s -X DELETE $CONNECT/connectors/orders-sink/offsets

# logging at runtime
curl -s $CONNECT/admin/loggers | jq
curl -s -X PUT $CONNECT/admin/loggers/io.debezium -H 'Content-Type: application/json' -d '{"level":"DEBUG"}'
curl -s -X PUT "$CONNECT/admin/loggers/io.debezium?scope=cluster" -H 'Content-Type: application/json' -d '{"level":"DEBUG"}'   # every worker (3.7, KIP-976)

# one-liner: all connectors/tasks that are not RUNNING
curl -s "$CONNECT/connectors?expand=status" | jq -r 'to_entries[] | .key as $n | .value.status | ([.connector] + .tasks)[] | select(.state != "RUNNING") | "\($n) \(.id // "connector") \(.state) \(.worker_id) \(.trace // "" | .[0:120])"'
```

### 10.3 Schema Registry REST cheatsheet (Confluent Schema Registry; Karapace and Apicurio expose the same v1 API)

`SR=http://schema-registry:8081`; content type is `application/vnd.schemaregistry.v1+json`.

```bash
# discovery
curl -s $SR/subjects | jq
curl -s $SR/schemas/types | jq                                   # AVRO, JSON, PROTOBUF
curl -s $SR/subjects/orders-value/versions | jq
curl -s $SR/subjects/orders-value/versions/latest | jq
curl -s $SR/subjects/orders-value/versions/3 | jq
curl -s $SR/subjects/orders-value/versions/latest/schema        # bare schema
curl -s $SR/schemas/ids/42 | jq                                  # by global id (what the wire format carries)
curl -s $SR/schemas/ids/42/versions | jq                         # which subjects/versions use id 42
curl -s "$SR/subjects?deleted=true" | jq                         # include soft-deleted

# register (schema is a JSON-escaped string; schemaType defaults to AVRO)
curl -s -X POST $SR/subjects/orders-value/versions -H 'Content-Type: application/vnd.schemaregistry.v1+json' \
  -d '{"schema":"{\"type\":\"record\",\"name\":\"Order\",\"fields\":[{\"name\":\"id\",\"type\":\"string\"},{\"name\":\"amount\",\"type\":\"double\",\"default\":0}]}"}'
# register from a file with jq doing the escaping
jq -n --rawfile s order.avsc '{schema: $s}' | curl -s -X POST $SR/subjects/orders-value/versions -H 'Content-Type: application/vnd.schemaregistry.v1+json' -d @-
# protobuf / json schema with references
jq -n --rawfile s order.proto '{schemaType:"PROTOBUF", schema:$s, references:[{name:"money.proto", subject:"money", version:1}]}' \
  | curl -s -X POST $SR/subjects/orders-value/versions -H 'Content-Type: application/vnd.schemaregistry.v1+json' -d @-

# is this exact schema already registered? (returns id + version)
jq -n --rawfile s order.avsc '{schema: $s}' | curl -s -X POST $SR/subjects/orders-value -H 'Content-Type: application/vnd.schemaregistry.v1+json' -d @-

# compatibility check before registering
jq -n --rawfile s order-v2.avsc '{schema: $s}' | curl -s -X POST "$SR/compatibility/subjects/orders-value/versions/latest?verbose=true" \
  -H 'Content-Type: application/vnd.schemaregistry.v1+json' -d @- | jq

# compatibility level: global and per subject (BACKWARD, BACKWARD_TRANSITIVE, FORWARD, FORWARD_TRANSITIVE, FULL, FULL_TRANSITIVE, NONE)
curl -s $SR/config | jq
curl -s -X PUT $SR/config -H 'Content-Type: application/vnd.schemaregistry.v1+json' -d '{"compatibility":"BACKWARD_TRANSITIVE"}'
curl -s "$SR/config/orders-value?defaultToGlobal=true" | jq
curl -s -X PUT $SR/config/orders-value -H 'Content-Type: application/vnd.schemaregistry.v1+json' -d '{"compatibility":"FULL"}'
curl -s -X DELETE $SR/config/orders-value                      # fall back to global

# mode (READWRITE default; IMPORT lets you register with explicit ids for migrations)
curl -s $SR/mode | jq
curl -s -X PUT $SR/mode/orders-value -H 'Content-Type: application/vnd.schemaregistry.v1+json' -d '{"mode":"READONLY"}'

# delete: soft first, then permanent
curl -s -X DELETE $SR/subjects/orders-value/versions/1
curl -s -X DELETE $SR/subjects/orders-value
curl -s -X DELETE "$SR/subjects/orders-value?permanent=true"

# with basic auth (Confluent Cloud style)
curl -s -u "$SR_KEY:$SR_SECRET" $SR/subjects
```

Subject naming: `TopicNameStrategy` (default) gives `<topic>-key` / `<topic>-value`; `RecordNameStrategy` gives the fully qualified record name; `TopicRecordNameStrategy` gives `<topic>-<record name>`. The wire format is `0x00` magic byte + 4-byte big-endian schema id + payload.

---

## 11. `kcat` (formerly kafkacat)

```bash
# metadata: brokers, topics, partitions, leaders, ISR
kcat -b broker:9092 -L
kcat -b broker:9092 -L -t orders
kcat -b broker:9092 -L -J | jq '.topics[] | {topic, partitions: (.partitions | length)}'

# produce: one record per stdin line, key:value with -K
kcat -b broker:9092 -P -t orders
echo 'order-1:{"id":"order-1","amount":12.5}' | kcat -b broker:9092 -P -t orders -K:
# with headers, explicit partition, compression
echo 'order-2:{"id":"order-2"}' | kcat -b broker:9092 -P -t orders -K: -H trace-id=abc123 -H source=cli -p 3 -z zstd
# produce a file, one record per line
kcat -b broker:9092 -P -t orders -K: -l orders.txt
# tombstone (empty value with -Z means null)
echo 'order-1:' | kcat -b broker:9092 -P -t customer-state -K: -Z

# consume with a format string, from the beginning, exit at end (-e)
kcat -b broker:9092 -C -t orders -o beginning -e \
  -f 'topic=%t part=%p off=%o ts=%T key=%k hdrs=%h\n%s\n'
# last 10 records of partition 2
kcat -b broker:9092 -C -t orders -p 2 -o -10 -e
# 100 records from offset 5000, JSON envelope output
kcat -b broker:9092 -C -t orders -p 0 -o 5000 -c 100 -J
# from a timestamp (ms since epoch) via -o s@<ts>, to timestamp e@<ts>
kcat -b broker:9092 -C -t orders -o s@1756684800000 -o e@1756688400000 -e
# consumer group mode (balanced, commits offsets)
kcat -b broker:9092 -G debug-reader orders payments
# Avro with Schema Registry
kcat -b broker:9092 -C -t orders -s value=avro -r http://schema-registry:8081 -e

# offset query: which offset corresponds to a timestamp (partition:timestamp; -1 = latest)
kcat -b broker:9092 -Q -t orders:0:1756684800000
kcat -b broker:9092 -Q -t orders:0:-1

# security: SASL_SSL / SCRAM
kcat -b broker:9093 -L \
  -X security.protocol=SASL_SSL -X sasl.mechanisms=SCRAM-SHA-512 \
  -X sasl.username=alice -X sasl.password=alice-secret \
  -X ssl.ca.location=/etc/kafka/ssl/ca.pem
# mTLS
kcat -b broker:9094 -L -X security.protocol=SSL -X ssl.ca.location=/etc/kafka/ssl/ca.pem \
  -X ssl.certificate.location=/etc/kafka/ssl/client.pem -X ssl.key.location=/etc/kafka/ssl/client-key.pem
# keep librdkafka settings in a file (same keys as -X)
kcat -F ~/.config/kcat.conf -L
```

Format string tokens: `%t` topic, `%p` partition, `%o` offset, `%k` key, `%s` value, `%K`/`%S` key/value length, `%T` timestamp, `%h` headers, `%R` 4-byte big-endian length prefix, `\n`. `kcat` uses librdkafka property names (`sasl.mechanisms`, plural), not Java client names.

---

## 12. `client.properties` templates

### 12.1 SASL_SSL with SCRAM-SHA-512

```properties
bootstrap.servers=broker-1:9093,broker-2:9093,broker-3:9093
security.protocol=SASL_SSL
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="alice" password="alice-secret";
ssl.truststore.location=/etc/kafka/ssl/truststore.p12
ssl.truststore.password=changeit
ssl.truststore.type=PKCS12
# or a PEM CA instead of a truststore (2.7+)
# ssl.truststore.type=PEM
# ssl.truststore.certificates=-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----
ssl.endpoint.identification.algorithm=https
# tools only (kafka-console-*): keep the same file for --producer.config / --consumer.config / --command-config
```

Variants: `sasl.mechanism=PLAIN` with `org.apache.kafka.common.security.plain.PlainLoginModule required username="..." password="...";`; `sasl.mechanism=OAUTHBEARER` with `sasl.login.callback.handler.class=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginCallbackHandler`, `sasl.oauthbearer.token.endpoint.url=https://idp/oauth2/token` and `sasl.jaas.config=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required clientId="svc" clientSecret="...";`; `sasl.mechanism=GSSAPI` with `sasl.kerberos.service.name=kafka` and a keytab in the JAAS config.

### 12.2 mTLS (SSL with client certificate)

```properties
bootstrap.servers=broker-1:9094,broker-2:9094,broker-3:9094
security.protocol=SSL
ssl.truststore.location=/etc/kafka/ssl/truststore.p12
ssl.truststore.password=changeit
ssl.truststore.type=PKCS12
ssl.keystore.location=/etc/kafka/ssl/alice.p12
ssl.keystore.password=changeit
ssl.keystore.type=PKCS12
# ssl.key.password only if the key password differs from the keystore password
ssl.endpoint.identification.algorithm=https
ssl.enabled.protocols=TLSv1.3,TLSv1.2
```

The principal seen by the authorizer is the certificate DN (`User:CN=alice,OU=platform,O=acme`) unless the broker sets `ssl.principal.mapping.rules`, for example `RULE:^CN=([a-zA-Z0-9.-]*).*$/$1/L,DEFAULT`.

### 12.3 Admin client for `--command-config`

The same files work for `kafka-topics.sh`, `kafka-configs.sh`, `kafka-acls.sh`, `kafka-consumer-groups.sh` and friends. Add `request.timeout.ms=60000` and `default.api.timeout.ms=120000` for large clusters where `--describe` on thousands of topics is slow.

---

## 13. Common recipes

### 13.1 Purge a topic without deleting it

```bash
# Option A: delete-records up to the high watermark on every partition (fast, precise, keeps topic + configs + ACLs)
PARTS=$(kafka-topics.sh --bootstrap-server broker:9092 --describe --topic orders | grep -c 'Partition:')
jq -n --argjson n "$PARTS" '{version:1, partitions:[range($n) | {topic:"orders", partition:., offset:-1}]}' > purge.json
kafka-delete-records.sh --bootstrap-server broker:9092 --offset-json-file purge.json

# Option B: temporarily lower retention, wait for log.retention.check.interval.ms (default 5 min), then restore
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type topics --entity-name orders --add-config retention.ms=1000
sleep 360
kafka-configs.sh --bootstrap-server broker:9092 --alter --entity-type topics --entity-name orders --delete-config retention.ms
```

Option B only deletes **closed** segments; the active segment survives until it rolls (`segment.ms` / `segment.bytes`). Option A is what to use. Neither works on a compacted topic; for those, produce tombstones or recreate the topic.

### 13.2 Find lag across all groups, sorted

```bash
kafka-consumer-groups.sh --bootstrap-server broker:9092 --describe --all-groups 2>/dev/null \
  | awk 'NR>1 && $1!="GROUP" && $6 ~ /^[0-9]+$/ {lag[$1]+=$6} END {for (g in lag) print lag[g], g}' | sort -nr | head -20
```

For a single group, the `LAG` column of `--describe --group` is the source of truth. On the broker side there is no consumer-lag metric; use `kafka_exporter`, Burrow, or the client-side `records-lag-max` metric.

### 13.3 Move all partitions off a broker (drain before decommission)

```bash
# 1. every topic
kafka-topics.sh --bootstrap-server broker:9092 --list | jq -R . | jq -s '{version:1, topics: map({topic: .})}' > all-topics.json

# 2. proposal that excludes broker 4 (list the brokers that stay)
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --generate \
  --topics-to-move-json-file all-topics.json --broker-list 1,2,3 > proposal.txt
sed -n '/Current partition replica assignment/{n;p}' proposal.txt > rollback.json
sed -n '/Proposed partition reassignment configuration/{n;p}' proposal.txt > plan.json

# 3. execute with a throttle, watch, verify (verify removes the throttle when done)
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --execute --reassignment-json-file plan.json --throttle 200000000
watch -n 30 "kafka-reassign-partitions.sh --bootstrap-server broker:9092 --verify --reassignment-json-file plan.json | grep -c 'still in progress'"
kafka-reassign-partitions.sh --bootstrap-server broker:9092 --verify --reassignment-json-file plan.json

# 4. confirm nothing is left, then stop the broker and unregister it (KRaft)
kafka-topics.sh --bootstrap-server broker:9092 --describe | grep -E 'Replicas: [^ ]*\b4\b' || echo "broker 4 holds no replicas"
kafka-cluster.sh unregister --bootstrap-server broker:9092 --id 4
```

Caveat: `--generate` reshuffles every replica of the listed topics, not only the ones on broker 4; for large clusters generate a targeted plan with a script (or Cruise Control's `remove_broker` endpoint) that only rewrites replica lists containing 4.

### 13.4 Rotate a broker TLS certificate without restart

```bash
# 1. new keystore next to the old one (same path can also be reused; the broker re-reads it when the config value changes)
keytool -importkeystore -srckeystore broker1-2026.p12 -srcstoretype PKCS12 -destkeystore /etc/kafka/ssl/broker1-2026.p12 -deststoretype PKCS12
# 2. point the listener at it (dynamic since 1.1, KIP-226; only keystore/truststore of existing listeners are dynamic)
kafka-configs.sh --bootstrap-server broker:9092 --command-config admin.properties --alter --entity-type brokers --entity-name 1 \
  --add-config 'listener.name.external.ssl.keystore.location=/etc/kafka/ssl/broker1-2026.p12,listener.name.external.ssl.keystore.password=changeit,listener.name.external.ssl.key.password=changeit'
# 3. check
openssl s_client -connect broker-1:9093 -servername broker-1 </dev/null 2>/dev/null | openssl x509 -noout -enddate -subject
```

Rules: the new certificate must have the same DN/SANs as the old one (the broker verifies this to protect inter-broker auth); the CA must already be in every truststore before rotating leaf certs; rotate one broker at a time and keep the old file until the last consumer has reconnected. For the truststore use `listener.name.<name>.ssl.truststore.location`. Password-less reloading of the **same** path works only when the location string changes, so alternate two file names (`-a.p12` / `-b.p12`).

### 13.5 Check quorum and controller health

```bash
kafka-metadata-quorum.sh --bootstrap-server broker:9092 describe --status | grep -E 'LeaderId|HighWatermark|MaxFollowerLag'
kafka-metadata-quorum.sh --bootstrap-server broker:9092 describe --replication --human-readable
kafka-features.sh --bootstrap-server broker:9092 describe | grep -E 'metadata.version|kraft.version'
# brokers registered, fenced and their epochs
kafka-metadata.sh --directory /var/lib/kafka/__cluster_metadata-0 ls /image/brokers 2>/dev/null
# JMX: kafka.controller:type=KafkaController,name=ActiveControllerCount must sum to 1 across controllers
```

Red flags: `LeaderId: -1`, `MaxFollowerLagTimeMs` in the tens of seconds, an observer (broker) whose `LastCaughtUpTimestamp` is old, `kafka.server:type=broker-metadata-metrics,name=last-applied-record-lag-ms` growing on a broker.

### 13.6 List topics with no consumer group

```bash
kafka-topics.sh --bootstrap-server broker:9092 --list --exclude-internal | sort > all.txt
kafka-consumer-groups.sh --bootstrap-server broker:9092 --describe --all-groups 2>/dev/null \
  | awk 'NR>1 && $2!="TOPIC" && $2!="" {print $2}' | sort -u > consumed.txt
comm -23 all.txt consumed.txt
```

This only detects group-based consumers with committed offsets. Consumers using `assign()` without commits, Streams global stores, MirrorMaker without checkpoint sync and Connect sinks that commit under `connect-<name>` groups are included only if they commit. Cross-check with `BytesOutPerSec` per topic (`kafka.server:type=BrokerTopicMetrics,name=BytesOutPerSec,topic=<t>`) over a week before deleting anything.

### 13.7 Other one-liners

```bash
# which broker is the leader for most partitions (leader skew)
kafka-topics.sh --bootstrap-server broker:9092 --describe | grep -o 'Leader: [0-9]*' | sort | uniq -c | sort -nr

# total partition count per broker
kafka-topics.sh --bootstrap-server broker:9092 --describe | grep -o 'Replicas: [0-9,]*' | tr ',' '\n' | grep -o '[0-9]*$' | sort | uniq -c

# under-replicated partitions in a loop during a rolling restart
watch -n 10 "kafka-topics.sh --bootstrap-server broker:9092 --describe --under-replicated-partitions | wc -l"

# count records in a topic (sum of latest minus earliest offsets; ignores compaction holes)
paste <(kafka-get-offsets.sh --bootstrap-server broker:9092 --topic orders --time earliest | cut -d: -f3) \
      <(kafka-get-offsets.sh --bootstrap-server broker:9092 --topic orders --time latest | cut -d: -f3) \
  | awk '{s+=$2-$1} END {print s}'

# rolling-restart readiness: broker state 3 = RUNNING via JMX (jmxterm or jcmd)
jcmd $(pgrep -f kafka.Kafka) ManagementAgent.status >/dev/null && echo "JMX up"

# who is connected (needs kafka.request.logger or the socket-server metrics); quick approximation:
ss -tn state established '( sport = :9092 )' | awk 'NR>1 {split($4,a,":"); print a[1]}' | sort | uniq -c | sort -nr | head
```

---

## Key takeaways
- Every tool speaks to brokers with `--bootstrap-server`; `--command-config` carries authentication. `--zookeeper` is gone in 4.0.
- Topic configs are changed with `kafka-configs.sh`, partitions with `kafka-topics.sh --alter`, placement with `kafka-reassign-partitions.sh`, leadership with `kafka-leader-election.sh`.
- Offsets are reset only on inactive groups, always after a `--dry-run`.
- KRaft clusters are born with `kafka-storage.sh format` and grow with `kafka-features.sh upgrade` and (since 3.9) `kafka-metadata-quorum.sh add-controller`.
- `kafka-dump-log.sh` and `kafka-metadata.sh` are the offline debuggers: one for data segments, one for the metadata log.
- Connect and Schema Registry are operated through REST; `kcat` is the fastest ad-hoc client.

## Further reading
- Apache Kafka documentation: "Operations" and "Basic Kafka Operations" (bin scripts), "KRaft" section.
- KIP-455 (replica reassignment API), KIP-226 (dynamic broker configs), KIP-500/631/853 (KRaft and dynamic quorum), KIP-875 (Connect offsets), KIP-798 (console producer headers), KIP-848 (new consumer group protocol), KIP-932 (share groups).
- Confluent Schema Registry API reference; librdkafka `CONFIGURATION.md` for `kcat -X` keys.
