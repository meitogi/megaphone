// A fetch double no richer than fetch : `(url, init) => Promise<Response>`.
// `routes(request, calls)` returns the Response ; every call is kept as a Request
// clone so the tests read what would really go on the wire. Not a test file :
// imported by the Meta / LinkedIn / refresh / auth tests (publish.test.mjs keeps its own copy).
export function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    const req = new Request(url, init);
    calls.push(req.clone());
    return routes(req, calls);
  };
  return { f, calls };
}

export const trail = (calls) => calls.map((c) => `${c.method} ${new URL(c.url).host}${new URL(c.url).pathname}`);
