import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";

const { openaiCodexOAuth } = await import(new URL("./auth/oauth/openai-codex.js", import.meta.resolve("@earendil-works/pi-ai")).href) as { openaiCodexOAuth: OAuthAuth };

export function codexBroker(url: string, project: string, clientId: string, clientSecret: string, request: typeof fetch = fetch, refresh = openaiCodexOAuth.refresh) {
  let pending: Promise<unknown> = Promise.resolve();
  let unsaved: OAuthCredential | undefined;
  const secretUrl = new URL("/api/v4/secrets/CODEX_OAUTH", url);
  secretUrl.search = new URLSearchParams({ projectId: project, environment: "prod", secretPath: "/" }).toString();
  async function credential(): Promise<OAuthCredential> {
    const login = await request(new URL("/api/v1/auth/universal-auth/login", url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, clientSecret }),
    });
    if (!login.ok) throw new Error(`Infisical login failed (${login.status})`);
    const { accessToken } = await login.json() as { accessToken: string };
    const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
    if (!unsaved) {
      const response = await request(secretUrl, { headers });
      if (!response.ok) throw new Error(`Infisical read failed (${response.status})`);
      const data = await response.json() as { secret: { secretValue: string } };
      const current = JSON.parse(data.secret.secretValue) as OAuthCredential;
      if (current.type !== "oauth" || !current.access || !current.refresh || !Number.isFinite(current.expires)) throw new Error("Invalid Codex credential");
      if (current.expires > Date.now() + 600_000) return current;
      unsaved = await refresh(current, AbortSignal.timeout(30_000));
    }
    const save = await request(new URL("/api/v4/secrets/CODEX_OAUTH", url), {
      method: "PATCH", headers, body: JSON.stringify({ projectId: project, environment: "prod", secretPath: "/", secretValue: JSON.stringify(unsaved) }),
    });
    if (!save.ok) throw new Error(`Infisical save failed (${save.status})`);
    const saved = unsaved;
    unsaved = undefined;
    return saved;
  }
  return () => {
    const next = pending.catch(() => undefined).then(credential);
    pending = next;
    return next;
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { INFISICAL_URL, CODEX_PROJECT_ID, CODEX_BROKER_CLIENT_ID, CODEX_BROKER_CLIENT_SECRET } = process.env;
  if (!INFISICAL_URL || !CODEX_PROJECT_ID || !CODEX_BROKER_CLIENT_ID || !CODEX_BROKER_CLIENT_SECRET) throw new Error("Codex broker configuration is incomplete");
  const get = codexBroker(INFISICAL_URL, CODEX_PROJECT_ID, CODEX_BROKER_CLIENT_ID, CODEX_BROKER_CLIENT_SECRET);
  createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/") { res.writeHead(404).end(); return; }
    void get().then(({ access, expires, accountId }) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ type: "oauth", access, expires, accountId, refresh: "broker-managed" }));
    }, () => { process.stderr.write("Codex broker request failed\n"); res.writeHead(503).end(); });
  }).listen(8089, "0.0.0.0");
}
