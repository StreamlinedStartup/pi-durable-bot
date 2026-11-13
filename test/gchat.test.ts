import { describe, expect, it, vi } from "vitest";
import { GoogleChatAdapter } from "@chat-adapter/gchat";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { ChannelSink } from "../src/core/channel.ts";
import { createChannel, GatewayGoogleChat } from "../src/channels/gchat/index.ts";

const env = { botDir: "/tmp", botName: "Pots", log: () => {} };

describe("Google Chat", () => {
  it("requires a verified public endpoint and an explicit bot identity", () => {
    expect(() => createChannel({ id: "gchat", type: "gchat" }, env)).toThrow();
    expect(() => createChannel({ id: "gchat", type: "gchat", serviceAccount: "bot@example.com", endpointUrl: "https://example.com/chat", botUserId: "users/bot", port: 8080 }, env)).not.toThrow();
  });

  it("rejects text that would exceed the Google Chat size limit", () => {
    const channel = createChannel({ id: "gchat", type: "gchat", secrets: "/tmp/gchat.env", endpointUrl: "https://example.com/chat", botUserId: "users/bot", port: 8080 }, env);
    expect(channel.checkText!("gchat:#a", "x".repeat(30_001))).toContain("send this in parts");
    expect(channel.checkText!("gchat:#a", "hello")).toBeUndefined();
  });

  it("translates a Google Chat message into a channel-neutral event", async () => {
    const channel = createChannel({ id: "gchat", type: "gchat", secrets: "/tmp/gchat.env", endpointUrl: "https://example.com/chat", botUserId: "users/bot", port: 8080 }, env);
    const [event] = await channel.translate({ chat: { messagePayload: { space: { name: "spaces/abc", spaceType: "SPACE", displayName: "Team" }, message: { name: "spaces/abc/messages/one", thread: { name: "spaces/abc/threads/t1" }, text: "hello", createTime: "2026-01-01T00:00:00Z", sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" } } } } });
    expect(event).toMatchObject({ kind: "message", place: { address: "gchat:#abc", name: "Team", kind: "channel" }, person: { address: "gchat:@alice", name: "Alice" }, message: "gchat:#abc/m/one", thread: "gchat:#abc/t/t1", text: "hello", fromMe: false });
  });

  it("recognizes an edited Pub/Sub message and a mention of the bot", async () => {
    const channel = createChannel({ id: "gchat", type: "gchat", secrets: "/tmp/gchat.env", endpointUrl: "https://example.com/chat", botUserId: "users/bot", port: 8080 }, env);
    const message = { name: "spaces/abc/messages/one", text: "hello", sender: { name: "users/alice" }, annotations: [{ userMention: { user: { name: "users/bot" } } }] };
    const raw = { subscription: "s", message: { attributes: { "ce-type": "google.workspace.chat.message.v1.updated", "ce-subject": "//chat.googleapis.com/spaces/abc" }, data: Buffer.from(JSON.stringify({ message })).toString("base64") } };
    expect(await channel.translate(raw)).toEqual([expect.objectContaining({ kind: "edit", mentionsMe: true, mentions: ["gchat:@bot"], message: "gchat:#abc/m/one" })]);
  });

  it("uses the same Google request and message IDs when a send is retried", async () => {
    const sdk = new GatewayGoogleChat({ credentials: { client_email: "bot@example.com", private_key: "test" }, endpointUrl: "https://example.com/chat" });
    const create = vi.fn(async (_params: unknown) => ({ data: { name: "spaces/a/messages/1" } }));
    const get = vi.fn(async (_params: unknown) => ({ data: { name: "spaces/a/messages/1" } }));
    const api = (sdk as unknown as { chatApi: { spaces: { messages: { create: typeof create; get: typeof get } } } }).chatApi;
    api.spaces.messages.create = create;
    api.spaces.messages.get = get;
    await sdk.post("spaces/a", undefined, "hello", "send-1");
    await sdk.post("spaces/a", undefined, "hello", "send-1");
    await sdk.sent("spaces/a", "send-1");
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    const params = create.mock.calls[0]![0] as unknown as { requestId: string; messageId: string };
    expect(params.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(get).toHaveBeenCalledWith({ name: `spaces/a/messages/${params.messageId}` });
  });
});


describe("Google Chat webhook", () => {
  it("listens on the configured interface", async () => {
    const host = Object.values(networkInterfaces()).flat().find((a) => a?.family === "IPv4" && !a.internal)?.address;
    if (!host) return;
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, host, resolve); });
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    process.env.POTS_TEST_GOOGLE_CREDENTIALS = JSON.stringify({ client_email: "bot@example.com", private_key: "test" });
    const channel = createChannel({ id: "gchat", type: "gchat", credentialsEnv: "POTS_TEST_GOOGLE_CREDENTIALS", endpointUrl: "https://example.com/chat", botUserId: "users/bot", port, host }, env);
    const sink: ChannelSink = { receive: async () => {}, newestMessage: async () => undefined, threads: async () => [], places: async () => [], lastAlive: () => undefined, form: async () => undefined, formOpened: async () => {}, formOpening: async () => undefined, log: () => {} };
    try {
      await channel.start(sink);
      expect((await fetch(`http://${host}:${port}/chat`, { method: "POST", body: "{}" })).status).toBe(401);
    } finally { await channel.stop(); delete process.env.POTS_TEST_GOOGLE_CREDENTIALS; }
  });
  it("rejects an unverified request and stores verified events before acknowledging them", { timeout: 30_000 }, async () => {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const dir = mkdtempSync(join(tmpdir(), "pots-gchat-"));
    const secrets = join(dir, "gchat.env");
    writeFileSync(secrets, 'GOOGLE_CHAT_CREDENTIALS={"client_email":"bot@example.com","private_key":"test"}\n');
    const channel = createChannel({ id: "gchat", type: "gchat", secrets, endpointUrl: "https://example.com/chat", botUserId: "users/bot", port }, env);
    const stored: string[] = [];
    let fail = true;
    const sink: ChannelSink = { receive: async (id) => { if (fail) throw new Error("disk full"); stored.push(id); }, newestMessage: async () => undefined, threads: async () => [], places: async () => [], lastAlive: () => undefined, form: async () => undefined, formOpened: async () => {}, formOpening: async () => undefined, log: () => {} };
    const body = JSON.stringify({ chat: { messagePayload: { space: { name: "spaces/a" }, message: { name: "spaces/a/messages/1" } } } });
    const post = () => fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", body });
    try {
      await channel.start(sink);
      expect((await post()).status).toBe(401);
      expect(stored).toEqual([]);
      const verification = vi.spyOn(GoogleChatAdapter.prototype, "handleWebhook").mockImplementation(async () => new Response("{}"));
      expect((await post()).status).toBe(500);
      fail = false;
      expect((await post()).status).toBe(200);
      expect(stored).toEqual(["message:spaces/a/messages/1"]);
      const push = { subscription: "projects/p/subscriptions/s", message: { messageId: "delivery-1", attributes: { "ce-type": "google.workspace.chat.message.v1.created", "ce-subject": "//chat.googleapis.com/spaces/a" }, data: Buffer.from(JSON.stringify({ message: { name: "spaces/a/messages/1" } })).toString("base64") } };
      expect((await fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", body: JSON.stringify(push) })).status).toBe(200);
      expect(stored).toEqual(["message:spaces/a/messages/1", "message:spaces/a/messages/1"]);
      const batch = { ...push, message: { ...push.message, attributes: { ...push.message.attributes, "ce-type": "google.workspace.chat.message.v1.batchCreated" }, data: Buffer.from(JSON.stringify({ messages: [{ message: { name: "spaces/a/messages/2" } }, { message: { name: "spaces/a/messages/3" } }] })).toString("base64") } };
      expect((await fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", body: JSON.stringify(batch) })).status).toBe(200);
      expect(stored.slice(-2)).toEqual(["message:spaces/a/messages/2", "message:spaces/a/messages/3"]);
      verification.mockRestore();
    } finally { await channel.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});
