# swift-mt-mx-converter

A SWIFT **MT → ISO 20022 (MX)** message converter that works out what it is
looking at, resolves each field to its meaning rather than its text, validates
both sides of the translation, and tells you how much to trust the result.

Written in TypeScript with **no runtime dependencies** — the parser, the field
pattern engine, the XML writer, the HTTP server and the reference data are all
in this repository.

```bash
npm install && npm run build
node dist/src/cli/main.js convert examples/mt103.txt
```

New here? **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** is a complete
walk through: build it, run it four ways (repo, global `mt2mx` command,
standalone `dist/` folder, Docker), produce output files, and check the results
against the twelve sample messages in `examples/`.

---

## What it converts

| MT | Name | MX |
| --- | --- | --- |
| MT103 (core, STP, REMIT) | Single customer credit transfer | `pacs.008.001.08` |
| MT200 | FI transfer for its own account | `pacs.009.001.08` |
| MT202 / MT205 | General FI transfer | `pacs.009.001.08` |
| MT202 COV / MT205 COV | FI transfer covering a customer payment | `pacs.009.001.08` (with `UndrlygCstmrCdtTrf`) |
| MT210 | Notice to receive | `camt.057.001.06` |
| MT900 | Confirmation of debit | `camt.054.001.08` |
| MT910 | Confirmation of credit | `camt.054.001.08` |
| MT940 / MT950 | Customer statement | `camt.053.001.08` |
| MT942 | Interim transaction report | `camt.052.001.08` |
| MT192 / MT292 / MT992 | Request for cancellation | `camt.056.001.08` |
| MT196 / MT296 / MT996 | Answers | `camt.029.001.09` |

`mt2mx list` prints the same catalogue; `GET /conversions` serves it as JSON.

---

## What the "intelligent" part actually does

Nothing here is a language model — every behaviour below is a rule you can read
in the source and a diagnostic you can grep for.

**It works out the message type.** The FIN application header normally states
it, but messages arrive without their envelope all the time. When block 2 is
missing, each known message definition is scored on mandatory field coverage,
distinctive field signatures and fields that would be out of place, and the
winner is reported with its margin over the runner up:

```
$ printf ':20:X\n:25:ACC\n:28C:1/1\n:60F:C240114EUR10,00\n:62F:C240115EUR10,00\n' | mt2mx detect -
#1 MT940 from content, confidence 100%
   MT940 100%  statement number with opening and closing balances
   MT942   9%  missing mandatory 34F, 13D; unexpected field 60, 62
```

When the header *is* present it stays authoritative, but a disagreement with the
content is reported (`DETECT.HEADER_CONTENT_MISMATCH`) rather than ignored.

**It works out the variant.** `{3:{119:}}` when the sender set it; otherwise a
customer sequence after an institution transfer makes an MT202 a COV, and field
77T makes an MT103 a REMIT.

**It resolves parties instead of copying text.** A party field is read
structurally, so the same code handles `50A`, `50F` and `50K`:

- a BIC is validated (ISO 9362, real country code) and expanded to BIC11;
- an account line is classified — IBAN (checked with ISO 7064 MOD 97-10 against
  the registry length for its country), national clearing member id, or a
  proprietary number;
- `//SC401234` becomes `ClrSysMmbId/ClrSysId/Cd=GBDSC` + `MmbId=401234`, from a
  table of 21 national schemes;
- option F's numbered lines become a real structured party — name, town,
  country, date and place of birth, national identity number — landing in
  `PrvtId` or `OrgId` as the scheme code dictates;
- a country is lifted out of an unstructured address (`10115 BERLIN, GERMANY` →
  `Ctry=DE`, `PstCd=10115`, `TwnNm=BERLIN`) so `PstlAdr/Ctry` can be populated;
- a BIC found in a name-and-address option is recognised as one, with a note.

**It fans one MT field out across the ISO model.** Field 23E and the field 72
code words are split between service level, category purpose, clearing channel,
`InstrForCdtrAgt` (`Instruction3Code`) and `InstrForNxtAgt` (`Instruction4Code`);
`/INS/` becomes `PrvsInstgAgt1`; `/RETN/` raises a warning that the payment is
really a return and belongs in pacs.004.

**It fills in what ISO 20022 requires and MT leaves implicit.** No field 52a
means the sender is the debtor agent; no 57a means the receiver is the creditor
agent; the settlement method is derived from which correspondents are named.
Every such inference is an `MX.AGENT_INFERRED` / `MX.SETTLEMENT_METHOD`
diagnostic, never a silent assumption.

