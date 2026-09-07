# Kafka Security: Encryption, Authentication, Authorization and Audit

**Roles:** [ARCH] [ADMIN] [DEV]   **Level:** Advanced
**Prerequisites:** `01-fundamentals` (brokers, listeners, KRaft roles), `03-admin/01-cluster-setup`, `03-admin/02-configuration`

## What you will learn
- The threat model for a Kafka cluster and the four security pillars that address it
- How listeners, security protocols and `listener.security.protocol.map` fit together in a KRaft cluster
- End-to-end TLS: CA, keystores, truststores, PEM, mTLS, hostname verification, rotation without downtime
- SASL mechanisms (PLAIN, SCRAM, GSSAPI, OAUTHBEARER) and the KRaft-specific SCRAM bootstrap
- ACL design with `StandardAuthorizer`, `kafka-acls.sh`, prefixed resources and least privilege
- Secrets management, encryption at rest, network isolation, audit logging and a hardening checklist

## 1. Concept

### 1.1 Threat model

A Kafka cluster is a shared, long-lived, high-value data store that many teams write to and read from. The threats an architect has to reason about are:

| Threat | Example | Pillar that addresses it |
|--------|---------|--------------------------|
| Eavesdropping on the wire | Packet capture on a shared VLAN, cloud cross-AZ links | Encryption in transit (TLS) |
| Impersonation of a client | Any process on the network claims to be `payments-service` | Authentication (SASL or mTLS) |
| Impersonation of a broker | Rogue host advertises itself as `broker-2` and receives producer traffic | Server authentication (TLS with hostname verification) |
| Over-privileged clients | A reporting job that can also delete topics | Authorization (ACLs) |
| Lateral movement | A compromised app reads every topic in the cluster | Authorization + network segmentation |
| Data theft from disk | Stolen volume, snapshot copied to another account | Encryption at rest |
| Secrets leakage | Passwords in `server.properties` checked into git | Secrets management (config providers) |
| Undetected misuse | Nobody knows who read `customer-pii` last month | Audit logging |
| Control-plane compromise | Client reaches the controller listener and forges metadata | Listener isolation, mTLS on controllers |

### 1.2 The four pillars

```mermaid
flowchart LR
    subgraph P1["1. Encryption in transit"]
        TLS["TLS 1.2 / 1.3 on every listener"]
    end
    subgraph P2["2. Authentication"]
        SASL["SASL: PLAIN, SCRAM, GSSAPI, OAUTHBEARER"]
        MTLS["mTLS: ssl.client.auth=required"]
    end
    subgraph P3["3. Authorization"]
        ACL["StandardAuthorizer + ACLs"]
        RBAC["Confluent RBAC (commercial)"]
    end
    subgraph P4["4. Audit"]
        AUD["authorizer logger, request logger, audit events"]
    end
    Client["Client"] -->|"1. secure channel"| TLS
    TLS -->|"2. who are you?"| SASL
    TLS --> MTLS
    SASL -->|"3. principal"| ACL
    MTLS --> ACL
    ACL -->|"4. allow / deny recorded"| AUD
```

The pillars are ordered: there is no point in authorizing a principal you have not authenticated, and there is no point authenticating over a channel that leaks the credential. In practice you build them in that order too.

### 1.3 Security protocols and listeners

A **listener** is a named socket a broker (or controller) binds. Each listener has exactly one **security protocol**:

| Security protocol | Encryption | Authentication | When to use |
|-------------------|------------|----------------|-------------|
| `PLAINTEXT` | none | none (principal is `User:ANONYMOUS`) | local development only |
| `SSL` | TLS | optional mTLS (`ssl.client.auth`) | inter-broker, controller, machine-to-machine |
| `SASL_PLAINTEXT` | none | SASL | never in production (credentials in clear unless GSSAPI/SCRAM); lab environments |
| `SASL_SSL` | TLS | SASL (plus optional mTLS) | the default for clients in production |

> **Anti-pattern:** a single `PLAINTEXT` listener on `0.0.0.0:9092` shared by clients, replication and controllers. It gives every process on the network full anonymous access, and it makes later hardening a big-bang change because every client must move at once.

## 2. How it works internally

### 2.1 Connection establishment: TLS then SASL

Every client connection to a `SASL_SSL` listener passes through two handshakes before the first Kafka request is accepted.

```mermaid
sequenceDiagram
    participant C as Client
    participant B as Broker (SASL_SSL listener)
    participant A as Authorizer

    Note over C,B: Phase 1 - TLS handshake
    C->>B: ClientHello (SNI=broker-1.kafka.internal, TLS 1.3)
    B->>C: ServerHello + broker certificate chain
    C->>C: Verify chain against truststore, check SAN matches host (ssl.endpoint.identification.algorithm=https)
    alt ssl.client.auth=required
        B->>C: CertificateRequest
        C->>B: Client certificate
        B->>B: Verify against broker truststore, extract DN, apply ssl.principal.mapping.rules
    end
    C->>B: Finished (encrypted channel established)

    Note over C,B: Phase 2 - SASL authentication
    C->>B: SaslHandshakeRequest (mechanism=SCRAM-SHA-512)
    B->>C: SaslHandshakeResponse (enabled mechanisms)
    C->>B: SaslAuthenticateRequest (client-first message)
    B->>C: SaslAuthenticateResponse (server-first, salt, iterations)
    C->>B: SaslAuthenticateRequest (client-final, proof)
    B->>B: Look up credential in metadata log, verify proof
    B->>C: SaslAuthenticateResponse (server-final, session lifetime)

    Note over C,A: Phase 3 - every request is authorized
    C->>B: ProduceRequest (topic=orders)
    B->>A: authorize(User:payments, WRITE, TOPIC orders)
    A->>B: ALLOWED
    B->>C: ProduceResponse
```

Key points:
- TLS establishes the channel and (optionally) authenticates both ends via certificates. The principal from mTLS is the certificate DN, mapped through `ssl.principal.mapping.rules`.
- On a `SASL_SSL` listener the SASL principal **overrides** the TLS principal. mTLS then only proves the client holds a trusted certificate; identity comes from SASL.
- The broker re-authenticates long-lived connections if `connections.max.reauth.ms` is set (KIP-368, since 2.2). Without it, a revoked SCRAM password does not disconnect an already connected client.
- Authorization happens on every request, with the result cached per session by the authorizer.

### 2.2 ACL evaluation in `StandardAuthorizer`

`StandardAuthorizer` (`org.apache.kafka.metadata.authorizer.StandardAuthorizer`) is the KRaft authorizer. ACLs live in the metadata log, so every broker and controller has the full ACL set in memory and evaluation never involves a remote call.

```mermaid
flowchart TD
    R["Request: principal P, operation OP, resource R, host H"] --> SU{"P in super.users?"}
    SU -->|yes| ALLOW["ALLOW"]
    SU -->|no| M["Collect ACLs matching R: LITERAL exact, LITERAL wildcard '*', PREFIXED where R starts with prefix"]
    M --> ANYDENY{"Any DENY ACL matches P (or User:*), OP (or ALL), H (or *)?"}
    ANYDENY -->|yes| DENY["DENY"]
    ANYDENY -->|no| ANYALLOW{"Any ALLOW ACL matches P, OP or implied OP, H?"}
    ANYALLOW -->|yes| ALLOW
    ANYALLOW -->|no| NONE{"Any ACL at all for R?"}
    NONE -->|yes| DENY
    NONE -->|no| DEF{"allow.everyone.if.no.acl.found?"}
    DEF -->|true| ALLOW
    DEF -->|false| DENY
```

