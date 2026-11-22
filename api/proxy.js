import { timingSafeEqual } from 'node:crypto';

const ALLOWED_HOSTS = [
  'shopee.com.br',
  'shopee.com',
  's.shopee.com.br',
  'shopee.promo',
  'shopee.ee',
  'shp.ee',
  'sho.pe',
  'amazon.com.br',
  'amazon.com',
  'amzn.to',
  'amzn.com',
  'a.co',
  'amzn.divulgador.link',
  'amzlink.to',
  'amzlink.com',
  'magazineluiza.com.br',
  'magazinevoce.com.br',
  'divulgador.magalu.com',
  'magalu.me',
  'maga.lu',
  'magalu.com.br'
];
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 500 * 1024;
const MAX_AMAZON_HTML_BYTES = 1024 * 1024;
const MAX_MAGALU_HTML_BYTES = 1024 * 1024;
const SHORT_HOSTS = new Set([
  'shopee.promo',
  's.shopee.com.br',
  'shopee.ee',
  'shope.ee',
  'shp.ee',
  'sho.pe'
]);
const AMAZON_SHORT_HOSTS = new Set([
  'amzn.to',
  'amzn.com',
  'a.co',
  'amzlink.to',
  'amzlink.com',
  'amzn.divulgador.link'
]);
const EXACT_ALLOWED_HOSTS = new Set(['amzn.divulgador.link']);
const MAGALU_SHORT_HOSTS = new Set([
  'divulgador.magalu.com',
  'magalu.me',
  'maga.lu'
]);
const MAGALU_PRODUCT_HOSTS = new Set([
  'magazineluiza.com.br',
  'www.magazineluiza.com.br',
  'magazinevoce.com.br',
  'www.magazinevoce.com.br'
]);
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const MERCADO_LIVRE_PROXY_HOSTS = ['mercadolivre.com.br', 'mercadolivre.com'];
const MERCADO_LIVRE_PROXY_REQUEST_HEADERS = [
  'cookie',
  'x-csrf-token',
  'user-agent',
  'origin',
  'referer',
  'accept',
  'content-type'
];
const MERCADO_LIVRE_PROXY_RESPONSE_HEADERS = [
  'content-type',
  'location',
  'x-csrf-token',
  'csrf-token'
];
const MERCADO_LIVRE_PROXY_TIMEOUT_MS = 12_000;

function isMercadoLivreProxyTarget(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' &&
      (url.port === '' || url.port === '443') &&
      !url.username &&
      !url.password &&
      MERCADO_LIVRE_PROXY_HOSTS.some((domain) =>
        hostname === domain || hostname.endsWith(`.${domain}`)
      );
  } catch {
    return false;
  }
}

function matchesProxySecret(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function parseMercadoLivreProxyBody(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function handleMercadoLivreProxy(req, res) {
  const expectedSecret = process.env.PROXY_SECRET;
  if (!expectedSecret) {
    return res.status(503).json({ error: 'proxy authentication is not configured' });
  }
  if (!matchesProxySecret(expectedSecret, req.headers?.['x-proxy-secret'])) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const payload = parseMercadoLivreProxyBody(req.body);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'invalid request body' });
  }

  const targetMethod = typeof payload.method === 'string'
    ? payload.method.toUpperCase()
    : '';
  if (
    !isMercadoLivreProxyTarget(payload.url) ||
    !['GET', 'POST'].includes(targetMethod) ||
    (payload.body !== undefined && typeof payload.body !== 'string') ||
    (targetMethod === 'GET' && payload.body !== undefined)
  ) {
    return res.status(400).json({ error: 'invalid Mercado Livre proxy request' });
  }

  const targetHeaders = {};
  if (payload.headers && typeof payload.headers === 'object' && !Array.isArray(payload.headers)) {
    for (const [name, value] of Object.entries(payload.headers)) {
      const normalizedName = name.toLowerCase();
      if (
        MERCADO_LIVRE_PROXY_REQUEST_HEADERS.includes(normalizedName) &&
        typeof value === 'string'
      ) {
        targetHeaders[normalizedName] = value;
      }
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MERCADO_LIVRE_PROXY_TIMEOUT_MS);
  try {
    const upstream = await fetch(payload.url, {
      method: targetMethod,
      headers: targetHeaders,
      ...(payload.body === undefined ? {} : { body: payload.body }),
      redirect: 'manual',
      signal: controller.signal
    });
    const responseHeaders = {};
    for (const name of MERCADO_LIVRE_PROXY_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    const extendedHeaders = upstream.headers;
    const setCookie = typeof extendedHeaders.getSetCookie === 'function'
      ? extendedHeaders.getSetCookie()
      : (upstream.headers.get('set-cookie') ?? '')
          .split(/,(?=\s*[^;,=\s]+=[^;,]*)/)
          .filter(Boolean);

    return res.status(200).json({
      status: upstream.status,
      headers: responseHeaders,
      setCookie,
      body: await upstream.text()
    });
  } catch (error) {
    const status = error instanceof Error && error.name === 'AbortError' ? 504 : 502;
    return res.status(status).json({ error: 'Mercado Livre upstream request failed' });
  } finally {
    clearTimeout(timeout);
  }
}

function isAllowedShopeeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return url.protocol === 'https:' &&
    ALLOWED_HOSTS.some((host) =>
      hostname === host ||
      (!EXACT_ALLOWED_HOSTS.has(host) && hostname.endsWith(`.${host}`))
    );
}

