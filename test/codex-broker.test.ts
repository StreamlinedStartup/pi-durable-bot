import { describe, expect, it, vi } from "vitest";
import { codexBroker } from "../scripts/codex-broker.ts";

describe("Codex refresh broker", () => {
  it("serializes refresh and saves the rotated credential before returning it", async () => {
    const old = { type: "oauth" as const, access: "old", refresh: "old-refresh", expires: 1 };
    const next = { type: "oauth" as const, access: "new", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
    let stored = old;
    let saves = 0;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("universal-auth/login")) return Response.json({ accessToken: "service-token" });
      if (init?.method === "PATCH") { stored = JSON.parse(JSON.parse(String(init.body)).secretValue); saves++; return Response.json({}); }
      return Response.json({ secret: { secretValue: JSON.stringify(stored) } });
    });
    const refresh = vi.fn(async () => next);
    const get = codexBroker("http://example.test", "project", "client", "secret", request as typeof fetch, refresh);
    expect(await Promise.all([get(), get()])).toEqual([next, next]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(saves).toBe(1);
  });

  it("retries saving a rotated token without refreshing it again", async () => {
    const old = { type: "oauth" as const, access: "old", refresh: "old-refresh", expires: 1 };
    const next = { type: "oauth" as const, access: "new", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
    let saves = 0;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("universal-auth/login")) return Response.json({ accessToken: "service-token" });
      if (init?.method === "PATCH") return ++saves === 1 ? new Response(null, { status: 503 }) : Response.json({});
      return Response.json({ secret: { secretValue: JSON.stringify(old) } });
    });
    const refresh = vi.fn(async () => next);
    const get = codexBroker("http://example.test", "project", "client", "secret", request as typeof fetch, refresh);
    await expect(get()).rejects.toThrow("Infisical save failed");
    expect(await get()).toEqual(next);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
