import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { GoogleChatAdapter } from "@chat-adapter/gchat";
import { GoogleAuth, Impersonated, OAuth2Client } from "google-auth-library";
import type { Address, ChannelAdapter, ChannelConfig, ChannelEnv, ChannelSink, Happening, PersonInfo, SentMessage } from "../../core/channel.ts";
import { readSecrets } from "../../core/env-file.ts";

// The SDK verifies each request; Pots stores it before returning the SDK's success response.
export class GatewayGoogleChat extends GoogleChatAdapter {
  protected override handleMessageEvent(): void {}
  protected override handleAddedToSpace(): void {}
  protected override handleCardClick(): void {}
  protected override handlePubSubMessage(): Response { return Response.json({}); }

  async post(space: string, thread: string | undefined, text: string, sendId: string) {
    const hash = createHash("sha256").update(sendId).digest("hex");
    const response = await this.chatApi.spaces.messages.create({
      parent: space,
      requestId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      messageId: `client-${hash.slice(0, 56)}`,
      ...(thread ? { messageReplyOption: "REPLY_MESSAGE_OR_FAIL" } : {}),
      requestBody: { text: this.formatConverter.renderPostable({ markdown: text }), ...(thread ? { thread: { name: thread } } : {}) },
    });
    return response.data;
  }

  async sent(space: string, sendId: string) {
    const hash = createHash("sha256").update(sendId).digest("hex");
    try {
      return (await this.chatApi.spaces.messages.get({ name: `${space}/messages/client-${hash.slice(0, 56)}` })).data;
    } catch (error) {
      if ((error as { code?: number }).code === 404) return undefined;
      throw error;
    }
  }

  async message(name: string) { return (await this.chatApi.spaces.messages.get({ name })).data; }
  async space(name: string) { return (await this.chatApi.spaces.get({ name })).data; }

  async api(method: string, params: Record<string, unknown>): Promise<unknown> {
    const parts = method.split(".");
    let owner: any = this.chatApi;
    for (const part of parts.slice(0, -1)) owner = owner?.[part];
    const fn = owner?.[parts.at(-1)!];
    if (typeof fn !== "function") throw new Error(`unknown Google Chat API method: ${method}`);
    return (await fn.call(owner, params)).data;
  }