async function readHtml(response, maxBytes = MAX_HTML_BYTES, truncateAtLimit = false) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Shopee returned an empty response');

  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        if (truncateAtLimit) {
          chunks.push(value.subarray(0, maxBytes - size));
          size = maxBytes;
          await reader.cancel();
          break;
        }
        await reader.cancel();
        throw new Error('Shopee HTML response exceeded the size limit');
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function getAttribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return tag.match(new RegExp(`\\b${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
}

function decodeCandidate(value) {
  let decoded = value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&#x26;?/gi, '&')
    .replace(/&#38;?/g, '&')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/');
  if (/^https?%3A%2F%2F/i.test(decoded)) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep the candidate unchanged if it contains malformed percent-encoding.
    }
  }
  return decoded;
}

function isShopeeShortUrl(value) {
  try {
    return SHORT_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isShopeeProductUrl(value) {
  let url;
  try {
    url = new URL(decodeCandidate(value));
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    !['shopee.com.br', 'www.shopee.com.br'].includes(url.hostname.toLowerCase()) ||
    isShopeeShortUrl(url.toString())
  ) return false;

  return /-i\.\d+\.\d+(?:\/|$)/i.test(url.pathname) ||
    /^\/(?:product|opaanlp)\/\d+\/\d+(?:\/|$)/i.test(url.pathname);
}

function isAmazonShortUrl(value) {
  try {
    return AMAZON_SHORT_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isAmazonProductUrl(value) {
  let url;
  try {
    url = new URL(decodeCandidate(value));
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    !['amazon.com.br', 'www.amazon.com.br'].includes(url.hostname.toLowerCase()) ||
    isAmazonShortUrl(url.toString())
  ) return false;

  return /\/(?:dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}(?:\/|$)/i.test(url.pathname);
}

export function extractAmazonProductUrlFromHtml(html) {
  const candidates = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property = getAttribute(tag, 'property')?.toLowerCase();
    const name = getAttribute(tag, 'name')?.toLowerCase();
    if (property === 'og:url' || name === 'og:url') {
      const content = getAttribute(tag, 'content');
      if (content) candidates.push(content);
    }
  }

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = getAttribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    const href = getAttribute(tag, 'href');
    if (rel.includes('canonical') && href) candidates.push(href);
  }

  for (const match of html.matchAll(/https?:[^\s"'<>]+/gi)) {
    candidates.push(match[0]);
  }

  for (const candidate of candidates) {
    const decoded = decodeCandidate(candidate);
    if (isAmazonProductUrl(decoded)) return new URL(decoded).toString();
  }
  return null;
}

function isMagaluShortUrl(value) {
  try {
    return MAGALU_SHORT_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isMagaluProductUrl(value) {
  let url;
  try {
    url = new URL(decodeCandidate(value));
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    !MAGALU_PRODUCT_HOSTS.has(url.hostname.toLowerCase()) ||
    isMagaluShortUrl(url.toString())
  ) return false;

  return url.pathname.split('/').some((segment) => segment.toLowerCase() === 'p');
}

export function extractMagaluProductUrlFromHtml(html) {
  const candidates = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property = getAttribute(tag, 'property')?.toLowerCase();
    const name = getAttribute(tag, 'name')?.toLowerCase();
    if (property === 'og:url' || name === 'og:url') {
      const content = getAttribute(tag, 'content');
      if (content) candidates.push(content);
    }
  }

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = getAttribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    const href = getAttribute(tag, 'href');
    if (rel.includes('canonical') && href) candidates.push(href);
  }

  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = getAttribute(match[0], 'href');
    if (href) candidates.push(href);
  }

  for (const match of html.matchAll(/https?:[^\s"'<>]+/gi)) {
    candidates.push(match[0]);
  }

  for (const candidate of candidates) {
    const decoded = decodeCandidate(candidate);
    if (isMagaluProductUrl(decoded)) return new URL(decoded).toString();
  }
  return null;
}

export function extractShopeeUrlFromHtml(html) {
  const candidates = [];
  const configUrl = html.match(
    /\bCONFIG\s*=\s*\{[\s\S]{0,20000}?\bhttpUrl\s*:\s*(["'])(.*?)\1/i
  )?.[2];
  if (configUrl) candidates.push(configUrl);

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property = getAttribute(tag, 'property')?.toLowerCase();
    const name = getAttribute(tag, 'name')?.toLowerCase();
    if (property === 'og:url' || name === 'og:url') {
      const content = getAttribute(tag, 'content');
      if (content) candidates.push(content);
    }
  }

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = getAttribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    const href = getAttribute(tag, 'href');
    if (rel.includes('canonical') && href) candidates.push(href);
  }

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (getAttribute(tag, 'http-equiv')?.toLowerCase() !== 'refresh') continue;
    const content = getAttribute(tag, 'content');
    const refreshUrl = content?.match(
      /\burl\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/i
    );
    const candidate = refreshUrl?.[1] ?? refreshUrl?.[2] ?? refreshUrl?.[3];
    if (candidate) candidates.push(candidate);
  }

  for (const match of html.matchAll(/https?:[^\s"'<>]+/gi)) {
    candidates.push(match[0]);
  }

  for (const candidate of candidates) {
    const decoded = decodeCandidate(candidate);
    if (isShopeeProductUrl(decoded)) return new URL(decoded).toString();
  }
  return null;
}

function getOgImage(html, pageUrl) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (getAttribute(tag, 'property')?.toLowerCase() !== 'og:image') continue;
    const content = getAttribute(tag, 'content');
    if (!content) return null;
    try {
      const imageUrl = new URL(content.replace(/&amp;/gi, '&'), pageUrl);
      return imageUrl.protocol === 'https:' ? imageUrl.toString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchShopeePage(initialUrl, signal) {
  let url = new URL(initialUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!isAllowedShopeeUrl(url.toString())) {
      throw new Error('URL or redirect is outside the Shopee domain allowlist');
    }
    const response = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        Accept: 'text/html'
      }
    });
    if (response.status < 300 || response.status >= 400) {
      return { response, url };
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Shopee redirect did not include a destination');
    if (redirects === MAX_REDIRECTS) throw new Error('Too many Shopee redirects');
    url = new URL(location, url);
  }
  throw new Error('Could not resolve Shopee page');
}

export const config = { regions: ['gru1'] };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Secret');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'POST') return handleMercadoLivreProxy(req, res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const rawUrl = typeof req.query?.url === 'string' ? req.query.url : '';
  if (!rawUrl) return res.status(400).json({ error: 'missing url' });
  if (!isAllowedShopeeUrl(rawUrl)) {
    return res.status(400).json({
      error: 'url must be an HTTPS Shopee, Amazon or Magalu link'
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const { response, url } = await fetchShopeePage(rawUrl, controller.signal);
    const amazonShortRequest = isAmazonShortUrl(rawUrl);
    const magaluShortRequest = isMagaluShortUrl(rawUrl);
    const html = amazonShortRequest
      ? await readHtml(response, MAX_AMAZON_HTML_BYTES, true)
      : magaluShortRequest
        ? await readHtml(response, MAX_MAGALU_HTML_BYTES, true)
        : await readHtml(response);
    const extractedUrl = isShopeeShortUrl(url.toString())
      ? extractShopeeUrlFromHtml(html)
      : isAmazonShortUrl(url.toString())
        ? extractAmazonProductUrlFromHtml(html)
        : isMagaluShortUrl(url.toString())
          ? extractMagaluProductUrlFromHtml(html)
          : null;
    return res.status(200).json({
      serverRegion: process.env.VERCEL_REGION ?? 'gru1',
      shopeeHTTP: response.status,
      debug_url: extractedUrl ?? url.toString(),
      debug_html_snippet: html.substring(0, 300),
      imageUrl: getOgImage(html, url)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'request failed';
    const status = error instanceof Error && error.name === 'AbortError' ? 504 : 502;
    return res.status(status).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}
