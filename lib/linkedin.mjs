// LinkedIn Posts API, as the member (« Share on LinkedIn », w_member_social). CLI
// and Action only : no CORS. fetch only : no Node API, no DOM.
// Version read off learn.microsoft.com on 2026-10-23 (versions live ≥ 12 months).
import { call, followUp } from './http.mjs';

export const LINKEDIN_VERSION = '202610';
const API = 'https://api.linkedin.com/rest';
// Where initializeUpload sends the bytes ; another host would be a new firewall
// entry, so it stops here and names it.
export const UPLOAD_HOST = 'www.linkedin.com';

// `commentary` is LinkedIn's « little text » : these characters are reserved and
// each takes a backslash, used or not.
export function littleText(text) {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, '\\$&');
}

async function linkedin(text, { creds, image, f, post }) {
  const author = creds.linkedinPersonUrn;
  const headers = {
    Authorization: `Bearer ${creds.linkedinToken}`,
    'LinkedIn-Version': LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
  };
  const body = {
    author,
    commentary: littleText(text),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (image) {
    const init = await (await call(f, 'linkedin image', `${API}/images?action=initializeUpload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
    })).json();
    const { uploadUrl, image: id } = init.value;
    const host = new URL(uploadUrl).host;
    if (host !== UPLOAD_HOST) throw new Error(`linkedin : upload host ${host} is not allowlisted (expected ${UPLOAD_HOST})`);
    await call(f, 'linkedin upload', uploadUrl, { method: 'PUT', headers: { Authorization: headers.Authorization, 'Content-Type': image.type }, body: image.bytes });
    body.content = { media: image.alt ? { id, altText: image.alt } : { id } };
  }
  const res = await call(f, 'linkedin post', `${API}/posts`, { method: 'POST', headers, body: JSON.stringify(body) });
  const urn = res.headers.get('x-restli-id');
  // Published either way : without the header there is nothing to link to.
  if (!urn) return { url: 'ok linkedin', note: 'no x-restli-id header on the post response' };
  const url = `https://www.linkedin.com/feed/update/${urn}/`;
  const link = post.meta.link;
  if (!link) return { url };
  return followUp(url, () => call(f, 'linkedin comment', `${API}/socialActions/${encodeURIComponent(urn)}/comments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ actor: author, object: urn, message: { text: link } }),
  }));
}

export const LINKEDIN = { linkedin };
