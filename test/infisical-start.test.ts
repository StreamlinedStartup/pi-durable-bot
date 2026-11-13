import { describe, expect, it, vi } from "vitest";
import { googleCredential } from "../scripts/infisical-start.ts";

describe("Infisical startup", () => {
  it("authenticates and reads the Google credential without logging it", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ accessToken: "temporary" })).mockResolvedValueOnce(Response.json({ secret: { secretValue: "credential" } }));
    expect(await googleCredential("http://infisical:8080", "project", "client", "secret", request)).toBe("credential");
    expect(request.mock.calls[1]![1]).toMatchObject({ headers: { Authorization: "Bearer temporary" } });
  });

  it("fails without returning a server response body when authentication fails", async () => {
    const request = vi.fn().mockResolvedValue(new Response("sensitive", { status: 401 }));
    await expect(googleCredential("http://infisical:8080", "project", "client", "secret", request)).rejects.toThrow("Infisical login failed (401)");
  });
});
