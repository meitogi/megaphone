// The two things every sender does with a response, shared by publish.mjs,
// meta.mjs and linkedin.mjs. fetch only : no Node API, no DOM.

// The HTTP error as one line, from the response body only : never the URL or a
// header. Forem and LinkedIn answer `{ message }`, OAuth `{ error_description }`,
// Graph `{ error: { message } }`, others a bare `{ error }` or plain text.
export async function call(f, what, url, init) {
  const res = await f(url, init);
  if (res.ok) return res;
  const raw = await res.text().catch(() => '');
  let msg = raw;
  try {
    const j = JSON.parse(raw);
    msg = j.message || j.error_description || (j.error && (j.error.message || j.error)) || raw;
  } catch {}
  throw new Error(`${what} : HTTP ${res.status} ${String(msg).slice(0, 200)}`.trim());
}

// After the publishing call answered 2xx the post is out : a failing follow-up
// (permalink read, first comment) must never turn the network `failed`, since a
// retry would post twice. `fn` resolves to a better URL (a string), or to anything
// else ; its error comes back as `note` next to the URL already known.
export async function followUp(url, fn) {
  try {
    const r = await fn();
    return { url: typeof r === 'string' && r ? r : url };
  } catch (e) {
    return { url, note: e.message };
  }
}
