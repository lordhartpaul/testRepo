# Getting started

A complete walk through: build it, run it four different ways, produce output
files, and check the results against sample messages.

Every command below was run against this repository. Where output is shown, that
is the actual output.

---

## 1. Prerequisites

- **Node.js 20 or newer** (`node -v`). Nothing else — the converter has no
  runtime dependencies. TypeScript is needed only to compile it.
- Optional: Docker, if you want to run the HTTP interface as a container.

---

## 2. Build

```bash
git clone <your-fork-or-clone-url> testRepo
cd testRepo
git checkout claude/mt-mx-iso20022-converter-h7bi29

npm install      # installs typescript + @types/node (dev only)
npm run build    # compiles src/ and test/ into dist/
npm test         # 182 tests
```

Expected tail of `npm test`:

```
# tests 182
# pass 182
# fail 0
```

If that passes, the toolchain is good and everything below will work.

---

## 3. Run it — four ways

### 3a. Straight from the repo (simplest)

```bash
node dist/src/cli/main.js list
node dist/src/cli/main.js convert examples/mt103.txt
```

### 3b. Install the `mt2mx` command globally

```bash
npm pack                                     # -> swift-mt-mx-converter-1.0.0.tgz
npm install -g ./swift-mt-mx-converter-1.0.0.tgz

mt2mx list                                   # now available anywhere
mt2mx convert examples/mt103.txt
```

`npm run bundle` does the build and the pack in one step. To remove it later:
`npm uninstall -g swift-mt-mx-converter`.

For day-to-day development on the code itself, `npm link` is friendlier — it
points `mt2mx` at your working copy, so a rebuild takes effect immediately.

### 3c. Fully standalone — no `node_modules`, no `package.json`

Because there are no runtime dependencies, the compiled output is the whole
program. Copy it anywhere with a Node runtime and run it:

```bash
mkdir -p /opt/mt2mx && cp -r dist/src /opt/mt2mx/
node /opt/mt2mx/src/cli/main.js convert message.txt
```

That directory is self-contained. This is the easiest way to drop the converter
onto a locked-down server or into a container you already control.

### 3d. Docker (HTTP interface)

```bash
docker build -t mt2mx .
docker run -p 8080:8080 mt2mx

curl -X POST localhost:8080/convert --data-binary @examples/mt103.txt
```

The image is two stages: build with the dev dependencies, then ship only
`dist/` on `node:22-alpine`. There is a `HEALTHCHECK` on `/health`.

---

## 4. Producing output files

### One message to one file

```bash
mt2mx convert examples/mt103.txt --out out/mt103.xml
```

XML goes to stdout (or `--out`), diagnostics go to stderr. So a plain redirect
gives you a clean file:

```bash
mt2mx convert examples/mt103.txt > out/mt103.xml     # XML only
mt2mx convert examples/mt103.txt 2> out/mt103.log    # diagnostics only
```

### A whole file of messages to a directory

```bash
mt2mx batch examples/batch.txt --out-dir out/
```

```
ok   #1 MT103 -> pacs.008.001.08, confidence 96% (high), 6/6 fields mapped
ok   #2 MT202 -> pacs.009.001.08, confidence 96% (high), 4/4 fields mapped
ok   #3 MT900 -> camt.054.001.08, confidence 96% (high), 4/4 fields mapped

3/3 converted, average confidence 96%
```

Files are written as `0001-mt103.xml`, `0002-mt202.xml`, `0003-mt900.xml`.
Input may be RJE (messages separated by a line containing `$`) or concatenated
FIN blocks — both are detected automatically.

### Machine readable reports

```bash
mt2mx convert examples/mt103.txt --json > out/report.json
mt2mx batch examples/batch.txt --json > out/batch-report.json
```

The JSON carries `ok`, `messageType`, `mxId`, `confidence`, `coverage`,
`rulesChecked`, every `diagnostic`, and the `xml` itself — enough to drive a
review queue without re-parsing anything.

### Reproducible output

Pass `--now` to fix every creation timestamp. The same input then produces
byte-identical XML, which makes conversions diffable and safe to replay:

```bash
mt2mx convert examples/mt103.txt --now 2024-01-15T10:00:00Z --out a.xml
mt2mx convert examples/mt103.txt --now 2024-01-15T10:00:00Z --out b.xml
diff a.xml b.xml && echo identical
```

### Convert every example at once

```bash
mkdir -p out
for f in examples/*.txt; do
  case "$f" in *batch.txt|*invalid*) continue;; esac
  mt2mx convert "$f" --now 2024-01-15T10:00:00Z \
    --out "out/$(basename "${f%.txt}").xml"
done
ls out/
```