  async history(space: string, since: number, receive: (message: Message) => Promise<void>): Promise<void> {
    if (!this.impersonatedChatApi) throw new Error("Google Chat history requires impersonateUser and domain-wide delegation");
    let pageToken: string | undefined;
    do {
      const page = (await this.impersonatedChatApi.spaces.messages.list({ parent: space, filter: `createTime > "${new Date(since).toISOString()}"`, orderBy: "createTime asc", pageSize: 100, pageToken })).data;
      for (const message of page.messages ?? []) await receive(message as Message);
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
  }
}

type Message = { name?: string; text?: string; createTime?: string; thread?: { name?: string }; space?: Space; sender?: { name?: string; displayName?: string; type?: string }; annotations?: { userMention?: { user?: { name?: string } } }[] };
type Space = { name?: string; displayName?: string; spaceType?: string; type?: string; singleUserBotDm?: boolean };
type Raw = { type?: string; space?: Space; chat?: { messagePayload?: { message?: Message; space?: Space } }; message?: Message & { data?: string; messageId?: string; attributes?: Record<string, string> }; subscription?: string; sent?: Message; sendId?: string };

export function createChannel(config: ChannelConfig, env: ChannelEnv): ChannelAdapter {
  if ((typeof config.secrets !== "string" && typeof config.serviceAccount !== "string" && typeof config.credentialsEnv !== "string") || typeof config.endpointUrl !== "string" || !/^https:\/\//.test(config.endpointUrl) || typeof config.botUserId !== "string" || !/^users\/[^/]+$/.test(config.botUserId) || !Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65535) {
    throw new Error(`channel ${config.id}: secrets, credentialsEnv or serviceAccount, HTTPS endpointUrl, botUserId (users/...) and port are required`);
  }
  return new GoogleChatChannel(config, env);
}

class GoogleChatChannel implements ChannelAdapter {
  readonly id: string;
  readonly #config: ChannelConfig;
  readonly #env: ChannelEnv;
  #sdk?: GatewayGoogleChat;
  #server?: Server;
  readonly #spaces = new Map<string, Space>();
  constructor(config: ChannelConfig, env: ChannelEnv) { this.id = config.id; this.#config = config; this.#env = env; }
  get me(): PersonInfo { return { address: this.person(String(this.#config.botUserId)), name: this.#env.botName }; }
  person(user: string): string { return `${this.id}:@${user.replace(/^users\//, "")}`; }
  place(space: string): string { return `${this.id}:#${space.replace(/^spaces\//, "")}`; }
  owns(address: string): boolean { return address.startsWith(`${this.id}:`); }
  placeOf(address: string): string | undefined { const m = new RegExp(`^${this.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:#([^/]+)`).exec(address); return m ? `${this.id}:#${m[1]}` : undefined; }
  #parse(address: string): { space: string; thread?: string; message?: string } {
    if (!this.owns(address)) throw new Error(`not a ${this.id} address: ${address}`);
    const match = /^#([^/]+)(?:\/(t|m)\/([^/]+))?$/.exec(address.slice(this.id.length + 1));
    if (!match) throw new Error(`not a Google Chat place, thread or message: ${address}`);
    const space = `spaces/${match[1]}`;
    return { space, ...(match[2] === "t" ? { thread: `${space}/threads/${match[3]}` } : {}), ...(match[2] === "m" ? { message: `${space}/messages/${match[3]}` } : {}) };
  }
  async start(sink: ChannelSink): Promise<void> {
    let credentials;
    if (typeof this.#config.secrets === "string") credentials = JSON.parse(readSecrets(this.#config.secrets, ["GOOGLE_CHAT_CREDENTIALS"]).GOOGLE_CHAT_CREDENTIALS!);
    else if (typeof this.#config.credentialsEnv === "string") {
      try { credentials = JSON.parse(process.env[this.#config.credentialsEnv] ?? ""); }
      catch { throw new Error(`channel ${this.id}: invalid or missing credentials environment variable`); }
    }
    let auth: Impersonated | undefined;
    if (!credentials) {
      let sourceClient;
      if (typeof this.#config.gcloudAccount === "string") {
        const account = this.#config.gcloudAccount;
        const client = new OAuth2Client();
        client.refreshHandler = async () => {
          const { stdout } = await promisify(execFile)("gcloud", ["auth", "print-access-token", `--account=${account}`]);
          return { access_token: stdout.trim(), expiry_date: Date.now() + 300_000 };
        };
        sourceClient = client;
      } else sourceClient = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
      auth = new Impersonated({ sourceClient, targetPrincipal: String(this.#config.serviceAccount), targetScopes: ["https://www.googleapis.com/auth/chat.bot"], lifetime: 3600 });
    }
    const option = (key: string) => typeof this.#config[key] === "string" ? this.#config[key] as string : undefined;
    const logger = { debug: () => {}, info: () => {}, warn: (message: string) => sink.log(`Google Chat: ${message}`), error: (message: string) => sink.log(`Google Chat: ${message}`), child: () => logger };
    this.#sdk = new GatewayGoogleChat({ ...(credentials ? { credentials } : { auth: auth! }), botUserId: String(this.#config.botUserId), endpointUrl: String(this.#config.endpointUrl), googleChatProjectNumber: option("projectNumber") ?? "", pubsubAudience: option("pubsubAudience") ?? "", pubsubServiceAccountEmail: option("pubsubServiceAccountEmail") ?? "", workspaceAddOnServiceAccountEmail: option("workspaceAddOnServiceAccountEmail") ?? "", impersonateUser: option("impersonateUser") ?? "", disableSignatureVerification: false, logger });
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || req.url !== new URL(String(this.#config.endpointUrl)).pathname) { res.writeHead(404).end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1_000_000) { res.writeHead(413).end(); return; } chunks.push(chunk); }
        const body = Buffer.concat(chunks).toString("utf8");
        const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const response = await this.#sdk!.handleWebhook(new Request(String(this.#config.endpointUrl), { method: "POST", headers, body }));
        if (!response.ok) { res.writeHead(response.status).end(await response.text()); return; }
        const raw = JSON.parse(body) as Raw;
        const payload = raw.message?.data && raw.subscription ? JSON.parse(Buffer.from(raw.message.data, "base64").toString("utf8")) : undefined;
        const batchType = raw.message?.attributes?.["ce-type"];
        const items = payload && (payload.messages ?? payload.reactions);
        if (Array.isArray(items) && batchType?.includes(".batch")) {
          const eventType = batchType.replace(/\.batch(Created|Updated|Deleted)$/, (_, action: string) => `.${action.toLowerCase()}`);
          for (const [index, item] of items.entries()) {
            const event = { ...raw, message: { ...raw.message, attributes: { ...raw.message?.attributes, "ce-type": eventType }, data: Buffer.from(JSON.stringify(item)).toString("base64") } };
            const id = eventType === "google.workspace.chat.message.v1.created" && item.message?.name ? `message:${item.message.name}` : `event:${raw.message?.messageId ?? createHash("sha256").update(body).digest("hex")}:${index}`;
            await sink.receive(id, event);
          }
          const responseBody = await response.text();
          res.writeHead(response.status, { "content-type": "application/json" }).end(responseBody);
          return;
        }
        const message = raw.chat?.messagePayload?.message ?? payload?.message ?? (!raw.subscription ? raw.message : undefined);
        const eventType = raw.message?.attributes?.["ce-type"] ?? "message";
        const eventId = message?.name && (eventType === "message" || eventType === "google.workspace.chat.message.v1.created") ? `message:${message.name}` : `event:${raw.message?.messageId ?? createHash("sha256").update(body).digest("hex")}`;
        await sink.receive(eventId, raw);
        const responseBody = await response.text();
        res.writeHead(response.status, { "content-type": "application/json" }).end(responseBody);
      } catch (error) { sink.log("Google Chat webhook failed", { error: String(error) }); if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(this.#config.port), typeof this.#config.host === "string" ? this.#config.host : "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  }
  async stop(): Promise<void> { const server = this.#server; this.#server = undefined; if (server?.listening) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
  async backfill(sink: ChannelSink): Promise<void> {
    const since = sink.lastAlive();
    if (!since) return;
    if (!this.#config.impersonateUser) { sink.log("Google Chat history requires impersonateUser; missed messages cannot be backfilled"); return; }
    for (const place of await sink.places()) {
      const { space } = this.#parse(place);
      try {
        await this.#sdk!.history(space, since, async (message) => {
          if (message.name) await sink.receive(`message:${message.name}`, { chat: { messagePayload: { space: { name: space }, message } } });
        });
      } catch (error) { sink.log("Google Chat backfill failed", { place, error: String(error) }); }
    }
  }
  async translate(input: unknown): Promise<Happening[]> {
    const raw = input as Raw;
    let message = raw.sent ?? raw.chat?.messagePayload?.message ?? (!raw.subscription ? raw.message : undefined);
    let space = raw.chat?.messagePayload?.space ?? raw.space ?? message?.space;
    const eventType = raw.message?.attributes?.["ce-type"] ?? "";
    if (raw.subscription && raw.message?.data) {
      const data = JSON.parse(Buffer.from(raw.message.data, "base64").toString("utf8"));
      message = data.message;
      space = message?.space ?? { name: raw.message.attributes?.["ce-subject"]?.replace("//chat.googleapis.com/", "") };
      if (data.reaction && space?.name) {
        const reaction = data.reaction as { name?: string; user?: { name?: string; displayName?: string }; emoji?: { unicode?: string } };
        const match = /\/messages\/([^/]+)\/reactions\//.exec(reaction.name ?? "");
        if (!match || !reaction.user?.name) return [];
        return [{ kind: eventType.endsWith(".deleted") ? "reaction_removed" : "reaction_added", at: Date.parse(raw.message.attributes?.["ce-time"] ?? "") || Date.now(), place: { address: this.place(space.name), kind: "channel" }, message: `${this.place(space.name)}/m/${match[1]}`, person: { address: this.person(reaction.user.name), ...(reaction.user.displayName ? { name: reaction.user.displayName } : {}) }, fromMe: reaction.user.name === this.#config.botUserId, text: reaction.emoji?.unicode ?? "", raw: input }];
      }
    }
    if (!message?.name || !space?.name) return [];
    if (space.spaceType || space.type || space.singleUserBotDm !== undefined) this.#spaces.set(space.name, space);
    else if (this.#sdk) {
      const known = this.#spaces.get(space.name) ?? await this.#sdk.space(space.name) as Space;
      this.#spaces.set(space.name, known);
      space = { ...known, name: space.name };
    }
    if (!space.name) return [];
    const spaceId = space.name.split("/")[1]; const msgId = message.name.split("/").at(-1); const threadId = message.thread?.name?.split("/").at(-1);
    const fromMe = message.sender?.name === this.#config.botUserId;
    const mentions = (message.annotations ?? []).flatMap((a) => a.userMention?.user?.name ? [this.person(a.userMention.user.name)] : []);
    return [{ kind: eventType.endsWith(".updated") ? "edit" : eventType.endsWith(".deleted") ? "delete" : "message", at: Date.parse(raw.message?.attributes?.["ce-time"] ?? message.createTime ?? "") || Date.now(), place: { address: this.place(space.name), kind: space.singleUserBotDm || space.spaceType === "DIRECT_MESSAGE" || space.type === "DM" ? "dm" : space.spaceType === "GROUP_CHAT" ? "group" : "channel", ...(space.displayName ? { name: space.displayName } : {}) }, message: `${this.id}:#${spaceId}/m/${msgId}`, ...(threadId ? { thread: `${this.id}:#${spaceId}/t/${threadId}` } : {}), ...(message.sender?.name ? { person: { address: this.person(message.sender.name), ...(message.sender.displayName ? { name: message.sender.displayName } : {}) } } : {}), fromMe, mentionsMe: mentions.includes(this.me.address), mentions, text: message.text ?? "", ...(raw.sendId ? { sendId: raw.sendId } : {}), raw: input }];
  }
  async #target(to: Address): Promise<{ space: string; thread?: string; message?: string }> {
    const prefix = `${this.id}:@`;
    if (to.startsWith(prefix)) {
      const user = to.slice(prefix.length);
      if (!user || user.includes("/")) throw new Error(`not a person: ${to}`);
      const dm = await this.#sdk!.openDM(`users/${user}`);
      return { space: this.#sdk!.decodeThreadId(dm).spaceName };
    }
    return this.#parse(to);
  }
  checkText(_to: Address, text: string): string | undefined { return Buffer.byteLength(text, "utf8") > 30_000 ? "Google Chat messages must fit within 32,000 bytes; send this in parts." : undefined; }
  async send(to: Address, text: string, sendId: string): Promise<SentMessage> {
    const refusal = this.checkText(to, text); if (refusal) throw new Error(refusal);
    const target = await this.#target(to); let thread = target.thread;
    if (target.message) {
      const message = await this.#sdk!.message(target.message);
      if (!message.thread?.name) throw new Error(`Google Chat did not return a thread for ${to}`);
      thread = message.thread.name;
    }
    const data = await this.#sdk!.post(target.space, thread, text, sendId);
    return this.#sent(data as Message, target.space, sendId, text);
  }
  #sent(data: Message, space: string, sendId: string, text?: string): SentMessage {
    if (!data.name) throw new Error("Google Chat did not return a message name");
    const message = { ...data, text: data.text ?? text, space: data.space ?? { name: space }, sender: data.sender ?? { name: String(this.#config.botUserId), type: "BOT" }, createTime: data.createTime ?? new Date().toISOString() };
    return { message: `${this.place(space)}/m/${data.name.split("/").at(-1)}`, place: this.place(space), raw: { sent: message, sendId } };
  }
  async findSent(to: Address, sendId: string): Promise<SentMessage | undefined> { const { space } = await this.#target(to); const message = await this.#sdk!.sent(space, sendId); return message ? this.#sent(message as Message, space, sendId) : undefined; }
  async react(): Promise<void> { throw new Error("Google Chat reactions are not supported by this channel"); }
  async call(method: string, params: Record<string, unknown>): Promise<unknown> { return this.#sdk!.api(method, params); }
}
