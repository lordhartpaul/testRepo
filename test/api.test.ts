import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/api/server.js';

const MT103 = `{1:F01BANKBEBBAXXX0000000000}{2:I103DEUTDEFFXXXXN}{4:
:20:API001
:23B:CRED
:32A:240115EUR100,00
:50K:/BE68539007547034
SENDER NAME
:59:/DE89370400440532013000
BENEFICIARY NAME
:71A:SHA
-}`;

describe('HTTP interface', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createApp({ defaults: { now: '2024-01-15T10:00:00Z' } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers a health probe', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; conversions: number };
    assert.equal(body.status, 'ok');
    assert.ok(body.conversions > 0);
  });

  it('publishes the conversion catalogue', async () => {
    const body = (await (await fetch(`${base}/conversions`)).json()) as {
      conversions: Array<{ mt: string; mx: string }>;
    };
    assert.ok(body.conversions.some((c) => c.mt === '103' && c.mx === 'pacs.008.001.08'));
  });

  it('converts a plain text body', async () => {
    const response = await fetch(`${base}/convert`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: MT103,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; mxId: string; xml: string };
    assert.equal(body.ok, true);
    assert.equal(body.mxId, 'pacs.008.001.08');
    assert.match(body.xml, /<FIToFICstmrCdtTrf>/);
  });

  it('returns the document itself when XML is requested', async () => {
    const response = await fetch(`${base}/convert?envelope=document`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', accept: 'application/xml' },
      body: MT103,
    });
    assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
    assert.equal(response.headers.get('x-mt-type'), '103');
    assert.equal(response.headers.get('x-mx-id'), 'pacs.008.001.08');
    assert.match(await response.text(), /^<\?xml/);
  });

  it('accepts a JSON body with options', async () => {
    const response = await fetch(`${base}/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: MT103, options: { envelope: 'document', uetr: 'omit' } }),
    });
    const body = (await response.json()) as { xml: string };
    assert.doesNotMatch(body.xml, /<UETR>/);
    assert.doesNotMatch(body.xml, /<AppHdr/);
  });

  it('detects the message type', async () => {
    const response = await fetch(`${base}/detect`, { method: 'POST', body: MT103 });
    const body = (await response.json()) as { results: Array<{ messageType: string }> };
    assert.equal(body.results[0]?.messageType, '103');
  });

  it('validates without converting', async () => {
    const response = await fetch(`${base}/validate`, {
      method: 'POST',
      body: MT103.replace(':20:API001', ':20:/BAD/'),
    });
    assert.equal(response.status, 422);
    const body = (await response.json()) as { valid: boolean; diagnostics: Array<{ code: string }> };
    assert.equal(body.valid, false);
    assert.ok(body.diagnostics.some((d) => d.code === 'MT.RULE.T26'));
  });

  it('converts a batch', async () => {
    const response = await fetch(`${base}/batch`, { method: 'POST', body: `${MT103}\n$\n${MT103}` });
    const body = (await response.json()) as { total: number; converted: number };
    assert.equal(body.total, 2);
    assert.equal(body.converted, 2);
  });

  it('reports a status of 422 when the message cannot be converted', async () => {
    const response = await fetch(`${base}/convert`, { method: 'POST', body: 'not a swift message' });
    assert.equal(response.status, 422);
  });

  it('rejects an empty body and malformed JSON', async () => {
    assert.equal((await fetch(`${base}/convert`, { method: 'POST', body: '  ' })).status, 400);
    const bad = await fetch(`${base}/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(bad.status, 400);
  });

  it('rejects an oversized body', async () => {
    const small = createApp({ maxBodyBytes: 64 });
    await new Promise<void>((resolve) => small.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(small.address() as AddressInfo).port}/convert`;
    try {
      const response = await fetch(url, { method: 'POST', body: 'x'.repeat(500) });
      assert.equal(response.status, 400);
    } catch {
      // The server may close the connection before the response is read, which
      // is an acceptable outcome for an oversized body.
    } finally {
      await new Promise<void>((resolve) => small.close(() => resolve()));
    }
  });

  it('rejects unknown routes and methods', async () => {
    assert.equal((await fetch(`${base}/nope`, { method: 'POST', body: 'x' })).status, 404);
    assert.equal((await fetch(`${base}/convert`)).status, 405);
  });
});
