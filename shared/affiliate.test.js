// Unit tests for the affiliate URL resolver.
// Run with: node --test shared/affiliate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAffiliateUrl, detectRetailer, appendQuery, retailerDisplayName } from './affiliate.js';

const amazonProgram = {
  program: 'amazon',
  config_json: JSON.stringify({ associate_tag: 'will-20' }),
  enabled: 1,
};
const skimlinksProgram = {
  program: 'skimlinks',
  config_json: JSON.stringify({ site_id: '123456' }),
  enabled: 1,
};

test('Amazon URL with no params gets ?tag appended', () => {
  const out = resolveAffiliateUrl({
    retailer: 'amazon',
    rawUrl: 'https://www.amazon.com/dp/B08FSBXT99',
    programs: [amazonProgram],
  });
  assert.match(out, /\?tag=will-20$/);
});

test('Amazon URL with existing params preserves them and adds tag', () => {
  const out = resolveAffiliateUrl({
    retailer: 'amazon',
    rawUrl: 'https://www.amazon.com/dp/B08FSBXT99?ref=cm_sw_r&psc=1',
    programs: [amazonProgram],
  });
  const u = new URL(out);
  assert.equal(u.searchParams.get('ref'), 'cm_sw_r');
  assert.equal(u.searchParams.get('psc'), '1');
  assert.equal(u.searchParams.get('tag'), 'will-20');
});

test('Amazon URL already containing a tag gets overwritten', () => {
  const out = resolveAffiliateUrl({
    retailer: 'amazon',
    rawUrl: 'https://www.amazon.com/dp/B08FSBXT99?tag=other-21',
    programs: [amazonProgram],
  });
  const u = new URL(out);
  assert.equal(u.searchParams.get('tag'), 'will-20');
});

test('Non-Amazon URL with only Amazon program configured passes through', () => {
  const raw = 'https://www.sephora.com/product/some-thing';
  const out = resolveAffiliateUrl({
    retailer: 'sephora',
    rawUrl: raw,
    programs: [amazonProgram],
  });
  assert.equal(out, raw);
});

test('Skimlinks wraps a non-Amazon URL', () => {
  const raw = 'https://www.sephora.com/product/some-thing?sku=123';
  const out = resolveAffiliateUrl({
    retailer: 'sephora',
    rawUrl: raw,
    programs: [skimlinksProgram],
  });
  const u = new URL(out);
  assert.equal(u.hostname, 'go.skimresources.com');
  assert.equal(u.searchParams.get('id'), '123456');
  assert.equal(u.searchParams.get('xs'), '1');
  assert.equal(u.searchParams.get('url'), raw);
});

test('Amazon program takes priority over Skimlinks for amazon retailer', () => {
  const out = resolveAffiliateUrl({
    retailer: 'amazon',
    rawUrl: 'https://www.amazon.com/dp/XYZ',
    programs: [amazonProgram, skimlinksProgram],
  });
  const u = new URL(out);
  assert.equal(u.hostname, 'www.amazon.com');
  assert.equal(u.searchParams.get('tag'), 'will-20');
});

test('No programs configured passes through unchanged', () => {
  const raw = 'https://www.example.com/product/1';
  const out = resolveAffiliateUrl({
    retailer: 'generic',
    rawUrl: raw,
    programs: [],
  });
  assert.equal(out, raw);
});

test('Disabled program is ignored', () => {
  const disabledAmazon = { ...amazonProgram, enabled: 0 };
  const raw = 'https://www.amazon.com/dp/B08FSBXT99';
  const out = resolveAffiliateUrl({
    retailer: 'amazon',
    rawUrl: raw,
    programs: [disabledAmazon],
  });
  assert.equal(out, raw);
});

test('detectRetailer maps domains correctly', () => {
  assert.equal(detectRetailer('https://www.amazon.com/dp/x'), 'amazon');
  assert.equal(detectRetailer('https://amazon.co.uk/dp/x'), 'amazon');
  assert.equal(detectRetailer('https://amzn.to/abc'), 'amazon');
  assert.equal(detectRetailer('https://www.sephora.com/x'), 'sephora');
  assert.equal(detectRetailer('https://en.wikipedia.org/wiki/X'), 'none');
  assert.equal(detectRetailer('https://duckduckgo.com/?q=x'), 'none');
  assert.equal(detectRetailer('https://www.chanel.com/x'), 'generic');
  assert.equal(detectRetailer(''), 'generic');
  assert.equal(detectRetailer(null), 'generic');
});

test('appendQuery preserves existing params', () => {
  const out = appendQuery('https://x.com/y?a=1', { b: '2' });
  const u = new URL(out);
  assert.equal(u.searchParams.get('a'), '1');
  assert.equal(u.searchParams.get('b'), '2');
});

test('retailerDisplayName returns pretty names', () => {
  assert.equal(retailerDisplayName('amazon'), 'Amazon');
  assert.equal(retailerDisplayName('bestbuy'), 'Best Buy');
  assert.equal(retailerDisplayName('unknown'), 'retailer');
});