Rules worth memorising:
- **DENY always wins** over ALLOW for the same request.
- Some operations imply others: `READ`, `WRITE`, `DELETE`, `ALTER` all imply `DESCRIBE`; `ALTER_CONFIGS` implies `DESCRIBE_CONFIGS`.
- `allow.everyone.if.no.acl.found` applies only when the resource has **no** ACL at all. As soon as one ACL exists for a topic, everyone else is denied.
- Super users bypass everything, including DENY ACLs. Broker principals must be super users in KRaft or brokers cannot fetch replicas and register.

## 3. Configuration that matters

### 3.1 Multi-listener KRaft example (internal, external, controller)

A combined-mode or broker-only node in a production cluster:

```properties
# server.properties for a broker (node.id=1)
process.roles=broker
node.id=1
controller.quorum.bootstrap.servers=controller-1.kafka.internal:9094,controller-2.kafka.internal:9094,controller-3.kafka.internal:9094

# Three listeners: replication, clients, controller channel
listeners=INTERNAL://0.0.0.0:9092,EXTERNAL://0.0.0.0:9093
advertised.listeners=INTERNAL://broker-1.kafka.internal:9092,EXTERNAL://kafka-1.example.com:9093
listener.security.protocol.map=INTERNAL:SASL_SSL,EXTERNAL:SASL_SSL,CONTROLLER:SSL
inter.broker.listener.name=INTERNAL
controller.listener.names=CONTROLLER

# TLS shared by all listeners unless overridden per listener
ssl.keystore.location=/etc/kafka/tls/broker-1.keystore.p12
ssl.keystore.type=PKCS12
ssl.keystore.password=${file:/etc/kafka/secrets/tls.properties:keystore.password}
ssl.key.password=${file:/etc/kafka/secrets/tls.properties:key.password}
ssl.truststore.location=/etc/kafka/tls/truststore.p12
ssl.truststore.type=PKCS12
ssl.truststore.password=${file:/etc/kafka/secrets/tls.properties:truststore.password}
ssl.enabled.protocols=TLSv1.3,TLSv1.2
ssl.endpoint.identification.algorithm=https

# mTLS on the controller channel (broker acts as TLS client to the controllers)
listener.name.controller.ssl.client.auth=required

# SASL per listener
sasl.enabled.mechanisms=SCRAM-SHA-512,OAUTHBEARER
sasl.mechanism.inter.broker.protocol=SCRAM-SHA-512
listener.name.internal.sasl.enabled.mechanisms=SCRAM-SHA-512
listener.name.internal.scram-sha-512.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \
  username="broker" password="${file:/etc/kafka/secrets/sasl.properties:broker.password}";
listener.name.external.sasl.enabled.mechanisms=OAUTHBEARER
listener.name.external.oauthbearer.sasl.server.callback.handler.class=org.apache.kafka.common.security.oauthbearer.OAuthBearerValidatorCallbackHandler
listener.name.external.oauthbearer.sasl.jaas.config=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required;
sasl.oauthbearer.jwks.endpoint.url=https://idp.example.com/.well-known/jwks.json
sasl.oauthbearer.expected.audience=kafka
sasl.oauthbearer.sub.claim.name=sub

# Authorization
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer
super.users=User:broker;User:CN=controller-1.kafka.internal;User:CN=controller-2.kafka.internal;User:CN=controller-3.kafka.internal;User:CN=broker-1.kafka.internal
allow.everyone.if.no.acl.found=false

# Secrets come from files, not from this file
config.providers=file
config.providers.file.class=org.apache.kafka.common.config.provider.FileConfigProvider
```

The controller nodes carry only the `CONTROLLER` listener:

```properties
process.roles=controller
node.id=101
listeners=CONTROLLER://0.0.0.0:9094
controller.listener.names=CONTROLLER
listener.security.protocol.map=CONTROLLER:SSL
controller.quorum.bootstrap.servers=controller-1.kafka.internal:9094,controller-2.kafka.internal:9094,controller-3.kafka.internal:9094
ssl.client.auth=required
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer
super.users=User:CN=controller-1.kafka.internal;User:CN=controller-2.kafka.internal;User:CN=controller-3.kafka.internal;User:CN=broker-1.kafka.internal;User:CN=broker-2.kafka.internal;User:CN=broker-3.kafka.internal
```

```plantuml
@startuml
skinparam shadowing false
skinparam defaultFontName Helvetica
title Kafka multi-listener topology (KRaft, 3 brokers + 3 controllers)

cloud "Internet / partner networks" as inet
node "DMZ / edge" as dmz {
  component "Kafka gateway or\nTCP load balancer\n(SNI passthrough)" as gw
}

package "Private subnet: kafka-brokers" as brokers {
  node "broker-1" as b1 {
    interface "INTERNAL :9092\nSASL_SSL (SCRAM)" as b1i
    interface "EXTERNAL :9093\nSASL_SSL (OAUTHBEARER)" as b1e
    interface "CONTROLLER-client\nSSL (mTLS)" as b1c
  }
  node "broker-2" as b2
  node "broker-3" as b3
}

package "Private subnet: kafka-controllers" as ctrls {
  node "controller-1" as c1 {
    interface "CONTROLLER :9094\nSSL (mTLS)" as c1l
  }
  node "controller-2" as c2
  node "controller-3" as c3
}

package "Private subnet: apps" as apps {
  component "Producers / consumers\n(SCRAM users)" as app
  component "Kafka Connect\n(mTLS + SCRAM)" as connect
  component "Schema Registry\n(HTTPS + basic auth)" as sr
}

inet --> gw : TLS 1.3
gw --> b1e : SASL_SSL
gw --> b2 : SASL_SSL
gw --> b3 : SASL_SSL
app --> b1i : SASL_SSL
connect --> b1i : SASL_SSL
sr --> b1i : SASL_SSL
b1c --> c1l : SSL (mTLS)\nbroker heartbeats + metadata fetch
b2 --> c2 : SSL (mTLS)
b3 --> c3 : SSL (mTLS)
b1i <--> b2 : replication\n(inter.broker.listener.name=INTERNAL)
b2 <--> b3 : replication
c1l <--> c2 : Raft (SSL)
c2 <--> c3 : Raft (SSL)

note bottom of ctrls
  Controllers expose only the CONTROLLER listener.
  No client, producer or consumer ever connects here.
  SCRAM is not usable on this listener; use mTLS.
end note
note bottom of dmz
  No broker has a public IP.
  advertised.listeners for EXTERNAL points at the gateway DNS names.
end note
@enduml
```

Source: `diagrams/06-security-multi-listener-topology.puml`.

> **Production tip:** the controller listener cannot use SCRAM. SCRAM credentials are stored in the metadata log that the controllers serve, so a controller cannot authenticate a peer with SCRAM before the quorum is up. Use mTLS (`SSL` with `ssl.client.auth=required`), PLAIN with file-based passwords, or GSSAPI on `CONTROLLER`.

### 3.2 TLS end to end

**Step 1: create a private CA** (or use your corporate PKI / cert-manager / Vault PKI).

```bash
openssl req -new -x509 -keyout ca.key -out ca.crt -days 3650 -subj "/CN=Kafka Internal CA/O=Example" -nodes
```

