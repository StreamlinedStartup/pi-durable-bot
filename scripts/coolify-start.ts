import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function initialize(home: string, endpointUrl: string, botUserId: string) {
  const dir = join(home, ".pots", "bots", "pots");
  if (!endpointUrl || !botUserId) throw new Error("Google Chat configuration is incomplete");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const definition = {
    name: "Pots", model: "openai-codex/gpt-6.1-sol", thinking: "medium", judge: "off",
    channels: [{ id: "gchat", type: "gchat", credentialsEnv: "GOOGLE_CHAT_CREDENTIALS", endpointUrl, port: 8088, host: "0.0.0.0", botUserId }],
  };
  try {
    await writeFile(join(dir, "bot.json"), `${JSON.stringify(definition, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await initialize(homedir(), process.env.GOOGLE_CHAT_ENDPOINT_URL ?? "", process.env.GOOGLE_CHAT_BOT_USER_ID ?? "");
  process.argv[2] = "start";
  await import(new URL("../dist/cli/pots.js", import.meta.url).href);
}