**It never loses data quietly.** Every field a mapper reads is recorded. Anything
left over at the end is reported field by field (`MT.FIELD.UNMAPPED`), and
extended remittance (77T) goes into `SplmtryData` with a warning that receivers
may not read it.

**It scores its own work.** Detection quality, diagnostics and field coverage
produce a 0–1 confidence with the factors that moved it, so a queue can route
`high` straight through and hold `low` for a human.

**It is reproducible.** Pass `--now`, and the same MT gives byte-identical XML.
Messages with no UETR get one *derived* from their content by hashing, so a
replay produces the same identifier instead of a fresh random one.

---

## Using it

### Command line

```bash
mt2mx convert  <file|-> [--out f] [--document] [--type 103] [--strict] [--json]
mt2mx batch    <file|-> [--out-dir d]      # RJE ($-separated) or concatenated FIN
mt2mx detect   <file|->                    # type, variant and the runners up
mt2mx validate <file|-> [--type 103]       # MT rules only, no conversion
mt2mx list                                 # the conversion catalogue
```

Exit codes: `0` success, `1` conversion or validation problem, `2` usage error.
Diagnostics go to stderr, XML to stdout, so `mt2mx convert x.txt > out.xml`
gives a clean file.

```
$ mt2mx validate broken.txt
[ERROR] MT.RULE.T26: Reference '/BADREF/' must not start or end with '/' nor contain '//'. (:20:)
[ERROR] MT.RULE.C2: Field 71A is BEN, so at least one sender's charges field (71F) is mandatory. (:71F:)
[ERROR] MT.RULE.C13: Field 23B is SPRI, so field 23E may only contain SDVA, TELB, PHOB or INTC, not CHQB. (:23E:)
[ERROR] MT.RULE.C03: EUR allows 2 decimal(s) but the amount carries 3 (:32A:)
4 error(s) - checked network rules T26, T27, C1, C2, C3, C13, C14, C03
```

### Library

```ts
import { convert } from 'swift-mt-mx-converter';

const report = convert(mtText, { now: '2024-01-15T10:00:00Z' });

report.ok;                  // nothing worse than a warning
report.mxId;                // 'pacs.008.001.08'
report.xml;                 // the serialised business message
report.confidence.score;    // 0..1, with .band and .factors
report.coverage.unmapped;   // ['77T'] - fields with no home in the target
report.diagnostics;         // every decision, with mtTag and mxPath
```

The lower layers are exported too: `parseMt`, `matchPattern`, `resolveParty`,
`validateIban`, `validateMt`, `validateMx`, `detect`, `scoreCandidates`.

### HTTP

```bash
npm run serve        # PORT=8080 by default
curl -X POST localhost:8080/convert --data-binary @examples/mt103.txt
curl -X POST localhost:8080/convert -H 'accept: application/xml' --data-binary @examples/mt103.txt
```

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness probe |
| `GET /conversions` | the conversion catalogue |
| `POST /convert` | one message in, one document out |
| `POST /batch` | a file of messages in, a summary out |
| `POST /detect` | message type detection only |
| `POST /validate` | MT validation only |

The body is either raw MT (`text/plain`) or `{"message": "...", "options": {…}}`.
`Accept: application/xml` returns the document itself, with the type, target and
confidence in `X-MT-Type`, `X-MX-Id` and `X-Confidence` headers. A message that
cannot be converted comes back as `422` **with its diagnostics**.

### Standalone

There are no runtime dependencies, so the compiled output is the whole program:

```bash
npm pack && npm install -g ./swift-mt-mx-converter-1.0.0.tgz   # the mt2mx command
cp -r dist/src /opt/mt2mx && node /opt/mt2mx/src/cli/main.js … # or just copy it
docker build -t mt2mx . && docker run -p 8080:8080 mt2mx       # or a container
```

---

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `envelope` | `business-message` | `document` emits a bare `<Document>` without the head.001 header |
| `addressFormat` | `hybrid` | `hybrid` = country code + original address lines; also `unstructured` and `structured` |
| `uetr` | `derive` | `omit` leaves `PmtId/UETR` out when the source has none |
| `now` | current time | fixes every creation timestamp, making output reproducible |
| `referenceYear` | current year | century window for two digit dates |
| `messageType` / `variant` | detected | force the type or variant |
| `strict` | `false` | a warning is enough to fail the conversion |
| `skipMtValidation` / `skipMxValidation` | `false` | drop a validation stage |