---

## 5. The sample messages

Twelve samples ship in `examples/`. Ten are valid; two exist to demonstrate
detection and validation.

| File | What it is | Converts to | Confidence |
| --- | --- | --- | --- |
| `mt103.txt` | Customer credit transfer, IBAN both sides, `/ROC/` reference, field 72 instruction | `pacs.008.001.08` | 100% |
| `mt103-structured.txt` | MT103 STP with option F structured parties (date and place of birth), 59F beneficiary, regulatory reporting | `pacs.008.001.08` | 100% |
| `mt103-headerless.txt` | The same kind of payment with **no FIN envelope** — for the detection demo | `pacs.008.001.08` | 80% |
| `mt103-invalid.txt` | Deliberately broken: seven rule violations — for the validation demo | (refused) | — |
| `mt200.txt` | Own account transfer, settlement account in 53B | `pacs.009.001.08` | 96% |
| `mt202.txt` | Bank to bank transfer with a `/INS/` code word and a UETR | `pacs.009.001.08` | 100% |
| `mt202cov.txt` | Cover payment: sequence B carries the underlying customer transfer | `pacs.009.001.08` | 96% |
| `mt210.txt` | Notice to receive with two repeating sequences | `camt.057.001.06` | 100% |
| `mt900.txt` | Debit confirmation with a 13D booking time | `camt.054.001.08` | 96% |
| `mt940.txt` | Statement: three entries including a reversal, four balances | `camt.053.001.08` | 100% |
| `mt942.txt` | Interim report with a floor limit and entry totals | `camt.052.001.08` | 100% |
| `batch.txt` | Three messages in RJE format | mixed | 96% |

A confidence below 100% is not a problem — it usually means the source carried
no UETR and one had to be derived, which is recorded as a warning.

---

## 6. Three things worth trying

### Detection without a header

`mt103-headerless.txt` has no `{1:}`/`{2:}` blocks at all. The type is worked
out from the fields:

```bash
mt2mx detect examples/mt103-headerless.txt
```

```
#1 MT103 from content, confidence 100%
   MT103 100%  bank operation code with an ordering and a beneficiary customer
   MT202   4%  missing mandatory 21, 58a; unexpected field 23, 71
   MT192   0%  missing mandatory 21, 11S
[WARNING] DETECT.FROM_CONTENT: No application header; MT103 was inferred from the fields …
```

It converts too — the confidence drops to 80% because the type was inferred and
the sender/receiver BICs the header would have supplied are not there.

### Validation without conversion

```bash
mt2mx validate examples/mt103-invalid.txt
```

```
[ERROR] MT.RULE.T26: Reference '/BADREF/' must not start or end with '/' nor contain '//'. (:20:)
[ERROR] MT.RULE.T27: 'NOTABIC' is not a valid BIC: a BIC must be 8 or 11 characters. (:52A:)
[ERROR] MT.RULE.C1: Fields 32A (EUR) and 33B (USD) are in different currencies, so field 36 (exchange rate) is mandatory. (:36:)
[ERROR] MT.RULE.C2: Field 71A is BEN, so at least one sender's charges field (71F) is mandatory. (:71F:)
[ERROR] MT.RULE.C13: Field 23B is SPRI, so field 23E may only contain SDVA, TELB, PHOB or INTC, not CHQB. (:23E:)
[ERROR] MT.RULE.C14: Field 23B is SPRI, so an intermediary institution (56a) is not allowed. (:56a:)
[ERROR] MT.RULE.C03: EUR allows 2 decimal(s) but the amount carries 3 (:32A:)
7 error(s) - checked network rules T26, T27, C1, C2, C3, C13, C14, C03
```

Exit code is 1, so this drops straight into a pre-flight check. `validate`
handles a file of many messages and reports each one separately.

### A cover payment keeping its underlying transfer

```bash
mt2mx convert examples/mt202cov.txt --document --now 2024-01-15T10:00:00Z \
  | grep -A6 UndrlygCstmrCdtTrf
```

The customer detail in sequence B is what sanction screening downstream needs;
losing it is the classic COV translation failure.

---

## 7. Using it as a library

```bash
node examples/use-as-library.mjs
```

`examples/use-as-library.mjs` is a runnable tour of the API — convert, detect,
validate and batch. The essentials:

```js
import { convert } from './dist/src/index.js';

const report = convert(mtText, { now: '2024-01-15T10:00:00Z' });

report.ok;                  // nothing worse than a warning
report.mxId;                // 'pacs.008.001.08'
report.xml;                 // the serialised business message
report.confidence.score;    // 0..1, plus .band and .factors
report.coverage.unmapped;   // fields with no home in the target
report.diagnostics;         // every decision, with mtTag and mxPath
```