**Step 2: per-broker keystore with SAN entries** (one keystore per host, never shared).

```bash
HOST=broker-1.kafka.internal
keytool -genkeypair -alias $HOST -keyalg RSA -keysize 3072 -validity 365 \
  -keystore $HOST.keystore.p12 -storetype PKCS12 -storepass changeit \
  -dname "CN=$HOST,OU=Kafka,O=Example" \
  -ext "SAN=DNS:$HOST,DNS:kafka-1.example.com,IP:10.0.1.11"

keytool -certreq -alias $HOST -keystore $HOST.keystore.p12 -storepass changeit -file $HOST.csr \
  -ext "SAN=DNS:$HOST,DNS:kafka-1.example.com,IP:10.0.1.11"

openssl x509 -req -CA ca.crt -CAkey ca.key -in $HOST.csr -out $HOST.crt -days 365 -CAcreateserial \
  -extfile <(printf "subjectAltName=DNS:$HOST,DNS:kafka-1.example.com,IP:10.0.1.11\nextendedKeyUsage=serverAuth,clientAuth")

keytool -importcert -alias CARoot -file ca.crt -keystore $HOST.keystore.p12 -storepass changeit -noprompt
keytool -importcert -alias $HOST -file $HOST.crt -keystore $HOST.keystore.p12 -storepass changeit -noprompt
```

The `extendedKeyUsage=serverAuth,clientAuth` matters: the broker is a TLS **server** for clients and a TLS **client** toward other brokers and controllers.

**Step 3: truststore** shared by everyone that must trust the CA.

```bash
keytool -importcert -alias CARoot -file ca.crt -keystore truststore.p12 -storetype PKCS12 -storepass changeit -noprompt
keytool -list -v -keystore truststore.p12 -storepass changeit
```

**PEM instead of keystores (since 2.7, KIP-651).** Useful with cert-manager and Vault, which produce PEM natively:

```properties
ssl.keystore.type=PEM
ssl.keystore.location=/etc/kafka/tls/broker-1.pem      # cert chain + PKCS#8 private key in one file
ssl.truststore.type=PEM
ssl.truststore.location=/etc/kafka/tls/ca.pem
# or inline (handy for dynamic config)
# ssl.keystore.certificate.chain=-----BEGIN CERTIFICATE----- ...
# ssl.keystore.key=-----BEGIN PRIVATE KEY----- ...
# ssl.truststore.certificates=-----BEGIN CERTIFICATE----- ...
```

Encrypted PEM keys require `ssl.key.password`; unencrypted PKCS#8 works without it.

**Client-side TLS configuration:**

```properties
security.protocol=SSL
ssl.truststore.location=/etc/kafka/tls/truststore.p12
ssl.truststore.password=changeit
ssl.endpoint.identification.algorithm=https
# for mTLS
ssl.keystore.location=/etc/kafka/tls/payments-service.keystore.p12
ssl.keystore.password=changeit
```

**Hostname verification.** `ssl.endpoint.identification.algorithm=https` (default since 2.0) makes the client check that the broker certificate's SAN matches the host it connected to, which is the host from `advertised.listeners`. Setting it to an empty string disables verification and turns TLS into encryption without server authentication: a rogue broker with any certificate from any CA in your truststore can then intercept traffic.

> **Anti-pattern:** "fixing" `No subject alternative names matching IP address 10.0.1.11 found` by setting `ssl.endpoint.identification.algorithm=`. Fix the SAN or the advertised hostname instead.

**Certificate rotation without downtime.** Keystore locations and passwords are per-broker dynamic configs (since 1.1, KIP-226):

```bash
# 1. Place the new keystore on the broker (same CA, or a CA already in the truststore)
# 2. Tell the broker to reload; the value may be identical to trigger a reload of the file in place
kafka-configs.sh --bootstrap-server broker-1.kafka.internal:9092 --command-config admin.properties \
  --entity-type brokers --entity-name 1 --alter \
  --add-config 'listener.name.external.ssl.keystore.location=/etc/kafka/tls/broker-1.keystore.p12,listener.name.external.ssl.keystore.password=changeit,listener.name.external.ssl.key.password=changeit'
```

Constraints the broker enforces: the new keystore must be trusted by the currently configured truststore (so you must rotate the CA first by adding the new CA to every truststore, then rotate leaf certs), and the DN and SANs of the inter-broker listener certificate must stay compatible with `ssl.principal.mapping.rules` and `super.users`. Existing connections keep their old session; new connections use the new certificate.

Rotation order for a CA change:
1. Add new CA to all truststores (brokers, controllers, clients). Reload truststores dynamically.
2. Issue new leaf certificates from the new CA, reload keystores broker by broker.
3. Remove the old CA from truststores once no certificate signed by it remains.

### 3.3 SASL mechanisms compared

| Mechanism | Credential | Where the broker verifies it | Strengths | Weaknesses | Typical use |
|-----------|-----------|------------------------------|-----------|------------|-------------|
| `PLAIN` | username + password | JAAS file on the broker (static) or custom `AuthenticateCallbackHandler` | simplest; works on the controller listener | password sent in clear inside TLS; broker restart to change users unless custom handler | small clusters, controller listener, bridging to LDAP with a custom handler |
| `SCRAM-SHA-256` / `SCRAM-SHA-512` | username + password | salted hash stored in the KRaft metadata log | no plaintext at rest, users added at runtime with `kafka-configs.sh`, no external system | still a shared secret; no rotation without client redeploy; not usable on the controller listener | default for internal services |
| `GSSAPI` (Kerberos) | keytab / ticket | KDC | integrates with AD, mutual auth, strong | operational complexity, clock skew sensitivity, KDC as dependency | enterprises with existing Kerberos |
| `OAUTHBEARER` | JWT from an OIDC provider | JWKS from the IdP (since 3.1, KIP-768) | short-lived tokens, central identity, no secrets in Kafka, works for external clients | needs an IdP, token expiry handling, offline validation only via JWKS | external clients, cloud, zero-trust |

Since 3.1 the built-in `OAuthBearerLoginCallbackHandler` and `OAuthBearerValidatorCallbackHandler` implement the client-credentials flow and JWT validation; before 3.1 OAUTHBEARER shipped only an unsecured demo implementation.

**Broker JAAS for SCRAM inter-broker traffic** (shown above) and **for PLAIN as a fallback on the controller listener**:

```properties
listener.name.controller.sasl.enabled.mechanisms=PLAIN
listener.name.controller.plain.sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required \
  username="controller" password="${file:/etc/kafka/secrets/sasl.properties:controller.password}" \
  user_controller="${file:/etc/kafka/secrets/sasl.properties:controller.password}" \
  user_broker="${file:/etc/kafka/secrets/sasl.properties:broker.password}";
sasl.mechanism.controller.protocol=PLAIN
```

**Client JAAS examples:**

```properties
# SCRAM
security.protocol=SASL_SSL
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="payments" password="s3cr3t";
ssl.truststore.location=/etc/kafka/tls/truststore.p12
ssl.truststore.password=changeit

# Kerberos
security.protocol=SASL_SSL
sasl.mechanism=GSSAPI
sasl.kerberos.service.name=kafka
sasl.jaas.config=com.sun.security.auth.module.Krb5LoginModule required useKeyTab=true storeKey=true \
  keyTab="/etc/security/keytabs/payments.keytab" principal="payments@EXAMPLE.COM";

# OAUTHBEARER / OIDC client credentials (since 3.1)
security.protocol=SASL_SSL
sasl.mechanism=OAUTHBEARER
sasl.login.callback.handler.class=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginCallbackHandler
sasl.oauthbearer.token.endpoint.url=https://idp.example.com/oauth2/token
sasl.jaas.config=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required \
  clientId="payments-service" clientSecret="..." scope="kafka";
```

