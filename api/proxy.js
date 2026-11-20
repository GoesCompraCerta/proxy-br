const ALLOWED_HOSTS = [
  'shopee.com.br',
  'shopee.com',
  's.shopee.com.br',
  'shopee.promo',
  'shopee.ee',
  'shp.ee',
  'sho.pe'
];
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 500 * 1024;
const SHORT_HOSTS = new Set([
  'shopee.promo',
  's.shopee.com.br',
  'shopee.ee',
  'shope.ee',
  'shp.ee',
  'sho.pe'
]);
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

function isAllowedShopeeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' &&
    ALLOWED_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

async function readHtml(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Shopee returned an empty response');

  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new Error('Shopee HTML response exceeded the size limit');
      }
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
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the candidate unchanged if it contains malformed percent-encoding.
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const rawUrl = typeof req.query?.url === 'string' ? req.query.url : '';
  if (!rawUrl) return res.status(400).json({ error: 'missing url' });
  if (!isAllowedShopeeUrl(rawUrl)) {
    return res.status(400).json({ error: 'url must be an HTTPS Shopee link' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const { response, url } = await fetchShopeePage(rawUrl, controller.signal);
    const html = await readHtml(response);
    const extractedUrl = isShopeeShortUrl(url.toString())
      ? extractShopeeUrlFromHtml(html)
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
