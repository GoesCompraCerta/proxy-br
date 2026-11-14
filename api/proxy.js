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
const MAX_HTML_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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
    return res.status(200).json({
      serverRegion: process.env.VERCEL_REGION ?? 'gru1',
      shopeeHTTP: response.status,
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