**Managing SCRAM users at runtime:**

```bash
kafka-configs.sh --bootstrap-server broker-1.kafka.internal:9092 --command-config admin.properties \
  --alter --add-config 'SCRAM-SHA-512=[iterations=8192,password=s3cr3t]' \
  --entity-type users --entity-name payments

kafka-configs.sh --bootstrap-server broker-1.kafka.internal:9092 --command-config admin.properties \
  --describe --entity-type users --entity-name payments

kafka-configs.sh --bootstrap-server broker-1.kafka.internal:9092 --command-config admin.properties \
  --alter --delete-config 'SCRAM-SHA-512' --entity-type users --entity-name payments
```

**KRaft-specific: bootstrapping SCRAM at format time.** The chicken-and-egg problem: `kafka-configs.sh` needs an authenticated connection, but with `sasl.mechanism.inter.broker.protocol=SCRAM-SHA-512` no broker can start until the broker credential exists. Since 3.5 (KIP-900) `kafka-storage.sh format` writes SCRAM records into the bootstrap metadata:

```bash
CLUSTER_ID=$(kafka-storage.sh random-uuid)
kafka-storage.sh format --cluster-id $CLUSTER_ID --config /etc/kafka/server.properties \
  --add-scram 'SCRAM-SHA-512=[name=broker,password=broker-secret]' \
  --add-scram 'SCRAM-SHA-512=[name=admin,password=admin-secret]'
```

Run the same command with the same cluster id on every controller and broker before first start.

**Delegation tokens** (KRaft support since 3.6) let a long-running framework (Spark, Flink) distribute short-lived credentials to workers without shipping keytabs or passwords:

```properties
# broker
delegation.token.secret.key=${file:/etc/kafka/secrets/sasl.properties:token.secret}
delegation.token.max.lifetime.ms=604800000
delegation.token.expiry.time.ms=86400000
```

```bash
kafka-delegation-tokens.sh --bootstrap-server broker-1.kafka.internal:9092 --command-config admin.properties \
  --create --max-life-time-period -1 --renewer-principal User:spark
# client then authenticates with SCRAM using tokenauth
# sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required tokenauth="true" username="<tokenId>" password="<hmac>";
```

### 3.4 Authorization with ACLs

Broker settings:

| Parameter | Default | Recommended | Why |
|-----------|---------|-------------|-----|
| `authorizer.class.name` | empty (no authorization) | `org.apache.kafka.metadata.authorizer.StandardAuthorizer` | the only supported authorizer in KRaft; `kafka.security.authorizer.AclAuthorizer` is ZooKeeper-only and removed in 4.0 |
| `allow.everyone.if.no.acl.found` | `false` | `false` | `true` silently grants access to every new topic |
| `super.users` | empty | broker and controller principals plus a break-glass admin | brokers need unrestricted access for replication and metadata; keep humans out |
| `ssl.principal.mapping.rules` | `DEFAULT` (full DN) | `RULE:^CN=([^,]+).*$/$1/,DEFAULT` | turn `CN=broker-1,OU=Kafka,O=Example` into `broker-1` |
| `sasl.kerberos.principal.to.local.rules` | `DEFAULT` | strip realm | `payments@EXAMPLE.COM` becomes `payments` |
| `connections.max.reauth.ms` | `0` (off) | `3600000` for OAUTHBEARER | forces re-authentication so expired tokens and revoked users lose access |

`kafka-acls.sh` recipes (all through the Admin API; the `--authorizer-properties zookeeper.connect=...` form is gone in 4.0):

```bash
ADMIN="--bootstrap-server broker-1.kafka.internal:9092 --command-config admin.properties"

# Producer to one topic (grants WRITE, DESCRIBE, CREATE on the topic)
kafka-acls.sh $ADMIN --add --allow-principal User:payments --producer --topic orders

# Idempotent producer additionally needs IDEMPOTENT_WRITE on the cluster (implied by WRITE on topic since 2.8, KIP-679)
# Transactional producer needs the transactional id
kafka-acls.sh $ADMIN --add --allow-principal User:payments --producer --topic orders --transactional-id payments-tx

# Consumer with group (grants READ, DESCRIBE on topic; READ on group)
kafka-acls.sh $ADMIN --add --allow-principal User:billing --consumer --topic orders --group billing-app

# Prefixed: a team owns every topic and group starting with "billing."
kafka-acls.sh $ADMIN --add --allow-principal User:billing --operation Read --operation Write --operation Describe \
  --topic billing. --resource-pattern-type prefixed
kafka-acls.sh $ADMIN --add --allow-principal User:billing --operation Read --group billing. --resource-pattern-type prefixed

# Restrict by host
kafka-acls.sh $ADMIN --add --allow-principal User:etl --allow-host 10.0.5.20 --operation Read --topic orders

# Deny overrides allow: block one user from a PII topic even though the team has a prefixed allow
kafka-acls.sh $ADMIN --add --deny-principal User:intern --operation All --topic billing.customer-pii

# Cluster-level: who may create topics / alter configs
kafka-acls.sh $ADMIN --add --allow-principal User:platform-automation --operation Create --operation AlterConfigs --operation DescribeConfigs --cluster

# List, and list by principal
kafka-acls.sh $ADMIN --list --topic orders
kafka-acls.sh $ADMIN --list --principal User:billing

# Remove
kafka-acls.sh $ADMIN --remove --allow-principal User:etl --operation Read --topic orders --force
```

Operation matrix that a client needs, by role:

| Role | Resource | Operations |
|------|----------|------------|
| Producer | `TOPIC` | `WRITE`, `DESCRIBE` (`CREATE` only if auto-creation is desired) |
| Idempotent producer | `CLUSTER` | `IDEMPOTENT_WRITE` (implied by topic `WRITE` since 2.8) |
| Transactional producer | `TRANSACTIONAL_ID` | `WRITE`, `DESCRIBE` |
| Consumer | `TOPIC` + `GROUP` | `READ`, `DESCRIBE` on topic; `READ` on group |
| Kafka Streams app | `TOPIC` (prefixed `<app.id>-`), `GROUP <app.id>`, `TRANSACTIONAL_ID` (prefixed `<app.id>-`) | `CREATE`, `READ`, `WRITE`, `DESCRIBE`, `DELETE` on internal topics |
| Connect worker | internal topics `connect-*`, `GROUP connect-cluster` | `READ`, `WRITE`, `CREATE`, `DESCRIBE` |
| Admin tooling | `CLUSTER` | `ALTER`, `DESCRIBE`, `CLUSTER_ACTION`, `ALTER_CONFIGS` |

### 3.5 OSS ACLs vs Confluent RBAC

| Aspect | Apache Kafka ACLs | Confluent RBAC (Confluent Platform / Cloud) |
|--------|-------------------|---------------------------------------------|
| Model | per principal, per resource, per operation | roles (`DeveloperRead`, `DeveloperWrite`, `ResourceOwner`, `ClusterAdmin`, ...) bound to principals on resources |
| Scope | Kafka cluster only | Kafka, Schema Registry, Connect, ksqlDB, Control Center |
| Delegation | only super users can grant | `ResourceOwner` can grant within the owned prefix |
| Identity source | SASL/mTLS principal | Metadata Service (MDS) integrated with LDAP / OIDC |
| Groups | not supported (per user only) | LDAP group principals |
| Cost | free | commercial |

