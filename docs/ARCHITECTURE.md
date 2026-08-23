# Architecture

## The pipeline

```
MT text
  │
  ├─ parse ──────────► MtMessage        blocks 1-5, fields with tag/option/lines
  │                                     tolerant: missing envelope, CRLF, RJE, no trailer
  ├─ detect ─────────► Detection        type + variant, from the header or from the fields
  │
  ├─ validate MT ────► Diagnostic[]     field formats, schema completeness, network rules
  │
  ├─ map ────────────► XmlElement       mapper for (type, variant), via MappingContext
  │
  ├─ validate MX ────► Diagnostic[]     datatypes, lengths, code lists, required paths
  │
  └─ serialise ──────► XML              <Document>, or <Envelope> with a head.001 header

                       ConversionReport { ok, xml, confidence, coverage, diagnostics }
```

No stage throws for a message-level problem. Each contributes to one diagnostic
list and the pipeline goes as far as it can, because an operations team needs to
see what a message *would* have become in order to fix it.

## Layers

### `mt/` — syntax

`parser.ts` splits the FIN blocks. Block 4 is special: it ends at the `-}`
sentinel rather than a bare `}`, and blocks 3 and 5 contain nested braces, so
the scanner tracks depth. A message with no `{1:` at all is read as a bare text
block.

`pattern.ts` compiles SWIFT format specifications into anchored regular
expressions. The grammar is small — fixed (`4!c`), variable (`35x`), decimal
(`15d`), multiline (`4*35x`), literal, and nested optional groups — but the
nesting matters: `[/1!a][/34x]` has to accept `/D/1234`, `/1234` and the empty
string, which a flat "optional" flag cannot express. Decimal tokens are
re-checked after matching because the mandatory comma counts towards the length.

`formats.ts` holds the format for every tag the converter knows, keyed by full
tag. A field's format belongs to the tag, not to the message, so message schemas
in `schemas.ts` only list which tags appear, whether they are mandatory, and
which sequence they belong to.

### `semantic/` — meaning

This is where a field stops being characters. `party.ts` reads a party field
structurally rather than trusting its option letter, because senders bend the
specification constantly — a BIC in option K, an account line without its slash.
The format pattern is still evaluated, so a deviation becomes a diagnostic
instead of silent corruption.

`account.ts` classifies a party identifier line into an IBAN, a national
clearing member id or a proprietary account. `statement.ts` scans field 61 left
to right, because a regular expression cannot split it reliably — the reference
may itself contain slashes.

### `mx/` — the target

`xml.ts` is a small immutable node tree with one important behaviour: empty
branches are pruned before serialisation. ISO 20022 is almost entirely optional,
so mappers emit the full shape and whatever has no content disappears.

`components.ts` builds the reusable ISO structures — `PartyIdentification135`,
`BranchAndFinancialInstitutionIdentification6`, `CashAccount38`,
`PostalAddress24` — each emitting its children in the order the schema's
`xs:sequence` requires.

### `mapping/` — the translation

`MappingContext` carries options and diagnostics, and **records every field a
mapper reads**. Whatever is unread at the end is data the target has no home
for, and is reported field by field. This is the single most common failure mode
of a translation layer, so it is measured rather than hoped for.

`shared.ts` holds the steps common to the payment messages: settlement
information, payment type information, charges, time indications, remittance,
regulatory reporting. Each mapper is then mostly a declaration of ISO element
order.

Sequences are reconstructed from the flat field list: `splitAt` divides an
MT202 COV at its first field 50a, and `repeatingGroups` collects each field 61
with its following field 86.

### `intelligence/` — the judgement calls

`detector.ts` scores every schema against the fields present:

```
score = 0.55 × mandatory field coverage
      + 0.45 × distinctive signature match
      -        penalty for fields the definition has no place for
```

Signatures are what a human would use: an MT940 has a statement number with
opening and closing balances; an MT202 has a related reference and a beneficiary
institution but no customer fields. Confidence reflects the margin over the
runner up, so a near tie is reported rather than asserted.

`confidence.ts` combines detection quality, diagnostic costs and field coverage
into one score plus the factors that moved it, so the number can be explained.

### `validation/` — both sides

MT validation covers field formats, schema completeness and the network
validated rules a FIN interface would apply (C1, C2, C3, C13, C14, C03, T26,
T27), each identified by its SWIFT rule code.

MX validation is rule based rather than schema based: a table of datatype and
length rules keyed by element name, applied wherever the element appears, plus a
required-path list per message definition.

## Design decisions

**No runtime dependencies.** Everything — parser, pattern engine, XML writer,
HTTP server, reference data — is in the repository. A payments component that
pulls in a dependency tree is a supply chain question the operator has to answer.

**Diagnostics over exceptions.** An exception ends the story; a diagnostic
carries a code, a severity, the source field and the target path, and can be
counted, routed and alerted on.

**Determinism.** Given `now`, the same input produces byte-identical output.
Generated identifiers are hashed from the message content, so a replay does not
produce a new UETR and break duplicate detection downstream.

**Inference is always visible.** The converter fills in what ISO 20022 demands
and MT leaves implicit, but every inference is a diagnostic with the reasoning
attached.
