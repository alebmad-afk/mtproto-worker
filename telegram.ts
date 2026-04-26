import { TelegramClient, Api } from "telegram";
import { ConnectionTCPObfuscated } from "telegram/network/index.js";
import { PromisedNetSockets, PromisedWebSockets } from "telegram/extensions/index.js";
import { StringSession } from "telegram/sessions/index.js";
import { FloodWaitError } from "telegram/errors/index.js";
import type { Env } from "./env.js";
import type { DiscoveryCandidatePayload } from "./db.js";

export class TelegramSearchClient {
  private client: TelegramClient;
  private connected = false;

  constructor(env: Env) {
    const session = new StringSession(env.MTPROTO_SESSION_STRING);
    const serverAddress = session.serverAddress ?? "";
    const isBrowserWebSession = /\.web\.telegram\.org$/i.test(serverAddress);

    this.client = new TelegramClient(session, env.MTPROTO_API_ID, env.MTPROTO_API_HASH, {
      connection: ConnectionTCPObfuscated,
      networkSocket: isBrowserWebSession ? PromisedWebSockets : PromisedNetSockets,
      connectionRetries: 10,
      reconnectRetries: 10,
      requestRetries: 3,
      retryDelay: 2000,
      timeout: 30,
      useWSS: isBrowserWebSession,
      autoReconnect: true,
      // Quiet mode — gramJS is verbose by default
      baseLogger: undefined,
    });
  }