RBAC removes the "who is allowed to run `kafka-acls.sh`" problem. In OSS you solve it with GitOps: ACLs are declared in a repository and applied by a pipeline (Strimzi `KafkaUser` CRDs, Julie Ops, Terraform `kafka_acl`, or a script wrapping `kafka-acls.sh`).

### 3.6 Encryption at rest and secrets

| Layer | Mechanism | Protects against | Does not protect against |
|-------|-----------|------------------|--------------------------|
| Volume encryption (LUKS, EBS/PD encryption with KMS keys) | transparent block encryption | stolen disks, copied snapshots | anyone with broker OS access or valid ACLs |
| Client-side field-level encryption | producer encrypts specific fields with a key from KMS; consumer decrypts | broker operators, backups, MM2 copies, all of Kafka | key management complexity, no server-side filtering |
| Confluent CSFLE (Client-Side Field Level Encryption, Confluent-specific) | Schema Registry tags fields and rules, serializer encrypts with envelope keys from KMS (AWS KMS, Azure Key Vault, GCP KMS, Vault) | as above, with central policy | non-Confluent serializers |
| Envelope encryption of whole payloads | custom serializer / interceptor | as above | loses compaction-key visibility if key is encrypted |

**Secrets management** with config providers (KIP-297, brokers as well since KIP-421):

```properties
config.providers=file,dir,env
config.providers.file.class=org.apache.kafka.common.config.provider.FileConfigProvider
config.providers.dir.class=org.apache.kafka.common.config.provider.DirectoryConfigProvider
config.providers.env.class=org.apache.kafka.common.config.provider.EnvVarConfigProvider

ssl.keystore.password=${file:/etc/kafka/secrets/tls.properties:keystore.password}
# Kubernetes secret mounted as a directory: one file per key
ssl.key.password=${dir:/mnt/secrets/kafka-tls:key.password}
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="${env:KAFKA_USER}" password="${env:KAFKA_PASSWORD}";
```

`DirectoryConfigProvider` arrived in 2.7, `EnvVarConfigProvider` in 3.5. For Vault, use a Vault Agent sidecar that renders files into a tmpfs (then `FileConfigProvider`), or a community Vault config provider. Connect worker configs and connector configs use exactly the same syntax, so connector credentials never appear in the Connect REST API in clear text.

> **Production tip:** in Kubernetes, mount secrets as files and reference them with `DirectoryConfigProvider`. Environment variables show up in `kubectl describe pod` and in crash dumps; files in a tmpfs do not.

### 3.7 Network security

- Brokers and controllers live in private subnets with no public IPs. Security groups allow 9092 from the app subnets, 9093 from the gateway, 9094 only from the broker and controller subnets.
- External access goes through a TLS-terminating or SNI-passthrough gateway (NLB with one target group per broker, Envoy, Strimzi ingress/route listeners, or a Kafka-aware proxy such as Conduktor Gateway / Kroxylicious). Because Kafka clients must reach the specific leader broker, a plain L4 load balancer in front of all brokers does not work unless `advertised.listeners` points at per-broker names.
- Separate the controller listener onto its own port and security group. Nothing but brokers and controllers may reach it.
- Keep the JMX port (`-Dcom.sun.management.jmxremote.port`) closed to everything but the monitoring agent, or export metrics via a Prometheus JMX exporter on localhost.

```mermaid
flowchart TB
    subgraph Z0["Zone 0: Internet"]
        EXT["External producers / partners"]
    end
    subgraph Z1["Zone 1: DMZ"]
        GW["Kafka gateway / NLB (SNI passthrough)"]
    end
    subgraph Z2["Zone 2: Application subnets"]
        APP["Services (SCRAM or OAuth)"]
        CONN["Connect, Schema Registry, Streams apps"]
    end
    subgraph Z3["Zone 3: Broker subnet"]
        BRK["Brokers :9092 INTERNAL, :9093 EXTERNAL"]
    end
    subgraph Z4["Zone 4: Controller subnet"]
        CTL["Controllers :9094 (mTLS only)"]
    end
    subgraph Z5["Zone 5: Management"]
        OPS["Bastion / CI runner with admin credentials"]
        MON["Monitoring (JMX exporter, Prometheus)"]
    end
    EXT -->|"9093 TLS"| GW
    GW -->|"9093"| BRK
    APP -->|"9092"| BRK
    CONN -->|"9092"| BRK
    BRK -->|"9094"| CTL
    OPS -->|"9092 admin ACLs"| BRK
    MON -->|"scrape localhost exporters"| BRK
    MON --> CTL
```

### 3.8 Audit logging options

| Option | What it records | How to enable | Limitations |
|--------|-----------------|---------------|-------------|
| Authorizer logger | every allow/deny decision with principal, operation, resource, host | `log4j2.yaml`: logger `kafka.authorizer.logger` at `INFO` logs denies, `DEBUG` also logs allows | high volume at DEBUG; authorizer caches so repeated allows on a session are not all logged |
| Request logger | full request/response metadata per API call | logger `kafka.request.logger` at `DEBUG`/`TRACE` | extremely verbose; use for short forensic windows only |
| Authentication events | success/failure counts | JMX `kafka.server:type=socket-server-metrics,name=failed-authentication-total` and `successful-authentication-total`; failure reasons in `server.log` | metrics, not per-principal records |
| Confluent Audit Logs (Confluent-specific) | structured CloudEvents for authn/authz/management to a dedicated topic or cluster | `confluent.security.event.logger.*` | commercial |
| Gateway-level audit | every client request captured at the proxy | Kroxylicious / Conduktor Gateway filters | only for traffic through the gateway |

Ship `kafka.authorizer.logger` to a SIEM and alert on `DENIED` bursts: they signal either an attack or a broken deployment, and both need attention.

### 3.9 Schema Registry and Connect security

**Schema Registry (Confluent-specific component):**

```properties
# schema-registry.properties
listeners=https://0.0.0.0:8081
ssl.keystore.location=/etc/sr/tls/sr.keystore.p12
ssl.keystore.password=changeit
ssl.client.auth=false
# SR's own connection to Kafka
kafkastore.bootstrap.servers=SASL_SSL://broker-1.kafka.internal:9092
kafkastore.security.protocol=SASL_SSL
kafkastore.sasl.mechanism=SCRAM-SHA-512
kafkastore.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="schema-registry" password="...";
kafkastore.ssl.truststore.location=/etc/kafka/tls/truststore.p12
# Basic auth on the REST API
authentication.method=BASIC
authentication.roles=admin,developer
authentication.realm=SchemaRegistry-Props
```

Client side: `schema.registry.url=https://sr.example.com:8081`, `basic.auth.credentials.source=USER_INFO`, `basic.auth.user.info=payments:s3cr3t`, `schema.registry.ssl.truststore.location=...`. Schema Registry needs `READ`, `WRITE`, `DESCRIBE`, `DESCRIBE_CONFIGS` on `_schemas` and `READ` on its group `schema-registry`.

**Kafka Connect worker:**

