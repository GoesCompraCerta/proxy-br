import assert from 'node:assert/strict';
import { test } from 'node:test';
import handler, {
  extractAmazonProductUrlFromHtml,
  extractMagaluProductUrlFromHtml,
  extractShopeeUrlFromHtml
} from './proxy.js';

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

test('extracts Amazon product URLs from og:url and canonical metadata', () => {
  assert.equal(
    extractAmazonProductUrlFromHtml(
      '<meta property="og:url" content="https://www.amazon.com.br/dp/B0ABCDEFGH?ref_=share">'
    ),
    'https://www.amazon.com.br/dp/B0ABCDEFGH?ref_=share'
  );
  assert.equal(
    extractAmazonProductUrlFromHtml(
      '<link rel="canonical" href="https://www.amazon.com.br/gp/product/B0ABCDEFGH">'
    ),
    'https://www.amazon.com.br/gp/product/B0ABCDEFGH'
  );
});

test('extracts escaped Amazon product URLs from scripts', () => {
  assert.equal(
    extractAmazonProductUrlFromHtml(
      String.raw`<script>{"url":"https:\/\/www.amazon.com.br\/dp\/B0ABCDEFGH?tag=old-20\u0026ref_=share"}</script>`
    ),
    'https://www.amazon.com.br/dp/B0ABCDEFGH?tag=old-20&ref_=share'
  );
});

test('rejects Amazon home pages and short links as product URLs', () => {
  assert.equal(
    extractAmazonProductUrlFromHtml('<meta property="og:url" content="https://www.amazon.com.br/">'),
    null
  );
  assert.equal(
    extractAmazonProductUrlFromHtml('<meta property="og:url" content="https://amzn.to/3example">'),
    null
  );
  assert.equal(
    extractAmazonProductUrlFromHtml('<html><body>No product link</body></html>'),
    null
  );
});