`addressFormat: 'hybrid'` is the default because it is what most MT→MX
translation rulebooks produce. Rulebooks that require a purely structured or
purely unstructured address are one option away.

---

## Diagnostics

Every diagnostic carries a stable code, a severity, the MT field it came from
and the MX path it was headed for.

| Prefix | Meaning |
| --- | --- |
| `MT.PARSE.*` | block or field structure problems |
| `MT.FIELD.*` | a field that does not match its format specification |
| `MT.RULE.*` | SWIFT network validated rules (`C1`, `C2`, `C3`, `C13`, `C14`, `C03`, `T26`, `T27`) |
| `MT.SCHEMA.*` | missing mandatory fields, fields the definition does not allow |
| `MT.PARTY.*` | party resolution: invalid IBAN, absent BIC, odd clearing code |
| `DETECT.*` | message type and variant detection |
| `MX.*` | mapping decisions, inferences and generated-document validation |

Severity is `fatal` (nothing usable), `error` (output produced but not
sendable), `warning` (usable, needs a look) or `info` (a decision worth
recording).

---

## How it is put together

```
src/
  mt/          FIN parser, field format pattern engine, message schemas
  semantic/    parties, accounts, amounts, dates, code words, statement lines
  mx/          namespace-aware XML writer, ISO 20022 components, head.001 BAH
  mapping/     mapping context, shared steps, one mapper per message family
  intelligence/message type detection, confidence scoring
  validation/  BIC, IBAN, MT network rules, MX structural rules
  pipeline/    convert() and batch processing
  reference/   ISO 4217 minor units, ISO 3166, national clearing systems
  api/ cli/    HTTP interface and command line interface
```

Two pieces carry most of the weight:

**The field pattern engine** (`src/mt/pattern.ts`) compiles SWIFT format
specifications — `6!n3!a15d`, `4*35x`, `[[/1!a][/34x]\n]4!a2!a2!c[3!c]` — into
regular expressions with capture groups, so a single pass both validates a field
and slices it into components. Bracketed groups nest and are independently
optional, which is what makes `/D/1234`, `/1234` and neither all parse correctly.

**The XML writer** (`src/mx/xml.ts`) prunes empty branches. ISO 20022 messages
are almost entirely optional, so mappers build the full shape and anything that
ends up without content disappears — `el('Dbtr', el('Nm', name))` simply is not
emitted when `name` is undefined. Child order is preserved because the ISO
schemas are `xs:sequence`.

See [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) to run it,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow,
[docs/MAPPING.md](docs/MAPPING.md) for the field-by-field mapping tables and
[docs/API.md](docs/API.md) for the HTTP reference.

---

## Development

```bash
npm run build       # compile to dist/
npm test            # build, then run 182 tests with node:test
npm run typecheck   # strict, plus noUnusedLocals / noUnusedParameters
```

The test suite covers the pattern engine, the FIN parser, semantic resolution,
both validators, detection, every mapper (asserting on the generated XML), the
pipeline, the HTTP interface and the CLI.

---

## Limitations

Worth knowing before this goes anywhere near production traffic:

- **Not XSD validated.** The ISO 20022 schemas are not redistributed here, so
  MX validation is rule based: datatypes, lengths, code lists and a required
  path list per message. It catches what a translation layer actually gets
  wrong, but it is not a substitute for validating against the official schemas.
- **Not certified.** The mappings follow the publicly documented MT and ISO
  20022 message definitions and the conventions of the CBPR+ translation rules,
  but this is an independent implementation and has not been through any
  accreditation.
- **One direction.** MT → MX only. MX → MT has different problems (truncation,
  lossy address flattening) and is not attempted here.
- **A subset of the catalogue.** Eleven message families. Anything else is
  refused with `CONVERT.NO_MAPPER` rather than half-converted.
- **No BIC directory.** BICs are validated structurally; there is no lookup
  against a real institution directory, so a well-formed but non-existent BIC
  passes.
- **Ambiguity is reported, not resolved.** Where MT is genuinely underspecified
  — the settlement method, the investigation status behind free-text answers,
  which of four address lines is the town — the converter makes a documented
  choice and records it. Read the diagnostics before trusting the output.

## Licence

MIT.