```properties
# worker's own clients
bootstrap.servers=broker-1.kafka.internal:9092
security.protocol=SASL_SSL
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="connect" password="...";
ssl.truststore.location=/etc/kafka/tls/truststore.p12
# same for the producers/consumers/admin the worker creates for connectors
producer.security.protocol=SASL_SSL
producer.sasl.mechanism=SCRAM-SHA-512
producer.sasl.jaas.config=${file:/etc/kafka/secrets/connect.properties:jaas}
consumer.security.protocol=SASL_SSL
consumer.sasl.mechanism=SCRAM-SHA-512
consumer.sasl.jaas.config=${file:/etc/kafka/secrets/connect.properties:jaas}
admin.security.protocol=SASL_SSL
admin.sasl.mechanism=SCRAM-SHA-512
admin.sasl.jaas.config=${file:/etc/kafka/secrets/connect.properties:jaas}
# allow connectors to run under their own principal (KIP-458, since 2.3)
connector.client.config.override.policy=Principal
# REST API over TLS
listeners=https://0.0.0.0:8083
rest.advertised.listener=https
listeners.https.ssl.keystore.location=/etc/connect/tls/connect.keystore.p12
listeners.https.ssl.keystore.password=changeit
```

With `connector.client.config.override.policy=Principal` each connector sets `producer.override.sasl.jaas.config` (or `consumer.override.*`) so the connector's topics are authorized against that connector's own user, not the worker's. The Connect REST API has no built-in authentication in Apache Kafka; front it with an authenticating reverse proxy or the Confluent `BasicAuthSecurityRestExtension` (`rest.extension.classes`).

## 4. Failure modes and how to detect them

| Symptom | Likely cause | Metric / log to check | Fix |
|---------|--------------|-----------------------|-----|
| `SSLHandshakeException: PKIX path building failed` | client truststore lacks the broker CA | client log; `openssl s_client -connect broker:9093 -showcerts` | import CA into truststore |
| `No subject alternative names matching IP address ...` | connecting by IP or by a name not in the SAN | client log | fix SAN or `advertised.listeners`; never disable identification |
| `Received fatal alert: certificate_required` | listener has `ssl.client.auth=required`, client sent no cert | broker log | configure client keystore |
| `SaslAuthenticationException: Authentication failed: Invalid username or password` | wrong SCRAM credential, or user not created in this cluster | `failed-authentication-total` | recreate user with `kafka-configs.sh` |
| `Unexpected Kafka request of type METADATA during SASL handshake` | client uses `SSL`/`PLAINTEXT` against a SASL listener | broker log | set `security.protocol=SASL_SSL` on client |
| `Unsupported SASL mechanism` | mechanism not in `listener.name.<x>.sasl.enabled.mechanisms` | broker log | enable mechanism or change client |
| `TopicAuthorizationException: Not authorized to access topics: [orders]` | missing ACL | `kafka.authorizer.logger` DENIED line | add ACL; check prefix vs literal |
| `GroupAuthorizationException` | consumer has topic READ but no group READ | authorizer log | add `--group` ACL |
| `ClusterAuthorizationException` on `initTransactions` | no `TRANSACTIONAL_ID` ACL, or pre-2.8 needs `IDEMPOTENT_WRITE` | authorizer log | add transactional-id ACL |
| Brokers cannot join / replicas stay under-replicated after enabling authorizer | broker principal not in `super.users` | broker log `ClusterAuthorizationException` on `Fetch`/`LeaderAndIsr` | add broker principals to `super.users` on brokers **and** controllers |
| Clients disconnected every hour | `connections.max.reauth.ms` with a login module that cannot refresh | client log `Re-authentication failed` | fix token refresh (`sasl.login.refresh.*`) |
| Kerberos `Clock skew too great` | NTP drift > 5 minutes | broker/client log | fix NTP |
| Everything works from every host | `allow.everyone.if.no.acl.found=true` or no authorizer configured | `kafka-configs.sh --describe --entity-type brokers --all` | set authorizer, set to `false` |

## 5. Design guidance (architect view)

### 5.1 ACL design for teams and least privilege

1. **Name resources by ownership.** `<team>.<domain>.<entity>` for topics (`billing.orders.invoices`), `<team>.<app>` for groups and transactional ids. Naming is what makes prefixed ACLs possible.
2. **One principal per application, not per team.** `User:billing-invoicer`, not `User:billing`. A leaked credential then affects one app, and audit logs identify the caller.
3. **Grant prefixed ACLs to team automation, literal ACLs to apps.** The team's CI principal gets `CREATE`, `ALTER_CONFIGS`, `DESCRIBE` on prefix `billing.`; each app gets literal `READ`/`WRITE` on the topics it uses.
4. **Never grant `--operation All` or `--topic '*'` to an application.** Reserve wildcards for platform automation and put that principal in a vault.
5. **Consumers get `READ` on their own group prefix only.** Otherwise one app can join and steal partitions from another app's group.
6. **Explicit DENY for sensitive data.** A `DENY` on `pii.` prefixed topics for broad principals guarantees that a later over-broad ALLOW cannot expose them.
7. **Keep humans out of the data plane.** Engineers use short-lived OAuth tokens through a gateway with audit; nobody owns a permanent SCRAM user.
8. **ACLs as code.** Declarative files in git, applied by a pipeline; drift detection by diffing `kafka-acls.sh --list` against the desired state.

### 5.2 Decision table: authentication mechanism

| Situation | Choose | Reason |
|-----------|--------|--------|
| Internal services, no IdP integration required | SCRAM-SHA-512 over TLS | zero external dependencies, runtime user management |
| Corporate Kerberos already everywhere | GSSAPI | reuse identities and keytab distribution |
| External or multi-tenant clients, cloud-native platform | OAUTHBEARER with OIDC | short-lived tokens, revocation, central policy |
| Inter-broker and controller | mTLS (or SCRAM on the inter-broker listener) | certificate rotation is automatable; SCRAM cannot be used on controllers |
| Spark/Flink jobs with many executors | delegation tokens | avoid distributing keytabs |

### 5.3 Security hardening checklist

- [ ] No `PLAINTEXT` or `SASL_PLAINTEXT` listener in `listeners`.
- [ ] `ssl.enabled.protocols=TLSv1.3,TLSv1.2`; `ssl.cipher.suites` restricted if compliance requires.
- [ ] `ssl.endpoint.identification.algorithm=https` on every client and on the inter-broker listener.
- [ ] `ssl.client.auth=required` on `CONTROLLER` and on the inter-broker listener when mTLS is used.
- [ ] Per-host certificates with correct SANs, validity of one year or less, rotation automated.
- [ ] `authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer` on brokers **and** controllers.
- [ ] `allow.everyone.if.no.acl.found=false`.
- [ ] `super.users` contains only broker/controller principals plus one vaulted break-glass identity.
- [ ] `auto.create.topics.enable=false` (otherwise any producer with `CREATE`-implying ACLs makes topics).
- [ ] `delete.topic.enable` left `true` but `DELETE` ACL granted to automation only.
- [ ] No passwords in `server.properties`; config providers in use; files mode `0600` owned by the kafka user.
- [ ] `connections.max.reauth.ms` set when OAUTHBEARER or delegation tokens are used.
- [ ] Controller listener reachable only from broker/controller subnets.
- [ ] JMX not exposed outside localhost.
- [ ] `kafka.authorizer.logger` shipped to SIEM; alerts on DENIED spikes and on `failed-authentication-total`.
- [ ] Schema Registry and Connect REST APIs behind TLS and authentication.
- [ ] Quotas configured (`producer_byte_rate`, `consumer_byte_rate`, `request_percentage`) so one authenticated client cannot starve the cluster.
- [ ] Broker OS: dedicated `kafka` user, no shell for it, disks encrypted, SSH via bastion only.