test('resolves amzlink.to and amzlink.com short links through the proxy', async () => {
  const originalFetch = globalThis.fetch;
  const productUrl = 'https://www.amazon.com.br/dp/B0ABCDEFGH';
  globalThis.fetch = async (input) => {
    const requestUrl = new URL(String(input));
    assert.ok(['amzlink.to', 'amzlink.com'].includes(requestUrl.hostname));
    return new Response(
      `<meta property="og:url" content="${productUrl}">`,
      { status: 200, headers: { 'content-type': 'text/html' } }
    );
  };

  try {
    for (const host of ['amzlink.to', 'amzlink.com']) {
      let payload;
      const res = {
        setHeader() {},
        status(code) {
          assert.equal(code, 200);
          return this;
        },
        json(value) {
          payload = value;
          return this;
        },
        end() {
          return this;
        }
      };
      await handler({
        method: 'GET',
        query: { url: `https://${host}/example` }
      }, res);
      assert.equal(payload.debug_url, productUrl);
      assert.equal(payload.shopeeHTTP, 200);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolves amzn.divulgador.link and preserves encoded Amazon query characters', async () => {
  const originalFetch = globalThis.fetch;
  const shortUrl =
    'https://amzn.divulgador.link/offer?target=https%3A%2F%2Famazon.com.br%2Fdp%2FB0ABCDEFGH%3Fref%3Dsocial%26x%3D1&campaign=caf%C3%A9%20%26%20frete';
  const destinationUrl =
    'https://www.amazon.com.br/dp/B0ABCDEFGH?ref_=share%20link&campaign=caf%C3%A9%20%26%20livros&note=tea%2Bcoffee';
  const encodedDestinationForHtml = destinationUrl.replaceAll('&', '&amp;');
  const requestedUrls = [];
  globalThis.fetch = async (input) => {
    const requestUrl = new URL(String(input));
    requestedUrls.push(requestUrl);
    assert.equal(requestUrl.hostname, 'amzn.divulgador.link');
    assert.equal(requestUrl.searchParams.get('target'),
      'https://amazon.com.br/dp/B0ABCDEFGH?ref=social&x=1');
    return new Response(
      `<meta property="og:url" content="${encodedDestinationForHtml}">`,
      { status: 200, headers: { 'content-type': 'text/html' } }
    );
  };
  let responseStatus = 0;
  let payload;
  const res = {
    setHeader() {},
    status(code) {
      responseStatus = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
    end() {
      return this;
    }
  };

  try {
    await handler({ method: 'GET', query: { url: shortUrl } }, res);
    assert.equal(responseStatus, 200);
    assert.equal(payload.debug_url, destinationUrl);
    assert.equal(requestedUrls.length, 1);
    assert.equal(requestedUrls[0].toString(), new URL(shortUrl).toString());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects subdomains of the exact amzn.divulgador.link alias', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('unexpected');
  };
  let responseStatus = 0;
  const res = {
    setHeader() {},
    status(code) {
      responseStatus = code;
      return this;
    },
    json() {
      return this;
    }
  };
  try {
    await handler({
      method: 'GET',
      query: { url: 'https://offers.amzn.divulgador.link/example' }
    }, res);
    assert.equal(responseStatus, 400);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('extracts Magalu product URLs from og:url, canonical, and product links', () => {
  const expected = 'https://www.magazineluiza.com.br/p/produto/123';
  assert.equal(
    extractMagaluProductUrlFromHtml(
      `<meta property="og:url" content="${expected}?utm_source=old">`
    ),
    `${expected}?utm_source=old`
  );
  assert.equal(
    extractMagaluProductUrlFromHtml(
      `<link rel="canonical" href="${expected}">`
    ),
    expected
  );
  assert.equal(
    extractMagaluProductUrlFromHtml(
      `<a href="${expected}">Produto</a>`
    ),
    expected
  );
});

test('extracts escaped Magalu product URLs from HTML metadata', () => {
  assert.equal(
    extractMagaluProductUrlFromHtml(
      String.raw`<meta property="og:url" content="https:\/\/www.magazinevoce.com.br\/magazineLoja\/p\/item?x=1\u0026y=2">`
    ),
    'https://www.magazinevoce.com.br/magazineLoja/p/item?x=1&y=2'
  );
});

test('rejects Magalu home pages, short links, and non-Magalu URLs', () => {
  assert.equal(
    extractMagaluProductUrlFromHtml(
      '<meta property="og:url" content="https://www.magazineluiza.com.br/">'
    ),
    null
  );
  assert.equal(
    extractMagaluProductUrlFromHtml(
      '<meta property="og:url" content="https://divulgador.magalu.com/short">'
    ),
    null
  );
  assert.equal(
    extractMagaluProductUrlFromHtml(
      '<a href="https://example.com/p/produto">Produto</a>'
    ),
    null
  );
});

test('Magalu short-link HTML fallback preserves the proxy response shape', async () => {
  const originalFetch = globalThis.fetch;
  const productUrl = 'https://www.magazineluiza.com.br/p/produto/123';
  globalThis.fetch = async () => new Response(
    `<link rel="canonical" href="${productUrl}">`,
    { status: 200, headers: { 'content-type': 'text/html' } }
  );
  let responseStatus = 0;
  let payload;
  const res = {
    setHeader() {},
    status(code) {
      responseStatus = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
    end() {
      return this;
    }
  };
  try {
    await handler({
      method: 'GET',
      query: { url: 'https://divulgador.magalu.com/short' }
    }, res);
    assert.equal(responseStatus, 200);
    assert.equal(payload.debug_url, productUrl);
    assert.equal(payload.shopeeHTTP, 200);
    assert.ok(Object.hasOwn(payload, 'serverRegion'));
    assert.ok(Object.hasOwn(payload, 'debug_html_snippet'));
    assert.ok(Object.hasOwn(payload, 'imageUrl'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
