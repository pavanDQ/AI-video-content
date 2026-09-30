/**
 * Same-origin proxy for images found in source content.
 *
 * A canvas that draws a cross-origin image without CORS headers becomes
 * "tainted", and a tainted canvas cannot be recorded. CMS image hosts rarely
 * send CORS headers, so the browser loads source images through this proxy.
 *
 * Because the server fetches URLs supplied by the client, it refuses anything
 * that is not a public http(s) raster image, re-checking every redirect hop.
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** Raster formats only: SVG can carry script and is not needed for figures. */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

const PRIVATE = new BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([network, prefix]) => PRIVATE.addSubnet(network, prefix, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]
  .forEach(([network, prefix]) => PRIVATE.addSubnet(network, prefix, 'ipv6'));

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function isPrivateAddress(address, family) {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be judged as the IPv4 it wraps.
  const mapped = family === 6 && address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
  return PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, 'Invalid image URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpError(400, 'Only http(s) images are allowed.');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => { throw httpError(502, 'Image host could not be resolved.'); });
  if (!addresses.length || addresses.some(({ address, family }) => isPrivateAddress(address, family))) {
    throw httpError(403, 'Image host is not allowed.');
  }
  return url;
}

/** @returns {Promise<{ body: Buffer, contentType: string }>} */
export async function fetchPublicImage(raw) {
  let url = await assertPublicUrl(raw);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' }
    }).catch(() => { throw httpError(502, 'Image could not be fetched.'); });

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = await assertPublicUrl(new URL(response.headers.get('location'), url).href);
      continue;
    }
    if (!response.ok) throw httpError(502, `Image host answered ${response.status}.`);

    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) throw httpError(415, 'URL is not a supported image.');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw httpError(413, 'Image is too large.');

    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw httpError(413, 'Image is too large.');
      chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks), contentType };
  }

  throw httpError(502, 'Too many redirects.');
}
