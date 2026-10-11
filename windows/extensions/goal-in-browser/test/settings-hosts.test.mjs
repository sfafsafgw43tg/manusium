import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHost, isListed, normalizeHost, parseDomainList, removeHost, siteHost } from '../dist/hosts.js';


test('normalizeHost lowercases, strips one trailing dot, and accepts ASCII names with a dot', () => {
  assert.equal(normalizeHost('Example.COM.'), 'example.com');
  assert.equal(normalizeHost('  sub.example.co.uk  '), 'sub.example.co.uk');
  assert.equal(normalizeHost('xn--mnchen-3ya.de'), 'xn--mnchen-3ya.de');
});

test('normalizeHost rejects IP literals, single labels, and non-ASCII names', () => {
  const bad = ['localhost', '192.168.1.1', '[::1]', 'exa mple.com', 'münchen.de', 'example..com', '-bad.com', `${'a'.repeat(64)}.com`, ''];
  for (const entry of bad) assert.equal(normalizeHost(entry), null, entry);
});

test('siteHost accepts only http and https pages', () => {
  assert.equal(siteHost('https://Shop.Example.com/cart?x=1'), 'shop.example.com');
  assert.equal(siteHost('http://example.org:8080/'), 'example.org');
  const other = ['chrome://settings', 'chrome-extension://abc/popup.html', 'file:///home/user/a.html', 'about:blank', 'http://localhost:3000/', 'https://192.168.0.1/', undefined, 'not a url'];
  for (const url of other) assert.equal(siteHost(url), null, String(url));
});

test('isListed matches a host and its subdomains, never a look-alike suffix', () => {
  const list = ['example.com'];
  assert.equal(isListed(list, 'example.com'), true);
  assert.equal(isListed(list, 'a.b.example.com'), true);
  assert.equal(isListed(list, 'notexample.com'), false);
  assert.equal(isListed(list, 'example.com.evil.net'), false);
  assert.equal(isListed(['shop.example.com'], 'example.com'), false);
  assert.equal(isListed([], 'example.com'), false);
});

test('addHost keeps the list unique and sorted; removeHost removes exactly one host', () => {
  assert.deepEqual(addHost(['b.com'], 'a.com'), ['a.com', 'b.com']);
  assert.deepEqual(addHost(['a.com'], 'a.com'), ['a.com']);
  assert.deepEqual(removeHost(['a.com', 'b.com'], 'a.com'), ['b.com']);
});

test('parseDomainList splits pasted text, strips wildcards, and reports invalid entries', () => {
  const { valid, invalid } = parseDomainList('ads.example.com, *.track.net\nhttps://bad.com/path 10.0.0.1 localhost ads.example.com');
  assert.deepEqual(valid, ['ads.example.com', 'track.net']);
  assert.deepEqual(invalid, ['https://bad.com/path', '10.0.0.1', 'localhost']);
});
