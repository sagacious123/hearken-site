// Upstash Redis over its REST API (set up from Vercel's Storage tab), with no dependencies.
export async function kv(command) {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("storage isn't set up");
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(command) });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error ?? `storage answered ${res.status}`);
  return body.result;
}