  async connect(): Promise<{ phone: string; username: string | null; userId: string }> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
    const me = (await this.client.getMe()) as Api.User;
    const phoneRaw = me.phone ?? "";
    const phoneMasked = phoneRaw ? `+${phoneRaw.slice(0, 1)}***${phoneRaw.slice(-4)}` : "unknown";
    return {
      phone: phoneMasked,
      username: me.username ?? null,
      userId: me.id.toString(),
    };
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.disconnect();
      this.connected = false;
    }
  }

  /**
   * Telegram-native global search across public chats, channels, users.
   * Uses contacts.search which scans Telegram's directory of public entities.
   */
  async searchContacts(query: string, limit = 50): Promise<DiscoveryCandidatePayload[]> {
    const result = (await this.client.invoke(
      new Api.contacts.Search({ q: query, limit }),
    )) as Api.contacts.Found;

    const out: DiscoveryCandidatePayload[] = [];

    for (const chat of result.chats) {
      const c = chat as Api.Chat | Api.Channel;
      if (c.className !== "Channel" && c.className !== "Chat") continue;

      const isChannel = c.className === "Channel";
      const isMegagroup = isChannel && (c as Api.Channel).megagroup === true;
      const isBroadcast = isChannel && (c as Api.Channel).broadcast === true;
      const username = isChannel ? (c as Api.Channel).username ?? null : null;
      const title = c.title ?? "";

      // Skip private/empty
      if (!username && !isMegagroup) continue;

      const isGroup = isMegagroup || c.className === "Chat";

      out.push({
        username,
        title,
        description: null, // contacts.Search doesn't return about; we'd need separate getFullChannel
        is_group: isGroup,
        is_megagroup: isMegagroup,
        has_discussion: false,
        has_recent_messages: true, // results from this API are typically active
        is_russian: this.looksRussian(title),
        score: this.fuzzyMatchScore(query, title),
        matched_query: query,
        search_method: "search_contacts",
        raw: { id: c.id?.toString(), title, username, isMegagroup, isBroadcast } as never,
      });
    }

    return out;
  }

  /**
   * Telegram global message search — finds chats by their MESSAGE CONTENT,
   * not just title. This is the killer feature vs web search.
   * NOTE: This requires the user to have access; results are limited.
   */
  async searchMessagesGlobal(query: string, limit = 30): Promise<DiscoveryCandidatePayload[]> {
    try {
      const result = (await this.client.invoke(
        new Api.messages.SearchGlobal({
          q: query,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetRate: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          offsetId: 0,
          limit,
          broadcastsOnly: false,
        }),
      )) as Api.messages.MessagesSlice | Api.messages.Messages | Api.messages.ChannelMessages;

      const chats = "chats" in result ? result.chats : [];
      const messages = "messages" in result ? result.messages : [];
      const out: DiscoveryCandidatePayload[] = [];
      const seen = new Set<string>();
      const snippetsByPeer = new Map<string, string[]>();

      for (const message of messages as Api.Message[]) {
        const text = (message.message ?? "").trim();
        if (!text) continue;
        const peer = message.peerId as Api.TypePeer | undefined;
        const peerKey = peer?.className === "PeerChannel"
          ? (peer as Api.PeerChannel).channelId.toString()
          : peer?.className === "PeerChat"
            ? (peer as Api.PeerChat).chatId.toString()
            : null;
        if (!peerKey) continue;
        const existing = snippetsByPeer.get(peerKey) ?? [];
        if (existing.length < 3) existing.push(text.slice(0, 260));
        snippetsByPeer.set(peerKey, existing);
      }

      for (const chat of chats) {
        const c = chat as Api.Channel | Api.Chat;
        if (c.className !== "Channel" && c.className !== "Chat") continue;

        const isChannel = c.className === "Channel";
        const isMegagroup = isChannel && (c as Api.Channel).megagroup === true;
        const username = isChannel ? (c as Api.Channel).username ?? null : null;
        const title = c.title ?? "";
        const key = username ?? `id:${c.id?.toString()}`;
        const idKey = c.id?.toString();
        const evidence = idKey ? snippetsByPeer.get(idKey) ?? [] : [];
        if (seen.has(key)) continue;
        seen.add(key);

        if (!username && !isMegagroup) continue;
        const isGroup = isMegagroup || c.className === "Chat";

        out.push({
          username,
          title,
          description: evidence.length ? evidence.join("\n") : null,
          is_group: isGroup,
          is_megagroup: isMegagroup,
          has_discussion: false,
          has_recent_messages: true, // matched a recent message
          is_russian: this.looksRussian(title),
          score: 88, // matched by content => high signal
          matched_query: query,
          search_method: "search_global",
          raw: { id: c.id?.toString(), title, username, isMegagroup, evidence } as never,
        });
      }
      return out;
    } catch (err) {
      if (err instanceof FloodWaitError) throw err;
      // SearchGlobal can return PeerInvalid or AuthRequired for some chats — skip
      console.warn("[telegram] searchMessagesGlobal failed:", (err as Error).message);
      return [];
    }
  }

  /**
   * Resolve a single @username — used for enriching candidates from web search.
   */
  async resolveUsername(username: string): Promise<DiscoveryCandidatePayload | null> {
    try {
      const clean = username.replace(/^@/, "").trim();
      if (!clean) return null;
      const result = (await this.client.invoke(
        new Api.contacts.ResolveUsername({ username: clean }),
      )) as Api.contacts.ResolvedPeer;

      const chat = result.chats[0];
      if (!chat || (chat.className !== "Channel" && chat.className !== "Chat")) return null;

      const isChannel = chat.className === "Channel";
      const c = chat as Api.Channel;
      const isMegagroup = isChannel && c.megagroup === true;
      const isGroup = isMegagroup || chat.className === "Chat";

      return {
        username: clean,
        title: chat.title ?? "",
        description: null,
        is_group: isGroup,
        is_megagroup: isMegagroup,
        has_discussion: false,
        has_recent_messages: true,
        is_russian: this.looksRussian(chat.title ?? ""),
        score: 0.5,
        matched_query: username,
        search_method: "resolve_username",
        raw: { id: chat.id?.toString(), title: chat.title, username: clean } as never,
      };
    } catch (err) {
      if (err instanceof FloodWaitError) throw err;
      console.warn(`[telegram] resolveUsername(${username}) failed:`, (err as Error).message);
      return null;
    }
  }

  private looksRussian(s: string): boolean {
    return /[А-Яа-яЁё]/.test(s);
  }

  private fuzzyMatchScore(query: string, title: string): number {
    const q = query.toLowerCase().trim();
    const t = title.toLowerCase();
    if (!q || !t) return 0.3;
    if (t.includes(q)) return 0.9;
    const words = q.split(/\s+/).filter((w) => w.length >= 3);
    const matched = words.filter((w) => t.includes(w)).length;
    return Math.min(0.85, 0.3 + 0.2 * matched);
  }
}

export { FloodWaitError };
