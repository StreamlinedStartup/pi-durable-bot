import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initialize } from "../scripts/coolify-start.ts";

it("creates the bot once and preserves later configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "pots-init-"));
  try {
    await initialize(home, "https://example.test/webhook", "users/123");
    const file = join(home, ".pots", "bots", "pots", "bot.json");
    const definition = JSON.parse(await readFile(file, "utf8"));
    expect(definition.channels[0]).toMatchObject({ endpointUrl: "https://example.test/webhook", host: "0.0.0.0" });
    await writeFile(file, "custom configuration");
    await initialize(home, "https://example.test/webhook", "users/123");
    expect(await readFile(file, "utf8")).toBe("custom configuration");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
