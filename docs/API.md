# HTTP interface

```bash
npm run serve                      # PORT=8080 HOST=0.0.0.0 by default
docker run -p 8080:8080 mt2mx
```

The body of a POST is either the raw MT text (`Content-Type: text/plain`, the
default) or JSON:

```json
{ "message": "{1:F01...}", "options": { "envelope": "document", "uetr": "omit" } }
```

A few options are also accepted as query parameters: `type`, `variant`,
`envelope`, `addressFormat`, `now`, `strict`.

## Routes

### `GET /health`

```json
{ "status": "ok", "conversions": 18 }
```

### `GET /conversions`

```json
{ "conversions": [ { "mt": "103", "mx": "pacs.008.001.08", "description": "Single customer credit transfer" } ] }
```

### `POST /convert`

`200` when the conversion succeeded, `422` when it did not — **with the
diagnostics either way**, because a failed conversion is the case you most need
to see.

```json
{
  "ok": true,
  "messageType": "103",
  "mxId": "pacs.008.001.08",
  "confidence": {
    "score": 0.92,
    "band": "high",
    "factors": [
      { "label": "message type detection", "impact": 0, "detail": "the type was read from the application header" },
      { "label": "warning diagnostics", "impact": -0.08, "detail": "1 warning raised during conversion" }
    ]
  },
  "coverage": { "total": 11, "mapped": 11, "unmapped": [] },
  "detection": { "source": "header", "confidence": 1, "candidates": [] },
  "rulesChecked": ["T26", "T27", "C1", "C2", "C3", "C13", "C14", "C03"],
  "diagnostics": [
    {
      "code": "MX.UETR_DERIVED",
      "severity": "warning",
      "message": "The source carries no UETR; … was derived from the message content.",
      "mxPath": "PmtId/UETR",
      "hint": "Derivation is deterministic, so a replay of the same MT produces the same UETR.",
      "confidenceCost": 0.04
    }
  ],
  "xml": "<?xml version=\"1.0\" …"
}
```

With `Accept: application/xml` the document is returned directly, and the
metadata moves into headers:

```
X-MT-Type: 103
X-MX-Id: pacs.008.001.08
X-Confidence: 0.920
```

### `POST /batch`

Accepts RJE files (`$` separated) or concatenated FIN blocks.

```json
{
  "total": 3,
  "converted": 3,
  "failed": 0,
  "averageConfidence": 0.96,
  "topDiagnostics": [ { "code": "MX.UETR_DERIVED", "count": 3 } ],
  "items": [ { "index": 0, "ok": true, "mxId": "pacs.008.001.08", "xml": "…" } ]
}
```

### `POST /detect`

```json
{
  "results": [
    {
      "index": 0,
      "messageType": "940",
      "source": "content",
      "confidence": 1,
      "candidates": [
        { "messageType": "940", "score": 1, "reasons": ["statement number with opening and closing balances"] },
        { "messageType": "942", "score": 0.09, "reasons": ["missing mandatory 34F, 13D"] }
      ],
      "diagnostics": []
    }
  ]
}
```

### `POST /validate`

MT validation only — no conversion. `200` when valid, `422` when not.

```json
{
  "messageType": "103",
  "valid": false,
  "errorCount": 1,
  "rulesChecked": ["T26", "T27", "C1", "C2", "C3", "C13", "C14", "C03"],
  "diagnostics": [
    { "code": "MT.RULE.T26", "severity": "error", "mtTag": "20", "message": "Reference '/BAD/' must not start or end with '/' nor contain '//'." }
  ]
}
```

## Errors

| Status | When |
| --- | --- |
| `400` | empty body, malformed JSON, or a body over the size limit (5 MB by default) |
| `404` | unknown route |
| `405` | wrong method for the route |
| `422` | the message could not be converted or failed validation |
| `500` | an unexpected error, with its message in `detail` |

## Operational notes

- **Stateless.** Nothing is written to disk and nothing is retained between
  requests, so it scales horizontally without coordination.
- **Reproducible.** Send `now` and the same message always yields the same
  document — useful for idempotent reprocessing and for diffing releases.
- **No runtime dependencies.** The server is `node:http`; the image is the
  compiled output on `node:22-alpine` and nothing else.
- **Message content is not logged.** Only the process start line is written to
  stdout; diagnostics travel in the response.