### 5.4 Common misconfigurations

| Misconfiguration | Consequence |
|------------------|-------------|
| `advertised.listeners` uses IPs while certificates only carry DNS SANs | every client fails hostname verification, teams disable it |
| Same keystore copied to every broker with a wildcard SAN `*.kafka.internal` | works, but a compromise of one host is a compromise of all; wildcard certs also cannot be revoked per host |
| Authorizer enabled on brokers but not on controllers | `CreateTopics`/`AlterConfigs` forwarded to the controller are evaluated without ACLs (or fail), inconsistent behaviour |
| `super.users` on brokers but not on controllers | brokers cannot register with the quorum after enabling mTLS/SASL on the controller listener |
| `inter.broker.listener.name` on a listener with a client-facing quota or a public advertised name | replication traffic goes through the gateway or is throttled by client quotas |
| SCRAM user created with `SCRAM-SHA-256` while clients use `SCRAM-SHA-512` | "Invalid username or password" although the password is correct |
| `sasl.enabled.mechanisms` set globally but not per listener when listeners differ | listener silently accepts more mechanisms than intended |
| Rotating the CA by replacing it in the truststore in one step | brokers reject each other's certificates mid-rotation; rolling restart splits the cluster |
| `ssl.keystore.password` stored in dynamic config without config providers | password visible to anyone with `DESCRIBE_CONFIGS` |

## 6. Hands-on

A minimal but complete secured single-node KRaft lab (SCRAM-SHA-512 over TLS, ACLs on):

```bash
# 0. Certificates (reuse section 3.2 with HOST=localhost, SAN DNS:localhost,IP:127.0.0.1)

# 1. server.properties (combined mode for the lab)
cat > /tmp/kraft-secure.properties <<'EOF'
process.roles=broker,controller
node.id=1
controller.quorum.bootstrap.servers=localhost:9094
listeners=INTERNAL://localhost:9092,CONTROLLER://localhost:9094
advertised.listeners=INTERNAL://localhost:9092
listener.security.protocol.map=INTERNAL:SASL_SSL,CONTROLLER:SSL
inter.broker.listener.name=INTERNAL
controller.listener.names=CONTROLLER
log.dirs=/tmp/kraft-secure-logs
ssl.keystore.location=/tmp/tls/localhost.keystore.p12
ssl.keystore.password=changeit
ssl.key.password=changeit
ssl.truststore.location=/tmp/tls/truststore.p12
ssl.truststore.password=changeit
listener.name.controller.ssl.client.auth=required
sasl.enabled.mechanisms=SCRAM-SHA-512
sasl.mechanism.inter.broker.protocol=SCRAM-SHA-512
listener.name.internal.scram-sha-512.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="broker" password="broker-secret";
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer
allow.everyone.if.no.acl.found=false
super.users=User:broker;User:admin;User:CN=localhost
EOF

# 2. Format with SCRAM credentials for the broker and an admin
kafka-storage.sh format --cluster-id $(kafka-storage.sh random-uuid) --config /tmp/kraft-secure.properties \
  --add-scram 'SCRAM-SHA-512=[name=broker,password=broker-secret]' \
  --add-scram 'SCRAM-SHA-512=[name=admin,password=admin-secret]'
kafka-server-start.sh -daemon /tmp/kraft-secure.properties

# 3. Admin client config
cat > /tmp/admin.properties <<'EOF'
security.protocol=SASL_SSL
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="admin" password="admin-secret";
ssl.truststore.location=/tmp/tls/truststore.p12
ssl.truststore.password=changeit
EOF

# 4. Create an app user, a topic, and least-privilege ACLs
kafka-configs.sh --bootstrap-server localhost:9092 --command-config /tmp/admin.properties \
  --alter --add-config 'SCRAM-SHA-512=[password=app-secret]' --entity-type users --entity-name app
kafka-topics.sh --bootstrap-server localhost:9092 --command-config /tmp/admin.properties \
  --create --topic orders --partitions 3 --replication-factor 1
kafka-acls.sh --bootstrap-server localhost:9092 --command-config /tmp/admin.properties \
  --add --allow-principal User:app --producer --topic orders
kafka-acls.sh --bootstrap-server localhost:9092 --command-config /tmp/admin.properties \
  --add --allow-principal User:app --consumer --topic orders --group app-group

# 5. Verify as the app user
sed 's/admin"/app"/; s/admin-secret/app-secret/' /tmp/admin.properties > /tmp/app.properties
echo '{"id":1}' | kafka-console-producer.sh --bootstrap-server localhost:9092 --producer.config /tmp/app.properties --topic orders
kafka-console-consumer.sh --bootstrap-server localhost:9092 --consumer.config /tmp/app.properties \
  --topic orders --group app-group --from-beginning --max-messages 1

# 6. Prove denial: a different topic must fail with TopicAuthorizationException
kafka-console-consumer.sh --bootstrap-server localhost:9092 --consumer.config /tmp/app.properties \
  --topic __consumer_offsets --group app-group --max-messages 1 --timeout-ms 5000

# 7. Inspect TLS from the outside
openssl s_client -connect localhost:9092 -servername localhost -CAfile /tmp/tls/ca.crt </dev/null | head -20
```

## 7. Interview questions for this chapter

### Q1. Why does Kafka need both TLS and SASL when TLS alone can authenticate clients with certificates?
**Role:** [ARCH] | **Difficulty:** ★★☆ | **Topic:** Authentication

**Answer.**
It does not strictly need both; mTLS alone is a valid design. SASL is chosen when identities must come from an existing system (Kerberos, OIDC, a password database) or when issuing a certificate per application is operationally heavier than issuing a SCRAM user. TLS with `ssl.client.auth=required` gives strong, rotatable identities but ties identity to PKI, which many organisations cannot automate for hundreds of apps. SASL over TLS separates the channel (TLS) from the identity (SASL), so you can swap SCRAM for OAUTHBEARER later without touching certificates. On a `SASL_SSL` listener the SASL principal overrides the TLS principal.

**Follow-up probes.** Which principal is used for ACLs on `SASL_SSL` with `ssl.client.auth=required`? How do you rotate a SCRAM password without downtime?

### Q2. What happens in KRaft if you enable SCRAM for inter-broker authentication on a brand-new cluster?
**Role:** [ADMIN] | **Difficulty:** ★★★ | **Topic:** KRaft security

**Answer.**
The brokers cannot start because the SCRAM credential they need is stored in the metadata log, which is empty. Since 3.5 (KIP-900) you bootstrap it with `kafka-storage.sh format --add-scram 'SCRAM-SHA-512=[name=broker,password=...]'`, which writes the user record into the bootstrap metadata on every node. The controller listener itself still cannot use SCRAM at all, because controllers must authenticate each other before the metadata log is readable; use mTLS or PLAIN there. Before 3.5 the workaround was to start with PLAIN, create the SCRAM users, then switch.

**Follow-up probes.** How do you add a SCRAM user after the cluster is running? What does `sasl.mechanism.controller.protocol` do?