In TypeScript, import from the package name once it is installed:

```ts
import { convert, type ConversionReport } from 'swift-mt-mx-converter';
```

Lower layers are exported too, if you only want one piece: `parseMt`,
`matchPattern`, `resolveParty`, `validateIban`, `validateBic`, `validateMt`,
`validateMx`, `detect`, `scoreCandidates`.

A routing example — send anything uncertain to a human:

```js
const report = convert(mtText);
if (!report.ok) queue('repair', report.diagnostics);
else if (report.confidence.band === 'high') send(report.xml);
else queue('review', report);
```

---

## 8. Running the HTTP interface

```bash
npm run serve                 # or: node dist/src/api/server.js
PORT=9000 node dist/src/api/server.js
```

```bash
# JSON report, including the XML
curl -X POST localhost:8080/convert --data-binary @examples/mt103.txt

# the document itself, with metadata in the headers
curl -X POST "localhost:8080/convert?envelope=document" \
     -H 'accept: application/xml' --data-binary @examples/mt940.txt

# options in a JSON body
curl -X POST localhost:8080/convert -H 'content-type: application/json' \
     -d '{"message":"...MT text...","options":{"envelope":"document","uetr":"omit"}}'

curl -X POST localhost:8080/batch    --data-binary @examples/batch.txt
curl -X POST localhost:8080/detect   --data-binary @examples/mt103-headerless.txt
curl -X POST localhost:8080/validate --data-binary @examples/mt103-invalid.txt
curl localhost:8080/health
curl localhost:8080/conversions
```

`200` for a clean conversion, `422` when it could not be converted — **with the
diagnostics either way**. Full reference: [API.md](API.md).

One difference from the CLI worth knowing: a POST body is one message. Use
`/batch` for a file of many. The CLI's `convert` and `validate` take files, so
they split multi-message files themselves.

---

## 9. Options you will actually use

| Flag | JS option | Effect |
| --- | --- | --- |
| `--document` | `envelope: 'document'` | bare `<Document>`, no business application header |
| `--now <ts>` | `now` | fix creation timestamps; makes output reproducible |
| `--type 103` | `messageType` | force the type instead of detecting it |
| `--variant COV` | `variant` | force the variant |
| `--address-format <f>` | `addressFormat` | `hybrid` (default), `unstructured`, `structured` |
| `--no-uetr` | `uetr: 'omit'` | do not derive a UETR when the source has none |
| `--reference-year <y>` | `referenceYear` | century window for two digit dates |
| `--strict` | `strict` | a warning is enough to fail the conversion |
| `--compact` | `pretty: false` | no indentation |
| `--json` | — | machine readable output |
| `--quiet` | — | errors only on stderr |

Exit codes: `0` success, `1` conversion or validation problem, `2` usage error.

---

## 10. Troubleshooting

**`Cannot find module '.../dist/src/cli/main.js'`** — the build has not run.
`npm run build`.

**`mt2mx: command not found` after `npm install -g`** — npm's global bin
directory is not on `PATH`. `echo "$(npm prefix -g)/bin"` prints it (`npm bin -g`
was removed in npm 9); add that to `PATH`, or just use
`node dist/src/cli/main.js`.

**Everything converts but confidence sits at 96%** — normal. It is almost always
`MX.UETR_DERIVED`: the source had no UETR in `{3:{121:}}`, so one was derived
from the message content. Pass `--no-uetr` to leave it out instead.

**`DETECT.UNKNOWN` / `CONVERT.NO_MAPPER`** — the message type is not one of the
eleven supported families, or the fields match nothing. `mt2mx list` shows what
is supported; `--type` forces a type when you know it.

**`MT.PARSE.NO_FIELDS`** — the input is not a FIN message. Check it is not
already MX, and that the file is not empty.

**Lots of `MT.FIELD.FORMAT` warnings** — the source really does bend the format
(a field 72 line over 35 characters is the usual culprit). The value is still
interpreted; the warning tells you the sending system is off-spec.

**`MT.PARSE.DUPLICATE_BLOCK` on a file you expected to work** — you passed a
multi-message file to something expecting one message. Use `batch`.

---

## 11. Check your install in one go

```bash
npm test                                          # 182 tests
node dist/src/cli/main.js list                    # 18 conversions
node examples/use-as-library.mjs                  # library tour
node dist/src/cli/main.js batch examples/batch.txt   # 3/3 converted
node dist/src/cli/main.js validate examples/mt103-invalid.txt; echo "exit=$?"  # exit=1
```

If those five behave as described, the converter is working end to end.
