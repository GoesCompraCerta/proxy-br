import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractShopeeUrlFromHtml } from './proxy.js';

const productUrl =
  'https://shopee.com.br/opaanlp/402093902/23793620725?__mobile__=1&x=1';

const fixtures = [
  [
    'CONFIG.httpUrl escaped in JavaScript',
    String.raw`<script>var CONFIG={httpUrl:"https:\/\/shopee.com.br\/opaanlp\/402093902\/23793620725?__mobile__=1\u0026x=1"};</script>`,
    productUrl
  ],
  [
    'og:url',
    '<meta property="og:url" content="https://shopee.com.br/product/402093902/23793620725">',
    'https://shopee.com.br/product/402093902/23793620725'
  ],
  [
    'canonical link',
    '<link rel="canonical" href="https://shopee.com.br/product/402093902/23793620725">',
    'https://shopee.com.br/product/402093902/23793620725'
  ],
  [
    'meta refresh',
    '<meta http-equiv="refresh" content="0; url=https://shopee.com.br/opaanlp/402093902/23793620725">',
    'https://shopee.com.br/opaanlp/402093902/23793620725'
  ],
  [
    'URL escaped in JSON',
    String.raw`<script>{"url":"https:\/\/shopee.com.br\/product\/402093902/23793620725"}</script>`,
    'https://shopee.com.br/product/402093902/23793620725'
  ],
  [
    'HTML ampersand entity',
    '<meta property="og:url" content="https://shopee.com.br/product/402093902/23793620725?a=1&amp;b=2">',
    'https://shopee.com.br/product/402093902/23793620725?a=1&b=2'
  ]
];

for (const [description, html, expected] of fixtures) {
  test(`extracts product URL from ${description}`, () => {
    assert.equal(extractShopeeUrlFromHtml(html), expected);
  });
}

test('rejects Shopee home page and short URL', () => {
  assert.equal(
    extractShopeeUrlFromHtml('<meta property="og:url" content="https://shopee.com.br/">'),
    null
  );
  assert.equal(
    extractShopeeUrlFromHtml('<meta property="og:url" content="https://s.shopee.com.br/abc">'),
    null
  );
});

test('returns null when the page contains no product URL', () => {
  assert.equal(extractShopeeUrlFromHtml('<html><body>No product link</body></html>'), null);
});
