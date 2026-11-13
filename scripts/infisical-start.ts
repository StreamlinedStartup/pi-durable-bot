import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function googleCredential(url: string, project: string, clientId: string, clientSecret: string, request: typeof fetch = fetch): Promise<string> {
  const login = await request(new URL("/api/v1/auth/universal-auth/login", url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!login.ok) throw new Error(`Infisical login failed (${login.status})`);
  const { accessToken } = await login.json() as { accessToken: string };
  const secretUrl = new URL("/api/v4/secrets/GOOGLE_CHAT_CREDENTIALS", url);
  secretUrl.search = new URLSearchParams({ projectId: project, environment: "prod", secretPath: "/" }).toString();
  const secret = await request(secretUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!secret.ok) throw new Error(`Infisical credential lookup failed (${secret.status})`);
  const data = await secret.json() as { secret: { secretValue: string } };
  return data.secret.secretValue;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { INFISICAL_URL, INFISICAL_PROJECT_ID, INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET } = process.env;
  if (!INFISICAL_URL || !INFISICAL_PROJECT_ID || !INFISICAL_CLIENT_ID || !INFISICAL_CLIENT_SECRET) throw new Error("Infisical configuration is incomplete");
  process.env.GOOGLE_CHAT_CREDENTIALS = await googleCredential(INFISICAL_URL, INFISICAL_PROJECT_ID, INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET);
  process.argv[2] = "start";
  await import(new URL("../dist/cli/pots.js", import.meta.url).href);
}