### Q3. A consumer has `READ` on topic `orders` but gets `GroupAuthorizationException`. Explain.
**Role:** [DEV] | **Difficulty:** ★☆☆ | **Topic:** ACLs

**Answer.**
Consuming with a group requires two ACLs: `READ` (which implies `DESCRIBE`) on the `TOPIC`, and `READ` on the `GROUP` resource, because joining a group, committing offsets and fetching committed offsets are group operations. `kafka-acls.sh --add --allow-principal User:x --consumer --topic orders --group g` grants both. If the group id is generated dynamically, grant a prefixed ACL on the group prefix.

**Follow-up probes.** What ACL does a Kafka Streams application need? What does `--producer` grant?

### Q4. How would you rotate a broker's TLS certificate with zero downtime, and what constraint does Kafka impose?
**Role:** [ADMIN] | **Difficulty:** ★★☆ | **Topic:** TLS

**Answer.**
Keystore and truststore locations/passwords are dynamic per-broker configs (KIP-226). Place the new keystore on disk and run `kafka-configs.sh --entity-type brokers --entity-name <id> --alter --add-config 'listener.name.<l>.ssl.keystore.location=...'`; the broker reloads the keystore without restart and new connections use the new cert. The constraint: the new certificate must validate against the broker's current truststore, so a CA change is a two-phase operation (add new CA to all truststores first, then rotate leaf certificates, then remove the old CA). Also the DN must still map to a principal in `super.users`.

**Follow-up probes.** Does an existing connection get the new certificate? How do you verify which certificate a broker serves?

### Q5. Compare `allow.everyone.if.no.acl.found=true` with an explicit ALLOW for `User:*`.
**Role:** [ARCH] | **Difficulty:** ★★☆ | **Topic:** Authorization

**Answer.**
`allow.everyone.if.no.acl.found=true` applies only to resources that have no ACL at all, so it makes every newly created topic world-readable until someone adds its first ACL, which then locks out everyone else. An explicit ALLOW for `User:*` on a specific resource is deliberate, visible in `kafka-acls.sh --list`, and can be paired with DENY entries that still win. Production clusters run with the flag `false` and grant wildcards only intentionally.

**Follow-up probes.** Does DENY override `super.users`? How does prefixed matching interact with literal `*`?

### Q6. Where would you put field-level encryption in a pipeline, and what does it cost you?
**Role:** [ARCH] | **Difficulty:** ★★★ | **Topic:** Encryption at rest

**Answer.**
In the serializer on the producer side, with keys from a KMS and envelope encryption (a data key per topic or per field, wrapped by a KMS master key). This protects data from broker operators, disk snapshots, MirrorMaker copies and misconfigured ACLs. Costs: consumers need KMS access and key caching, Kafka cannot filter or compact on encrypted keys (keep the record key in clear or hash it), schema evolution must account for ciphertext fields, and stream processors that need the plaintext must decrypt and re-encrypt. Confluent CSFLE implements this pattern with rules stored in Schema Registry.

**Follow-up probes.** How do you rotate a data encryption key without re-encrypting historical data? What about key deletion for GDPR erasure (crypto-shredding)?

### Q7. Design the ACL set for a Kafka Streams application with `application.id=billing-aggregator`.
**Role:** [DEV] | **Difficulty:** ★★☆ | **Topic:** ACLs

**Answer.**
Streams creates internal topics named `<application.id>-<store>-changelog` and `<application.id>-<name>-repartition`, uses the group `billing-aggregator`, and with `exactly_once_v2` uses transactional ids prefixed `billing-aggregator-`. Grant: `READ`+`DESCRIBE` on the input topics, `WRITE`+`DESCRIBE` on output topics, `CREATE`/`READ`/`WRITE`/`DESCRIBE`/`DELETE` on the prefixed topic resource `billing-aggregator-`, `READ` on the group, `WRITE`+`DESCRIBE` on prefixed transactional id `billing-aggregator-`. Use `--resource-pattern-type prefixed` for the internal topics and transactional ids.

**Follow-up probes.** Why does Streams need `DELETE` on internal topics? What breaks if the group ACL is missing?

### Q8. Your security team wants every access to `customer-pii` audited. What can OSS Kafka provide?
**Role:** [ADMIN] | **Difficulty:** ★★☆ | **Topic:** Audit

**Answer.**
OSS Kafka has no dedicated audit log, but the authorizer logger `kafka.authorizer.logger` records each authorization decision with principal, operation, resource, and host: `INFO` captures denies, `DEBUG` captures allows too. Route that logger to its own appender and ship it to a SIEM. Note the authorizer caches decisions per session, so you see the first allow per connection, not every fetch. For per-request granularity, `kafka.request.logger` at `DEBUG` is possible but extremely verbose. For structured, complete audit events you need Confluent Audit Logs or a Kafka-aware gateway.

**Follow-up probes.** How do you log who created or deleted a topic? Where does a client's IP appear?

### Q9. A team reports intermittent `SSLHandshakeException` only from Kubernetes pods, never from VMs. Where do you look?
**Role:** [ADMIN] | **Difficulty:** ★★☆ | **Topic:** TLS troubleshooting

**Answer.**
Start from the client log for the exact reason: PKIX path failure means the pod image lacks the CA (check the mounted truststore and `ssl.truststore.location`); `No subject alternative names` means pods resolve brokers to a name not in the SAN (for example a headless service name `kafka-0.kafka.ns.svc` versus the advertised `broker-1.kafka.internal`). Confirm with `openssl s_client -connect <host>:9093 -servername <host>` from inside a pod. Intermittent failures often point to one broker with an expired or mismatched certificate: check each broker with `keytool -list -v` or `openssl s_client` per host.

**Follow-up probes.** How does `ssl.endpoint.identification.algorithm` interact with `advertised.listeners`? What does `-Djavax.net.debug=ssl,handshake` show?

## Key takeaways
- Build security in order: TLS channel, then authentication, then authorization, then audit. Each pillar depends on the previous one.
- Use separate listeners for clients, replication and the controller channel; the controller listener needs mTLS (or PLAIN/GSSAPI) because SCRAM cannot bootstrap the quorum.
- In KRaft, SCRAM credentials for brokers are created at format time (`kafka-storage.sh format --add-scram`), and `StandardAuthorizer` with `super.users` must be configured on brokers **and** controllers.
- `allow.everyone.if.no.acl.found=false`, DENY beats ALLOW, and prefixed ACLs on well-named resources are how teams get least privilege without ticket queues.
- Secrets belong in config providers, not in property files; certificates rotate dynamically without restarts.
- Kafka's built-in audit is the authorizer logger; anything richer is a gateway or a commercial add-on.

## Further reading
- Apache Kafka documentation, section 7 "Security" (7.2 Encryption and Authentication using SSL, 7.3 Authentication using SASL, 7.5 Authorization and ACLs)
- KIP-226: Dynamic Broker Configuration (keystore rotation)
- KIP-368: Allow SASL Connections to Periodically Re-Authenticate
- KIP-651: Support PEM format for SSL certificates and private key
- KIP-768: Extend SASL/OAUTHBEARER with Support for OIDC
- KIP-801: Implement an Authorizer that stores metadata in `__cluster_metadata` (StandardAuthorizer)
- KIP-900: KRaft kafka-storage.sh API additions to support SCRAM
- KIP-297 and KIP-421: Externalizing Secrets with Config Providers
- KIP-679: Producer will enable the strongest delivery guarantee by default (IDEMPOTENT_WRITE implication)
