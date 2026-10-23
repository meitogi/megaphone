// Threads, the Facebook page and Instagram through Meta's Graph APIs. CLI and
// Action only : none of these endpoints answers a browser (no CORS). fetch,
// FormData, URLSearchParams and Blob only : no Node API, no DOM.
// Versions and hosts read off developers.facebook.com on 2026-10-23.
import { call, followUp } from './http.mjs';

export const GRAPH = 'https://graph.facebook.com/v26.0';
// The token endpoints (exchange, refresh) sit at the host root, unversioned.
export const THREADS_HOST = 'https://graph.threads.com';
export const THREADS = `${THREADS_HOST}/v1.0`;
// A media container is read until FINISHED : every POLL_MS, at most POLL_MAX times
// (Instagram's doc : once a minute for up to five minutes ; Threads : about 30 s).
export const POLL_MS = 10000;
export const POLL_MAX = 30;

// Graph takes the token as a query parameter. record() redacts URLs and the creds
// themselves, so it never reaches a `failed` line.
const withToken = (url, token) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;

// Threads and Instagram fetch the image themselves : the committed file on
// raw.githubusercontent.com, as Dev.to's cover. Without the repository there is
// no public URL, and a text-only post would be a silent downgrade.
function imageUrl(network, post, repository) {
  if (!repository) throw new Error(`${network} : needs GITHUB_REPOSITORY for the image URL`);
  return `https://raw.githubusercontent.com/${repository}/main/posts/${post.meta.image}`;
}

// Reads `url` until its `field` says FINISHED. ERROR and EXPIRED are final ; the
// `detail` field carries the server's reason. Nothing is published yet here, so
// throwing is safe.
async function ready(f, what, url, field, detail, sleep) {
  for (let i = 0; ; i++) {
    const j = await (await call(f, `${what} container`, url)).json();
    const s = j[field];
    if (s === 'FINISHED' || s === 'PUBLISHED') return;
    if (s === 'ERROR' || s === 'EXPIRED') throw new Error(`${what} container : ${s}${j[detail] ? ` ${j[detail]}` : ''}`);
    if (i === POLL_MAX) throw new Error(`${what} container : still ${s || 'processing'} after ${POLL_MAX} reads`);
    await sleep(POLL_MS);
  }
}

// Container (TEXT, or IMAGE by URL), status, publish, then the permalink as a
// follow-up. threads_basic + threads_content_publish.
async function threads(text, { creds, image, f, sleep, repository, post }) {
  const token = creds.threadsToken;
  const me = `${THREADS}/${creds.threadsUserId}`;
  const form = new URLSearchParams({ media_type: image ? 'IMAGE' : 'TEXT', text });
  if (image) form.set('image_url', imageUrl('threads', post, repository));
  const { id } = await (await call(f, 'threads container', withToken(`${me}/threads`, token), { method: 'POST', body: form })).json();
  await ready(f, 'threads', withToken(`${THREADS}/${id}?fields=status,error_message`, token), 'status', 'error_message', sleep);
  const pub = await (await call(f, 'threads publish', withToken(`${me}/threads_publish`, token), { method: 'POST', body: new URLSearchParams({ creation_id: id }) })).json();
  // Published either way : without an id there is nothing more to read.
  if (!pub.id) return { url: 'ok threads', note: 'no id in the publish answer' };
  return followUp(`ok ${pub.id}`, async () => (await (await call(f, 'threads permalink', withToken(`${THREADS}/${pub.id}?fields=permalink`, token))).json()).permalink);
}

// /photos with the bytes (multipart `source`), or /feed for text ; the link, which
// render() took out of the text, goes in a first comment. pages_manage_posts,
// pages_read_engagement, pages_manage_engagement (the comment).
async function facebook(text, { creds, image, f, post }) {
  const token = creds.fbPageToken;
  const page = `${GRAPH}/${creds.fbPageId}`;
  let postId;
  if (image) {
    const form = new FormData();
    form.append('source', new Blob([image.bytes], { type: image.type }), image.name);
    form.append('message', text);
    const photo = await (await call(f, 'facebook photo', withToken(`${page}/photos`, token), { method: 'POST', body: form })).json();
    postId = photo.post_id || photo.id;
  } else {
    postId = (await (await call(f, 'facebook post', withToken(`${page}/feed`, token), { method: 'POST', body: new URLSearchParams({ message: text }) })).json()).id;
  }
  if (!postId) return { url: 'ok facebook', note: 'no id in the answer' };
  const url = `https://www.facebook.com/${postId}`;
  const link = post.meta.link;
  if (!link) return { url };
  return followUp(url, () => call(f, 'facebook comment', withToken(`${GRAPH}/${postId}/comments`, token), { method: 'POST', body: new URLSearchParams({ message: link }) }));
}

// Container by image URL, status, publish, permalink as a follow-up. Same page
// token as Facebook ; instagram_basic + instagram_content_publish. The API takes
// JPEG only, from a public URL.
async function instagram(text, { creds, image, f, sleep, repository, post }) {
  const token = creds.fbPageToken;
  if (!token) throw new Error('instagram : missing Facebook page token');
  if (!image) throw new Error('instagram : needs an image');
  if (image.type !== 'image/jpeg') throw new Error(`instagram : JPEG only, ${image.name} is ${image.type}`);
  const me = `${GRAPH}/${creds.igUserId}`;
  const form = new URLSearchParams({ image_url: imageUrl('instagram', post, repository), caption: text });
  if (image.alt) form.set('alt_text', image.alt);
  const { id } = await (await call(f, 'instagram container', withToken(`${me}/media`, token), { method: 'POST', body: form })).json();
  await ready(f, 'instagram', withToken(`${GRAPH}/${id}?fields=status_code,status`, token), 'status_code', 'status', sleep);
  const pub = await (await call(f, 'instagram publish', withToken(`${me}/media_publish`, token), { method: 'POST', body: new URLSearchParams({ creation_id: id }) })).json();
  if (!pub.id) return { url: 'ok instagram', note: 'no id in the publish answer' };
  return followUp(`ok ${pub.id}`, async () => (await (await call(f, 'instagram permalink', withToken(`${GRAPH}/${pub.id}?fields=permalink`, token))).json()).permalink);
}

export const META = { threads, facebook, instagram };
