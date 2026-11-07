import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
} from "@whiskeysockets/baileys"
import QRCode from "qrcode"
import pino from "pino"

const DATA_DIR = path.join(os.homedir(), ".local", "share", "opencode", "whatsapp")
const AUTH_DIR = path.join(DATA_DIR, "auth")
const MEDIA_DIR = path.join(DATA_DIR, "media")
const QR_PNG_PATH = path.join(DATA_DIR, "qr.png")
const QR_HTML_PATH = path.join(DATA_DIR, "qr.html")
const STATUS_PATH = path.join(DATA_DIR, "status.json")
const LOG_PATH = path.join(DATA_DIR, "bridge.log")

const BOT_PREFIX = "ðŸ¤– *OpenCode*"
const BRIDGE_VERSION = 14

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  fs.mkdirSync(MEDIA_DIR, { recursive: true })
}

function logLine(msg: string) {
  try {
    ensureDirs()
    const line = `[${new Date().toISOString()}] ${msg}\n`
    fs.appendFileSync(LOG_PATH, line, "utf8")
  } catch {
    // ignore logging errors
  }
}

function writeStatus(status: Record<string, unknown>) {
  try {
    ensureDirs()
    fs.writeFileSync(
      STATUS_PATH,
      JSON.stringify({ updatedAt: new Date().toISOString(), ...status }, null, 2),
      "utf8",
    )
  } catch {
    // ignore status write errors
  }
}

function normalizeJid(jid?: string | null): string | undefined {
  if (!jid) return undefined
  return jid.replace(/:\d+@/, "@")
}

interface FormFieldOption {
  value: string
  label: string
  description?: string
}

interface FormField {
  key: string
  title?: string
  description?: string
  type: string
  options?: FormFieldOption[]
  multiple?: boolean
}

interface PendingForm {
  kind: "form"
  formID: string
  sessionID: string
  dir: string
  title: string
  fields: FormField[]
  currentFieldIndex: number
  answers: Record<string, unknown>
  ctx: any
  createdAt: number
}

interface PendingPermission {
  kind: "permission"
  requestID: string
  sessionID: string
  dir: string
  action: string
  resources: string[]
  ctx: any
  createdAt: number
}

type PendingItem = PendingForm | PendingPermission

class WhatsAppBridge {
  sock: any = null
  connecting = false
  connected = false
  selfPhoneJid?: string
  selfLidJid?: string
  targetJidOverride?: string
  contexts = new Map<string, any>()
  recentSessions = new Set<string>()
  sentMessageIds = new Set<string>()
  notifiedIds = new Set<string>()
  pendingQueue: PendingItem[] = []
  reconnectTimer?: ReturnType<typeof setTimeout>
  version = BRIDGE_VERSION
  generation: number = 0
  pruneTimer?: ReturnType<typeof setInterval>
  chatChain: Promise<void> = Promise.resolve()
  chatSessionID?: string
  chatSessionDir?: string
  inboxTimer?: ReturnType<typeof setInterval>
  sessionTags: Record<string, string> = {}
  activeTag?: string
  activeSessionID?: string
  lastList: string[] = []

  startInboxLoop() {
    if (this.inboxTimer) return
    this.inboxTimer = setInterval(() => {
      if (this.isStale()) {
        if (this.inboxTimer) clearInterval(this.inboxTimer)
        this.inboxTimer = undefined
        return
      }
      try {
        const outbox = path.join(DATA_DIR, "outbox.txt")
        if (fs.existsSync(outbox)) {
          const text = fs.readFileSync(outbox, "utf8").trim()
          fs.rmSync(outbox, { force: true })
          if (text) {
            logLine(`Outbox message: "${text}"`)
            void this.sendMessage(text)
          }
        }
      } catch {
        // ignore
      }
      try {
        const file = path.join(DATA_DIR, "inbox.txt")
        if (!fs.existsSync(file)) return
        const text = fs.readFileSync(file, "utf8").trim()
        fs.rmSync(file, { force: true })
        if (!text) return
        logLine(`Inbox message: "${text}"`)
        void this.handleIncomingText(text)
      } catch {
        // ignore
      }
    }, 4000)
  }

  sessionFile() {
    return path.join(DATA_DIR, "chat-session.json")
  }

  loadChatSession() {
    try {
      const file = this.sessionFile()
      if (!fs.existsSync(file)) return
      const data = JSON.parse(fs.readFileSync(file, "utf8"))
      if (typeof data?.sessionID === "string") this.chatSessionID = data.sessionID
      if (typeof data?.dir === "string") this.chatSessionDir = data.dir
    } catch {
      // ignore
    }
  }

  saveChatSession() {
    try {
      ensureDirs()
      fs.writeFileSync(
        this.sessionFile(),
        JSON.stringify({ sessionID: this.chatSessionID, dir: this.chatSessionDir }, null, 2),
        "utf8",
      )
    } catch {
      // ignore
    }
  }

  async getChatSession(ctx: any): Promise<string> {
    if (!this.chatSessionID && !this.chatSessionDir) this.loadChatSession()
    if (this.chatSessionID) {
      try {
        if (typeof ctx?.session?.get === "function") {
          const found = await ctx.session.get({ sessionID: this.chatSessionID })
          const info = found?.data ?? found
          if (info?.id) {
            if (!this.chatSessionDir) {
              this.chatSessionDir = ctx?.location?.directory
              this.saveChatSession()
            }
            return this.chatSessionID
          }
        }
      } catch {
        // session is gone; create a new one below
      }
    }
    this.chatSessionID = undefined
    const created = await ctx.session.create({ title: "WhatsApp chat" })
    const info = created?.data ?? created
    this.chatSessionID = info.id
    this.chatSessionDir = ctx?.location?.directory
    this.saveChatSession()
    logLine(`Created WhatsApp chat session ${this.chatSessionID}`)
    return this.chatSessionID
  }

  tagsFile(): string {
    return path.join(DATA_DIR, "sessions.json")
  }

  loadTags() {
    try {
      const file = this.tagsFile()
      if (!fs.existsSync(file)) return
      const data = JSON.parse(fs.readFileSync(file, "utf8"))
      if (data && typeof data === "object") {
        if (data.tags && typeof data.tags === "object") this.sessionTags = { ...data.tags }
        if (typeof data.active === "string") this.activeTag = data.active
        if (typeof data.activeSession === "string") this.activeSessionID = data.activeSession
      }
    } catch {
      // ignore
    }
  }

  saveTags() {
    try {
      ensureDirs()
      fs.writeFileSync(
        this.tagsFile(),
        JSON.stringify(
          { tags: this.sessionTags, active: this.activeTag, activeSession: this.activeSessionID },
          null,
          2,
        ),
        "utf8",
      )
    } catch {
      // ignore
    }
  }

  async listSessions(ctx: any): Promise<Array<{ id: string; title: string }>> {
    let items: any[] = []
    try {
      if (typeof ctx?.session?.list === "function") {
        const result = await ctx.session.list({ limit: 20, order: "desc" })
        items = Array.isArray(result) ? result : (result?.data ?? [])
      }
    } catch {
      // fall through to CLI
    }
    if (!Array.isArray(items) || items.length === 0) {
      const cli = await this.runCliJson("/api/session?limit=20")
      if (Array.isArray(cli?.data)) items = cli.data
    }
    return (Array.isArray(items) ? items : [])
      .filter((s: any) => s?.id && String(s.id).startsWith("ses"))
      .map((s: any) => ({ id: String(s.id), title: String(s.title || s.id) }))
  }

  // Resolve tag name -> session id
  resolveTag(name?: string): string | undefined {
    if (!name) return undefined
    const clean = name.replace(/^[@#]/, "").toLowerCase()
    const entry = Object.entries(this.sessionTags).find(([tag]) => tag.toLowerCase() === clean)
    return entry?.[1]
  }

  tagNameFor(sessionID: string): string | undefined {
    const entry = Object.entries(this.sessionTags).find(([, id]) => id === sessionID)
    return entry?.[0]
  }

  async handleCommand(text: string, ctx: any): Promise<boolean> {
    const raw = text.trim()
    const lower = raw.toLowerCase()
    const parts = raw.split(/\s+/)
    const cmd = (parts[0] || "").toLowerCase()

    if (cmd === "help" || cmd === "commands") {
      await this.sendMessage(
        [
          `${BOT_PREFIX}\n*WhatsApp commands*`,
          "",
          "`ls` â€” list sessions (numbered)",
          "`<number>` â€” work in that session",
          "`tag <number> <name>` â€” give a session a tag",
          "`@name <instruction>` â€” one message to a tagged session",
          "`use <name>` â€” make a tag active (or `use none`)",
          "`new <name> <title>` â€” create a new session",
          "`where` â€” show the active session",
          "`status` â€” bridge + pending prompts",
          "`resend` â€” re-send the current question",
        ].join("\n"),
      )
      return true
    }

    if (["ls", "sessions", "list"].includes(cmd)) {
      const sessions = await this.listSessions(ctx)
      if (sessions.length === 0) {
        await this.sendMessage(`${BOT_PREFIX}\nNo sessions found.`)
        return true
      }
      this.lastList = sessions.map((s) => s.id)
      const lines = ["*Sessions*", ""]
      sessions.forEach((s, i) => {
        const tag = this.tagNameFor(s.id)
        const active = this.activeSessionID === s.id
        lines.push(`*${i + 1}.*${active ? " âœ…" : ""} ${tag ? `[${tag}] ` : ""}${s.title}`)
      })
      lines.push(
        "",
        "_Reply with a number to work in that session._",
        "_Or tag it:_ `tag <number> <name>`",
        "_Then:_ `@name your instruction`",
      )
      await this.sendMessage(`${BOT_PREFIX}\n${lines.join("\n")}`)
      return true
    }

    if (cmd === "tag") {
      const index = Number(parts[1])
      const name = parts[2]
      if (!Number.isInteger(index) || index < 1 || index > this.lastList.length || !name) {
        await this.sendMessage(
          `${BOT_PREFIX}\nUsage: \`tag <number> <name>\`\nSend \`ls\` first to get the numbers.`,
        )
        return true
      }
      const sessionID = this.lastList[index - 1]
      this.sessionTags[name] = sessionID
      this.saveTags()
      const title = (await this.listSessions(ctx)).find((s) => s.id === sessionID)?.title || sessionID
      await this.sendMessage(`${BOT_PREFIX}\nâœ… Tagged session *${index}* as *${name}*\n${title}`)
      return true
    }

    if (cmd === "untag") {
      const name = parts[1]
      if (!name || !this.resolveTag(name)) {
        await this.sendMessage(`${BOT_PREFIX}\nUsage: \`untag <name>\``)
        return true
      }
      delete this.sessionTags[name.replace(/^[@#]/, "")]
      if (this.activeTag === name) this.activeTag = undefined
      this.saveTags()
      await this.sendMessage(`${BOT_PREFIX}\nâœ… Removed tag *${name}*`)
      return true
    }

    if (cmd === "use") {
      const name = parts[1]
      if (!name || name.toLowerCase() === "none" || name.toLowerCase() === "clear") {
        this.activeTag = undefined
        this.activeSessionID = undefined
        this.saveTags()
        await this.sendMessage(`${BOT_PREFIX}\nâœ… Cleared the active session. Messages go to the WhatsApp chat session.`)
        return true
      }
      const id = this.resolveTag(name)
      if (!id) {
        await this.sendMessage(`${BOT_PREFIX}\nNo session tagged *${name}*. Send \`ls\` to see sessions.`)
        return true
      }
      this.activeTag = name.replace(/^[@#]/, "")
      this.activeSessionID = id
      this.saveTags()
      await this.sendMessage(`${BOT_PREFIX}\nâœ… Now sending messages to *${this.activeTag}*`)
      return true
    }

    if (cmd === "where" || cmd === "current") {
      if (this.activeSessionID) {
        const sessions = await this.listSessions(ctx)
        const title = sessions.find((s) => s.id === this.activeSessionID)?.title || this.activeSessionID
        const tag = this.tagNameFor(this.activeSessionID)
        await this.sendMessage(
          `${BOT_PREFIX}\nðŸŽ¯ Active session: ${tag ? `*${tag}* â€” ` : ""}${title}\n\`use none\` to clear.`,
        )
      } else {
        await this.sendMessage(`${BOT_PREFIX}\nðŸŽ¯ Active: WhatsApp chat session (no session selected)`)
      }
      return true
    }

    if (cmd === "new") {
      const name = parts[1] && !parts[1].startsWith("-") ? parts[1] : undefined
      const title = parts.slice(name ? 2 : 1).join(" ") || name || "WhatsApp session"
      try {
        const created = await ctx.session.create({ title })
        const info = created?.data ?? created
        const id = info?.id
        if (!id) throw new Error("session id missing")
        if (name) {
          this.sessionTags[name] = id
          this.activeTag = name
        }
        this.activeSessionID = id
        this.saveTags()
        await this.sendMessage(
          `${BOT_PREFIX}\nâœ… Created session *${title}*\n${id}${name ? `\nTagged as *${name}*.` : ""}\nActive now â€” just send your instruction.`,
        )
      } catch (err: any) {
        await this.sendMessage(`${BOT_PREFIX}\nâŒ Could not create a session: ${String(err?.message || err).slice(0, 200)}`)
      }
      return true
    }

    return false
  }

  // Find the context bound to a session's location, when possible.
  async ctxForSession(ctx: any, sessionID: string): Promise<any> {
    try {
      const found = await ctx.session.get({ sessionID })
      const info = found?.data ?? found
      const dir = info?.location?.directory
      if (dir && this.contexts.has(dir)) return this.contexts.get(dir)
    } catch {
      // fall back
    }
    return ctx
  }

  // Choose a session by its number from the last `ls` listing.
  async selectByNumber(n: number, ctx: any): Promise<boolean> {
    if (!Number.isInteger(n) || n < 1 || n > this.lastList.length) return false
    const sessionID = this.lastList[n - 1]
    this.activeSessionID = sessionID
    this.activeTag = this.tagNameFor(sessionID)
    this.saveTags()
    const title = (await this.listSessions(ctx)).find((s) => s.id === sessionID)?.title || sessionID
    await this.sendMessage(
      `${BOT_PREFIX}\nâœ… Switched to *${title}*\n${this.activeTag ? `Tag: *${this.activeTag}*\n` : ""}Send your instruction now.`,
    )
    return true
  }

  async routeText(text: string, ctx: any): Promise<void> {
    if (this.isStale()) return

    if (await this.handleCommand(text, ctx)) return
    if (await this.maybeHandleScreenRequest(text)) return

    const trimmed = text.trim()

    // A bare number selects a session from the last `ls` listing.
    if (/^\d+$/.test(trimmed) && (await this.selectByNumber(Number(trimmed), ctx))) return

    // @tag / #tag / tag: prefix sends this one message to that tagged session.
    const prefixed = trimmed.match(/^[@#]([A-Za-z0-9_-]+)[\s:,]+([\s\S]+)$/)
    const colon = trimmed.match(/^([A-Za-z0-9_-]+):\s+([\s\S]+)$/)
    const explicit = prefixed || colon
    if (explicit) {
      const id = this.resolveTag(explicit[1])
      if (id) {
        const targetCtx = await this.ctxForSession(ctx, id)
        const label = this.tagNameFor(id) || id.slice(-6)
        await this.handleChatMessage(explicit[2], targetCtx, undefined, { sessionID: id, label })
        return
      }
    }

    const targetID = this.activeSessionID
    if (targetID) {
      const targetCtx = await this.ctxForSession(ctx, targetID)
      const label = this.tagNameFor(targetID)
      await this.handleChatMessage(trimmed, targetCtx, undefined, { sessionID: targetID, label })
      return
    }

    await this.handleChatMessage(trimmed, ctx)
  }

  cliBinary(): string {
    const cliExe = path.join(
      os.homedir(),
      "AppData",
      "Local",
      "Programs",
      "ai.opencode.desktop",
      "resources",
      "opencode-cli.exe",
    )
    return fs.existsSync(cliExe) ? cliExe : "opencode"
  }

  runCliJson(apiPath: string): Promise<any | undefined> {
    return new Promise((resolve) => {
      try {
        const child = spawn(this.cliBinary(), ["api", "get", apiPath], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        })
        let out = ""
        child.stdout?.on("data", (d: any) => {
          out += String(d)
        })
        child.on("error", () => resolve(undefined))
        child.on("close", () => {
          try {
            resolve(JSON.parse(out.replace(/^\uFEFF/, "").trim()))
          } catch {
            resolve(undefined)
          }
        })
      } catch {
        resolve(undefined)
      }
    })
  }

  async readSessionMessages(ctx: any, sessionID: string, logShape = false): Promise<any[]> {
    try {
      const result = await ctx.session.context({ sessionID })
      const list = Array.isArray(result)
        ? result
        : Array.isArray(result?.data)
          ? result.data
          : Array.isArray(result?.data?.messages)
            ? result.data.messages
            : Array.isArray(result?.messages)
              ? result.messages
              : []
      if (logShape) {
        const shape = Array.isArray(result)
          ? "array"
          : `${typeof result} keys=${Object.keys(result ?? {}).join("|")} data=${
              Array.isArray(result?.data) ? "array" : typeof result?.data
            }`
        logLine(`session.context shape: ${shape} (parsed ${list.length})`)
      }
      if (list.length > 0) return list
    } catch (err: any) {
      if (logShape) logLine(`session.context failed: ${err?.message || err}`)
    }

    // Fallback: ask the running server directly through the CLI.
    const cli = await this.runCliJson(`/api/session/${sessionID}/context`)
    if (Array.isArray(cli?.data)) return cli.data
    if (Array.isArray(cli)) return cli
    return []
  }

  extractAssistantText(messages: any[]): string {    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      const type = message?.type ?? message?.info?.role
      if (type !== "assistant") continue
      const content = message?.content ?? message?.parts ?? []
      if (!Array.isArray(content)) continue
      const text = content
        .filter((part: any) => (part?.type === "text" || part?.type === "markdown") && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n\n")
        .trim()
      if (text) return text
    }
    return ""
  }

  async chatReply(
    text: string,
    ctx: any,
    files?: Array<{ uri: string; name?: string; mime?: string; source?: any }>,
    opts?: { sessionID?: string; label?: string },
  ): Promise<void> {
    const sessionID = opts?.sessionID ?? (await this.getChatSession(ctx))

    const promptText = text && text.trim() ? text : files?.length ? "[Sent media from WhatsApp]" : ""
    if (typeof ctx?.session?.prompt !== "function" && !(files && files.length)) {
      await this.sendMessage(`${BOT_PREFIX}\nCould not accept chat prompts from this OpenCode plugin context.`)
      return
    }

    const startedAt = Date.now()
    await this.sendMessage(`${BOT_PREFIX}\nWorking on it...`)
    try {
      if (files?.length && typeof ctx?.session?.prompt === "function") {
        try {
          await ctx.session.prompt({ sessionID, text: promptText, files })
        } catch (err: any) {
          logLine(`ctx.session.prompt with files failed, trying CLI API: ${err?.message || err}`)
          const ok = await this.callCliApi("post", `/api/session/${sessionID}/prompt`, {
            text: promptText,
            files,
          })
          if (!ok) throw err
        }
      } else if (files?.length) {
        const ok = await this.callCliApi("post", `/api/session/${sessionID}/prompt`, {
          text: promptText,
          files,
        })
        if (!ok) throw new Error("CLI prompt API failed")
      } else if (typeof ctx?.session?.prompt === "function") {
        await ctx.session.prompt({ sessionID, text: promptText })
      } else {
        const ok = await this.callCliApi("post", `/api/session/${sessionID}/prompt`, { text: promptText })
        if (!ok) throw new Error("No prompt method available")
      }
    } catch (err: any) {
      logLine(`chatReply prompt failed: ${err?.message || err}`)
      await this.sendMessage(`${BOT_PREFIX}\nCould not send that message to OpenCode: ${String(err?.message || err).slice(0, 300)}`)
      return
    }

    let reply = ""
    let lastError = ""
    let shapeLogged = false
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      const list = await this.readSessionMessages(ctx, sessionID, !shapeLogged)
      if (!shapeLogged) {
        shapeLogged = true
        logLine(`context messages parsed: ${list.length}`)
      }
      const last = list[list.length - 1]
      const assistantIndex = (() => {
        for (let i = list.length - 1; i >= 0; i--) {
          const type = list[i]?.type ?? list[i]?.info?.role
          if (type === "assistant") return i
        }
        return -1
      })()
      if (assistantIndex >= 0) {
        const message = list[assistantIndex]
        const created = message?.time?.created ?? message?.info?.time?.created ?? 0
        const completed = Boolean(message?.time?.completed ?? message?.info?.time?.completed)
        const idleAfter = list.slice(assistantIndex + 1).some((m: any) => (m?.type ?? m?.info?.role) === "idle")
        if (created >= startedAt - 2000 && (completed || idleAfter)) {
          reply = this.extractAssistantText([message])
          if (!reply) reply = "âœ… Done."
          break
        }
      }
      void last
    }

    if (!reply) {
      await this.sendMessage(`${BOT_PREFIX}\nâ³ Still working on it â€” send *status* to check again.`)
      return
    }
    logLine(`Reply preview: ${reply.slice(0, 120).replace(/\s+/g, " ")}`)
    const attached = await this.sendAttachments(reply)
    if (attached > 0) logLine(`Attached ${attached} file(s) from the reply`)
    await this.sendChunked(reply, opts?.label)
  }

  async sendChunked(text: string, label?: string) {
    const prefix = label ? `[${label}]\n` : ""
    const limit = 3500
    if (text.length <= limit) {
      await this.sendMessage(`${BOT_PREFIX}\n${prefix}${text}`)
      return
    }
    for (let i = 0; i < text.length; i += limit) {
      const chunk = text.slice(i, i + limit)
      await this.sendMessage(`${BOT_PREFIX}\n${prefix}${chunk}`)
      await new Promise((r) => setTimeout(r, 350))
    }
  }

  // Route a free-text WhatsApp message to the OpenCode agent and send the answer back.

  handleChatMessage(
    text: string,
    ctx: any,
    files?: Array<{ uri: string; name?: string; mime?: string; source?: any }>,
    opts?: { sessionID?: string; label?: string },
  ) {
    this.chatChain = this.chatChain
      .then(() => this.chatReply(text, ctx, files, opts))
      .catch((err: any) => {
        logLine(`chatReply error: ${String(err?.message || err)}`)
      })
    return this.chatChain
  }

  async handleIncomingText(text: string) {
    if (this.isStale()) return
    const ctx =
      this.resolveCtx(this.chatSessionDir) ||
      this.resolveCtx(this.contexts.values().next().value) ||
      this.contexts.values().next().value
    if (!ctx) {
      await this.sendMessage(`${BOT_PREFIX}\nâŒ No OpenCode location is loaded yet. Try again in a moment.`)
      return
    }
    await this.routeText(text, ctx)
  }

  startPruneLoop() {
    if (this.pruneTimer) return
    this.pruneTimer = setInterval(() => {
      if (this.isStale()) {
        if (this.pruneTimer) clearInterval(this.pruneTimer)
        this.pruneTimer = undefined
        return
      }
      void this.pruneStale()
    }, 60_000)
  }

  isStale(): boolean {
    return (globalThis as any).__opencodeWhatsAppGeneration !== this.generation
  }

  stop() {
    try {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
      if (this.pruneTimer) clearInterval(this.pruneTimer)
      this.pruneTimer = undefined
      if (this.inboxTimer) clearInterval(this.inboxTimer)
      this.inboxTimer = undefined
      if (this.sock?.ev?.removeAllListeners) this.sock.ev.removeAllListeners()
      if (this.sock?.end) this.sock.end(undefined)
      logLine("Bridge stopped (replaced by newer plugin version)")
    } catch (err: any) {
      logLine(`Bridge stop error: ${err?.message || err}`)
    }
    this.sock = null
    this.connected = false
    this.connecting = false
  }

  constructor() {
    ensureDirs()
    this.restorePending()
  }

  resolveCtx(dir?: string): any {
    if (dir && this.contexts.has(dir)) return this.contexts.get(dir)
    const first = this.contexts.values().next().value
    return first
  }

  persistPending() {
    try {
      ensureDirs()
      const plain = this.pendingQueue.map((item) => {
        const { ctx, ...rest } = item as any
        return rest
      })
      fs.writeFileSync(path.join(DATA_DIR, "pending.json"), JSON.stringify(plain, null, 2), "utf8")
    } catch {
      // ignore
    }
  }

  // Drop queued prompts whose form/permission no longer exists on the server
  // (answered or cancelled while the plugin was not listening).
  async pruneStale(): Promise<number> {
    const before = this.pendingQueue.length
    const keep: PendingItem[] = []

    for (const item of this.pendingQueue) {
      if (item.kind === "permission") {
        keep.push(item)
        continue
      }
      let forms: any[] | undefined
      const ctx = (item as PendingForm).ctx || this.resolveCtx((item as PendingForm).dir)
      try {
        if (typeof ctx?.session?.form?.list === "function") {
          const result = await ctx.session.form.list({ sessionID: item.sessionID })
          const list = Array.isArray(result) ? result : (result?.data ?? undefined)
          if (Array.isArray(list)) forms = list
        }
      } catch {
        // try the CLI below
      }
      if (!forms) {
        const cli = await this.runCliJson(`/api/session/${item.sessionID}/form`)
        if (Array.isArray(cli?.data)) forms = cli.data
        else if (Array.isArray(cli)) forms = cli
      }
      if (forms) {
        if (forms.some((f: any) => f?.id === item.formID)) keep.push(item)
        continue
      }
      keep.push(item)
    }

    this.pendingQueue = keep
    if (keep.length !== before) this.persistPending()
    return before - keep.length
  }

  restorePending() {
    try {
      const file = path.join(DATA_DIR, "pending.json")
      if (!fs.existsSync(file)) return
      const raw = JSON.parse(fs.readFileSync(file, "utf8"))
      if (!Array.isArray(raw)) return
      const restored: PendingItem[] = []
      for (const item of raw) {
        if (!item || typeof item !== "object") continue
        // Only restore items younger than 12 hours
        if (typeof item.createdAt === "number" && Date.now() - item.createdAt > 12 * 60 * 60 * 1000) continue
        if (item.kind === "form" && item.formID) {
          restored.push({ ...item, ctx: undefined } as PendingForm)
        } else if (item.kind === "permission" && item.requestID) {
          restored.push({ ...item, ctx: undefined } as PendingPermission)
        }
      }
      if (restored.length > 0) {
        this.pendingQueue = restored
        logLine(`Restored ${restored.length} pending item(s) from disk`)
      }
    } catch (err: any) {
      logLine(`restorePending error: ${err?.message || err}`)
    }
  }

  getTargetJid(): string | undefined {
    if (this.targetJidOverride) return this.targetJidOverride
    return this.selfPhoneJid || this.selfLidJid
  }

  isSelfOrTargetChat(msg: any): boolean {
    const remoteJid = normalizeJid(msg?.key?.remoteJid)
    const remoteJidAlt = normalizeJid(msg?.key?.remoteJidAlt)
    const candidates = [remoteJid, remoteJidAlt].filter(Boolean) as string[]
    const allowed = [this.targetJidOverride, this.selfPhoneJid, this.selfLidJid].filter(Boolean) as string[]
    return candidates.some((c) => allowed.includes(c))
  }

  async start() {
    if (this.isStale()) return
    if (this.connecting || this.connected) return
    this.connecting = true
    logLine("Starting WhatsApp Baileys connection...")
    writeStatus({ state: "connecting" })

    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
      let version: [number, number, number] | undefined
      try {
        const latest = await fetchLatestBaileysVersion()
        version = latest.version
      } catch {
        // fall back to bundled version
      }

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger: pino({ level: "silent" }) as any,
        browser: Browsers.windows("OpenCode"),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
      })

      this.sock = sock

      sock.ev.on("creds.update", saveCreds)

      sock.ev.on("connection.update", async (update: any) => {
        if (this.isStale()) return
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          logLine("QR code received; generating qr.png and qr.html")
          try {
            await QRCode.toFile(QR_PNG_PATH, qr, {
              type: "png",
              width: 420,
              margin: 2,
            })
            const dataUrl = await QRCode.toDataURL(qr, { width: 420, margin: 2 })
            const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="5" />
  <title>Connect WhatsApp to OpenCode</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 32px; text-align: center; max-width: 420px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin: 0 0 20px; }
    img { border-radius: 12px; background: white; padding: 12px; width: 280px; height: 280px; }
    .steps { text-align: left; margin-top: 20px; font-size: 13px; color: #cbd5e1; background: #0f172a; padding: 14px 18px; border-radius: 10px; }
    .steps li { margin: 6px 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect WhatsApp to OpenCode</h1>
    <p>Scan this QR code with WhatsApp on your phone to receive and answer OpenCode questions.</p>
    <img src="${dataUrl}" alt="WhatsApp QR Code" />
    <ol class="steps">
      <li>Open <b>WhatsApp</b> on your phone</li>
      <li>Tap <b>Menu (â‹®)</b> or <b>Settings</b> &rarr; <b>Linked Devices</b></li>
      <li>Tap <b>Link a Device</b> and scan this code</li>
    </ol>
  </div>
</body>
</html>`
            fs.writeFileSync(QR_HTML_PATH, html, "utf8")
            writeStatus({
              state: "qr_ready",
              qrPngPath: QR_PNG_PATH,
              qrHtmlPath: QR_HTML_PATH,
            })
          } catch (err: any) {
            logLine(`QR generation error: ${err?.message || err}`)
          }
        }

        if (connection === "open") {
          this.connecting = false
          this.connected = true
          this.selfPhoneJid = normalizeJid(sock.user?.id)
          this.selfLidJid = normalizeJid(sock.user?.lid)
          logLine(`WhatsApp connected! user=${this.selfPhoneJid} lid=${this.selfLidJid}`)
          writeStatus({
            state: "connected",
            selfPhoneJid: this.selfPhoneJid,
            selfLidJid: this.selfLidJid,
            targetJid: this.getTargetJid(),
          })

          // Update QR HTML page to show connected status
          try {
            fs.writeFileSync(
              QR_HTML_PATH,
              `<!doctype html><html><head><meta charset="utf-8"/><title>WhatsApp Connected</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#1e293b;border:1px solid #22c55e;border-radius:16px;padding:32px;text-align:center;max-width:420px}h1{color:#4ade80;margin:0 0 12px}p{color:#cbd5e1;font-size:15px;line-height:1.5}</style></head><body><div class="card"><h1>âœ… WhatsApp Connected!</h1><p>OpenCode is now linked to <b>${this.selfPhoneJid || "your WhatsApp"}</b>.<br/><br/>Whenever OpenCode has a question or needs permission, it will message you on WhatsApp.</p></div></body></html>`,
              "utf8",
            )
            const welcomedFlag = path.join(DATA_DIR, "welcomed.flag")
            if (!fs.existsSync(welcomedFlag)) {
              fs.writeFileSync(welcomedFlag, new Date().toISOString(), "utf8")
              setTimeout(() => {
                void this.sendMessage(
                  `${BOT_PREFIX}\nâœ… *Connected to OpenCode!*\nWhenever OpenCode has a question or needs permission, it will message you here.\n\nYou can reply directly with the option number (e.g. *1*) or type your own answer.`,
                )
              }, 1500)
            }
          } catch {
            // ignore
          }
        }

        if (connection === "close") {
          this.connecting = false
          this.connected = false
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut
          logLine(`WhatsApp connection closed (status=${statusCode}, reconnect=${shouldReconnect})`)
          writeStatus({ state: "disconnected", statusCode, shouldReconnect })

          if (shouldReconnect) {
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
            this.reconnectTimer = setTimeout(() => {
              void this.start()
            }, 4000)
          } else {
            // Logged out: clear auth dir so a fresh QR code can be generated
            try {
              fs.rmSync(AUTH_DIR, { recursive: true, force: true })
              ensureDirs()
            } catch {
              // ignore
            }
            this.reconnectTimer = setTimeout(() => {
              void this.start()
            }, 2000)
          }
        }
      })

      sock.ev.on("messages.upsert", async (m: any) => {
        if (this.isStale()) return
        if (m.type !== "notify") return
        for (const msg of m.messages || []) {
          await this.handleIncomingMessage(msg)
        }
      })
    } catch (err: any) {
      this.connecting = false
      logLine(`WhatsApp start error: ${err?.message || err}`)
      writeStatus({ state: "error", error: String(err?.message || err) })
      this.reconnectTimer = setTimeout(() => {
        void this.start()
      }, 6000)
    }
  }

  async sendMessage(text: string): Promise<boolean> {
    const jid = this.getTargetJid()
    if (!jid) {
      logLine("Cannot send WhatsApp message: no target JID")
      return false
    }
    const fullText = text.startsWith(BOT_PREFIX) ? text : `${BOT_PREFIX}\n${text}`

    for (let attempt = 1; attempt <= 5; attempt++) {
      if (!this.connected || !this.sock) {
        await this.forceReconnect()
        await new Promise((r) => setTimeout(r, 3500))
      }
      try {
        const sent = await this.sock.sendMessage(jid, { text: fullText })
        if (sent?.key?.id) {
          this.sentMessageIds.add(sent.key.id)
          if (this.sentMessageIds.size > 500) {
            const first = this.sentMessageIds.values().next().value
            if (first) this.sentMessageIds.delete(first)
          }
        }
        logLine(`Sent WhatsApp message to ${jid} (id=${sent?.key?.id})`)
        return true
      } catch (err: any) {
        logLine(`Send attempt ${attempt} failed: ${err?.message || err}`)
        await this.forceReconnect()
        await new Promise((r) => setTimeout(r, 3000 * attempt))
      }
    }
    logLine("Giving up sending WhatsApp message")
    return false
  }

  async forceReconnect() {
    try {
      if (this.sock?.ev?.removeAllListeners) this.sock.ev.removeAllListeners()
      if (this.sock?.end) this.sock.end(undefined)
    } catch {
      // ignore
    }
    this.sock = null
    this.connected = false
    this.connecting = false
    await this.start()
  }

  mimeFor(file: string): string {
    const ext = path.extname(file).toLowerCase()
    switch (ext) {
      case ".png":
        return "image/png"
      case ".jpg":
      case ".jpeg":
        return "image/jpeg"
      case ".webp":
        return "image/webp"
      case ".gif":
        return "image/gif"
      case ".pdf":
        return "application/pdf"
      case ".mp4":
        return "video/mp4"
      default:
        return "application/octet-stream"
    }
  }

  // Send a local file (screenshot, chart, PDF...) to the user's WhatsApp.
  async sendFile(filePath: string, caption?: string): Promise<boolean> {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)
      if (!fs.existsSync(resolved)) {
        logLine(`sendFile: not found ${resolved}`)
        return false
      }
      const stat = fs.statSync(resolved)
      if (stat.size > 60 * 1024 * 1024) {
        logLine(`sendFile: too large ${resolved} (${stat.size} bytes)`)
        return false
      }
      const jid = this.getTargetJid()
      if (!jid) return false

      const mime = this.mimeFor(resolved)
      const buffer = fs.readFileSync(resolved)
      const isImage = mime.startsWith("image/")
      const payload: any = isImage
        ? { image: buffer, mimetype: mime, caption: caption || "" }
        : mime === "video/mp4"
          ? { video: buffer, mimetype: mime, caption: caption || "" }
          : { document: buffer, mimetype: mime, fileName: path.basename(resolved), caption: caption || "" }

      for (let attempt = 1; attempt <= 3; attempt++) {
        if (!this.connected || !this.sock) {
          await this.forceReconnect()
          await new Promise((r) => setTimeout(r, 3500))
        }
        try {
          const sent = await this.sock.sendMessage(jid, payload)
          if (sent?.key?.id) this.sentMessageIds.add(sent.key.id)
          logLine(`Sent ${isImage ? "image" : "file"} to ${jid}: ${path.basename(resolved)}`)
          return true
        } catch (err: any) {
          logLine(`sendFile attempt ${attempt} failed: ${err?.message || err}`)
          await this.forceReconnect()
          await new Promise((r) => setTimeout(r, 2000 * attempt))
        }
      }
      return false
    } catch (err: any) {
      logLine(`sendFile error: ${err?.message || err}`)
      return false
    }
  }

  // Find image/file paths mentioned in an agent reply so they can be attached.
  findFilePaths(text: string): string[] {
    const found = new Set<string>()
    const patterns = [
      /!\[[^\]]*\]\(([^)]+)\)/g,
      /(?:[A-Za-z]:\\[^\s"'`<>|*?]+\.(?:png|jpe?g|webp|gif|pdf|mp4))/gi,
      /(?:~?\/[^\s"'`<>|*?]+\.(?:png|jpe?g|webp|gif|pdf|mp4))/g,
      /(?:file:\/\/\/?[^\s"'`<>|*?]+\.(?:png|jpe?g|webp|gif|pdf|mp4))/gi,
    ]
    for (const pattern of patterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        let value = (match[1] || match[0]).replace(/^file:\/\/\/?/, "")
        if (process.platform === "win32" && /^\/[A-Za-z]:/.test(value)) value = value.slice(1)
        if (value.includes("://")) continue
        found.add(value)
      }
    }
    return [...found]
  }

  runCommand(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const child = spawn(command, args, { stdio: "ignore", windowsHide: true })
        child.on("error", () => resolve(false))
        child.on("close", (code) => resolve(code === 0))
      } catch {
        resolve(false)
      }
    })
  }

  // Capture the desktop and return the saved image path.
  async captureScreen(): Promise<string | undefined> {
    ensureDirs()
    const file = path.join(MEDIA_DIR, `screenshot-${Date.now()}.png`)
    try {
      if (process.platform === "win32") {
        const escaped = file.replace(/\\/g, "\\\\")
        const script =
          "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
          "$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; " +
          "$bmp=New-Object System.Drawing.Bitmap $vs.Width,$vs.Height; " +
          "$g=[System.Drawing.Graphics]::FromImage($bmp); " +
          "$g.CopyFromScreen($vs.Left,$vs.Top,0,0,$bmp.Size); " +
          `$bmp.Save('${escaped}',[System.Drawing.Imaging.ImageFormat]::Png); ` +
          "$g.Dispose(); $bmp.Dispose()"
        await this.runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", script])
      } else if (process.platform === "darwin") {
        await this.runCommand("screencapture", ["-x", file])
      } else {
        const attempts: Array<[string, string[]]> = [
          ["gnome-screenshot", ["-f", file]],
          ["spectacle", ["-b", "-n", "-o", file]],
          ["scrot", ["-o", file]],
          ["import", ["-window", "root", file]],
        ]
        for (const [cmd, args] of attempts) {
          await this.runCommand(cmd, args)
          if (fs.existsSync(file)) break
        }
      }
    } catch (err: any) {
      logLine(`captureScreen error: ${err?.message || err}`)
    }
    return fs.existsSync(file) ? file : undefined
  }

  // "screenshot" style requests are handled directly, without involving an agent.
  async maybeHandleScreenRequest(text: string): Promise<boolean> {
    const clean = text.trim().toLowerCase().replace(/[.!?]+$/, "")
    const wants =
      clean === "screenshot" ||
      clean === "ss" ||
      clean === "screen shot" ||
      clean === "screen capture" ||
      clean === "take a screenshot" ||
      clean === "send a screenshot" ||
      /^(take |send |get |show )?(me )?(a )?(desktop |screen )?(screenshot|screen shot|screen capture)$/.test(clean)
    if (!wants) return false

    await this.sendMessage(`${BOT_PREFIX}\nðŸ“¸ Capturing the screenâ€¦`)
    const file = await this.captureScreen()
    if (!file) {
      await this.sendMessage(`${BOT_PREFIX}\nâŒ Could not capture the screen on this machine.`)
      return true
    }
    const ok = await this.sendFile(file, "Desktop screenshot")
    if (!ok) await this.sendMessage(`${BOT_PREFIX}\nâŒ Captured the screen but could not send the image.`)
    return true
  }

  async sendAttachments(text: string): Promise<number> {    let count = 0
    for (const candidate of this.findFilePaths(text)) {
      const resolved = path.isAbsolute(candidate)
        ? candidate
        : path.isAbsolute(candidate.replace(/^~/, ""))
          ? candidate.replace(/^~/, os.homedir())
          : candidate.startsWith("/")
            ? candidate
            : path.resolve(candidate)
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        const ok = await this.sendFile(resolved)
        if (ok) count++
      }
    }
    return count
  }

  formatFieldPrompt(field: FormField, index: number, total: number): string {
    const lines: string[] = []
    const prefix = total > 1 ? `*Question ${index + 1} of ${total}:*\n` : ""
    const title = field.title || field.description || field.key
    const desc = field.title && field.description && field.description !== field.title ? `\n_${field.description}_` : ""
    lines.push(`${prefix}*${title}*${desc}`)

    if (field.options && field.options.length > 0) {
      lines.push("")
      field.options.forEach((opt, idx) => {
        const detail = opt.description ? ` â€” ${opt.description}` : ""
        lines.push(`*${idx + 1}.* ${opt.label}${detail}`)
      })
      if (field.type === "multiselect") {
        lines.push(`\n_Reply with option numbers separated by commas (e.g. 1, 2) or type your own answer._`)
      } else {
        lines.push(`\n_Reply with a number (1-${field.options.length}) or type your own answer._`)
      }
    } else {
      lines.push(`\n_Reply with your answer._`)
    }
    return lines.join("\n")
  }

  async handleFormCreated(form: any, ctx: any) {
    if (!form?.id || this.notifiedIds.has(form.id)) return
    this.notifiedIds.add(form.id)

    const fields: FormField[] = Array.isArray(form.fields) ? form.fields : []
    if (fields.length === 0) return

    const pending: PendingForm = {
      kind: "form",
      formID: form.id,
      sessionID: form.sessionID,
      dir: ctx?.location?.directory || "",
      title: form.title || "Question",
      fields,
      currentFieldIndex: 0,
      answers: {},
      ctx,
      createdAt: Date.now(),
    }

    // Remove any older settled/stale items for the same formID
    this.pendingQueue = this.pendingQueue.filter((p) => !(p.kind === "form" && p.formID === form.id))
    this.pendingQueue.push(pending)
    this.recentSessions.add(form.sessionID)

    // Focus this session so the next WhatsApp reply lands here.
    this.activeSessionID = form.sessionID
    this.activeTag = this.tagNameFor(form.sessionID)
    this.saveTags()

    this.persistPending()

    const projectName = path.basename(ctx?.location?.directory || "") || "OpenCode"
    const header = `${BOT_PREFIX} â€” *${projectName}*\n`
    const body = this.formatFieldPrompt(fields[0], 0, fields.length)
    await this.sendMessage(`${header}\n${body}`)
  }

  async handleQuestionToolFallback(sessionID: string, input: any, ctx: any) {
    // Wait briefly to let form.created handle it first if OpenCode emits form.created for this question
    await new Promise((r) => setTimeout(r, 450))
    const alreadyHandledByForm = this.pendingQueue.some(
      (p) => p.kind === "form" && p.sessionID === sessionID && Date.now() - p.createdAt < 5000,
    )
    if (alreadyHandledByForm) return

    const questions = Array.isArray(input?.questions) ? input.questions : []
    if (questions.length === 0) return

    const hash = `${sessionID}:${questions.map((q: any) => q.question).join("|")}`
    if (this.notifiedIds.has(hash)) return
    this.notifiedIds.add(hash)

    const projectName = path.basename(ctx?.location?.directory || "") || "OpenCode"
    const lines: string[] = [`${BOT_PREFIX} â€” *${projectName}*`]
    questions.forEach((q: any, qIdx: number) => {
      const qHeader = q.header ? `[${q.header}] ` : ""
      lines.push(`\n*${questions.length > 1 ? `Q${qIdx + 1}: ` : ""}${qHeader}${q.question}*`)
      if (Array.isArray(q.options)) {
        q.options.forEach((opt: any, oIdx: number) => {
          lines.push(`*${oIdx + 1}.* ${opt.label}${opt.description ? ` â€” ${opt.description}` : ""}`)
        })
      }
    })
    await this.sendMessage(lines.join("\n"))
  }

  async handlePermissionAsked(data: any, ctx: any) {
    if (!data?.id || this.notifiedIds.has(data.id)) return
    this.notifiedIds.add(data.id)

    const pending: PendingPermission = {
      kind: "permission",
      requestID: data.id,
      sessionID: data.sessionID,
      dir: ctx?.location?.directory || "",
      action: data.action,
      resources: Array.isArray(data.resources) ? data.resources : [],
      ctx,
      createdAt: Date.now(),
    }
    this.pendingQueue.push(pending)
    this.recentSessions.add(data.sessionID)

    // Focus this session so the next WhatsApp reply lands here.
    this.activeSessionID = data.sessionID
    this.activeTag = this.tagNameFor(data.sessionID)
    this.saveTags()

    this.persistPending()

    const projectName = path.basename(ctx?.location?.directory || "") || "OpenCode"
    const lines = [
      `${BOT_PREFIX} â€” *Permission Needed (${projectName})*`,
      "",
      `Action: \`${data.action}\``,
      pending.resources.length ? `Resources: \`${pending.resources.join(", ")}\`` : "",
      "",
      "*1.* Allow once",
      "*2.* Always allow",
      "*3.* Reject",
      "",
      "_Reply with 1, 2, or 3._",
    ].filter(Boolean)

    await this.sendMessage(lines.join("\n"))
  }

  removePendingForm(formID: string) {
    this.pendingQueue = this.pendingQueue.filter((p) => !(p.kind === "form" && p.formID === formID))
    this.persistPending()
  }

  removePendingPermission(requestID: string) {
    this.pendingQueue = this.pendingQueue.filter((p) => !(p.kind === "permission" && p.requestID === requestID))
    this.persistPending()
  }

  // Re-send the prompt for the newest pending item, so a lost message can be recovered.
  async resendPending() {
    const active = this.pendingQueue[this.pendingQueue.length - 1]
    if (!active) {
      await this.sendMessage(
        `${BOT_PREFIX}\nâœ… Nothing is waiting on you right now. OpenCode has no unanswered question or permission request.`,
      )
      return
    }
    if (active.kind === "permission") {
      await this.sendMessage(
        [
          `${BOT_PREFIX}\n*Permission Needed*`,
          "",
          `Action: \`${active.action}\``,
          active.resources.length ? `Resources: \`${active.resources.join(", ")}\`` : "",
          "",
          "*1.* Allow once",
          "*2.* Always allow",
          "*3.* Reject",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      return
    }
    const index = active.fields[active.currentFieldIndex] ? active.currentFieldIndex : 0
    const field = active.fields[index]
    if (!field) return
    await this.sendMessage(
      `${BOT_PREFIX}\n*${active.title}*\n\n${this.formatFieldPrompt(field, index, active.fields.length)}`,
    )
  }

  async handleIncomingMessage(msg: any) {
    if (this.isStale()) return
    const id = msg?.key?.id
    if (!id || this.sentMessageIds.has(id)) return
    if (!this.isSelfOrTargetChat(msg)) return

    const text = this.extractMessageText(msg)
    const media = await this.extractIncomingMedia(msg)
    if (!text && (!media || media.length === 0)) return
    if (text && text.startsWith(BOT_PREFIX) && (!media || media.length === 0)) return

    const preview = text ? `"${text}"` : `[${media.map((m: any) => m.kind).join(", ")}]`
    logLine(`Received WhatsApp message: ${preview} (from=${msg?.key?.remoteJid}, media=${media.length})`)

    const lower = (text || "").toLowerCase().trim()
    if (lower && (!media || media.length === 0)) {
      if (lower === "/wa status" || lower === "/status" || lower === "status") {
        await this.sendMessage(
          [
            `${BOT_PREFIX}\n*Bridge is active.*`,
            `Pending prompts: *${this.pendingQueue.length}*`,
            this.pendingQueue.length
              ? `Waiting on: ${this.pendingQueue.map((p: any) => (p.kind === "form" ? `question (${p.title})` : `permission (${p.action})`)).join(", ")}`
              : "",
            "_Send *resend* to see the current prompt again._",
          ].filter(Boolean).join("\n"),
        )
        return
      }
      if (lower === "resend" || lower === "?" || lower === "again") {
        await this.resendPending()
        return
      }
      if (await this.maybeHandleScreenRequest(text)) return
    }

    const bridgeCtx =
      this.resolveCtx(this.chatSessionDir) ||
      this.resolveCtx((this.pendingQueue[this.pendingQueue.length - 1] as any)?.dir) ||
      this.contexts.values().next().value

    // Commands like ls / tag / use / new / where
    if (text && (!media || media.length === 0) && bridgeCtx) {
      if (await this.handleCommand(text, bridgeCtx)) return
    }

    const wantsChat = lower.startsWith("chat ") || lower.startsWith("ask ") || media.length > 0
    const active = wantsChat ? undefined : this.pendingQueue[this.pendingQueue.length - 1]
    if (!active) {
      const question = lower.startsWith("chat ") || lower.startsWith("ask ") ? text.replace(/^(chat|ask)\s+/i, "") : text
      if (!bridgeCtx) {
        await this.sendMessage(`${BOT_PREFIX}\nNo OpenCode location is loaded yet. Try again in a moment.`)
        return
      }
      if (media.length > 0) {
        const targetID = this.activeSessionID
        const targetCtx = targetID ? await this.ctxForSession(bridgeCtx, targetID) : bridgeCtx
        await this.handleChatMessage(
          question || "[Image/media received from WhatsApp]",
          targetCtx,
          media,
          targetID ? { sessionID: targetID, label: this.tagNameFor(targetID) } : undefined,
        )
        return
      }
      await this.routeText(question, bridgeCtx)
      return
    }

    if (media.length > 0 && !String(text || "").trim()) {
      await this.sendMessage(
        `${BOT_PREFIX}\nI received your media, but there is a pending prompt. Please answer the prompt with text, or send *resend*.`,
      )
      return
    }

    if (active.kind === "permission") {
      const decisionText = String(text || "").trim().toLowerCase()
      let decision: "once" | "always" | "reject" | undefined
      if (["1", "once", "yes", "y", "allow", "ok"].includes(decisionText)) decision = "once"
      else if (["2", "always", "all"].includes(decisionText)) decision = "always"
      else if (["3", "reject", "no", "n", "deny", "cancel"].includes(decisionText)) decision = "reject"

      if (!decision) {
        await this.sendMessage(
          `${BOT_PREFIX}\n_Please reply with *1* (Allow once), *2* (Always allow), or *3* (Reject)._`,
        )
        return
      }

      this.removePendingPermission(active.requestID)
      const ok = await this.submitPermissionReply(active, decision)
      if (ok) {
        await this.sendMessage(`${BOT_PREFIX}\nâœ… Permission *${decision}* submitted.`)
      } else {
        await this.sendMessage(
          `${BOT_PREFIX}\nâŒ Could not submit the permission reply â€” it may have already been answered in OpenCode.`,
        )
      }
      return
    }

    if (active.kind === "form") {
      const currentField = active.fields[active.currentFieldIndex]
      if (!currentField) return

      active.answers[currentField.key] = this.resolveFieldValue(currentField, String(text || ""))
      active.currentFieldIndex += 1
      this.persistPending()

      if (active.currentFieldIndex < active.fields.length) {
        const nextField = active.fields[active.currentFieldIndex]
        const prompt = this.formatFieldPrompt(nextField, active.currentFieldIndex, active.fields.length)
        await this.sendMessage(`${BOT_PREFIX}\n${prompt}`)
      } else {
        this.removePendingForm(active.formID)
        const ok = await this.submitFormReply(active)
        if (ok) {
          await this.sendMessage(`${BOT_PREFIX}\nâœ… Answer submitted to OpenCode!`)
        } else {
          await this.sendMessage(
            `${BOT_PREFIX}\nâŒ Could not submit that answer â€” the question may have already been answered in OpenCode.`,
          )
        }
      }
    }
  }

  unwrapMessage(m: any): any {
    let cur = m
    for (let i = 0; i < 6 && cur; i++) {
      if (cur.ephemeralMessage?.message) {
        cur = cur.ephemeralMessage.message
        continue
      }
      if (cur.viewOnceMessage?.message) {
        cur = cur.viewOnceMessage.message
        continue
      }
      if (cur.viewOnceMessageV2?.message) {
        cur = cur.viewOnceMessageV2.message
        continue
      }
      if (cur.viewOnceMessageV2Extension?.message) {
        cur = cur.viewOnceMessageV2Extension.message
        continue
      }
      if (cur.documentWithCaptionMessage?.message) {
        cur = cur.documentWithCaptionMessage.message
        continue
      }
      if (cur.editedMessage?.message) {
        cur = cur.editedMessage.message
        continue
      }
      break
    }
    return cur || {}
  }

  extractMessageText(msg: any): string {
    const m = this.unwrapMessage(msg?.message)
    if (!m) return ""
    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.documentMessage?.caption ||
      ""
    ).trim()
  }

  getMediaKind(m: any): { kind: "image" | "video" | "audio" | "document" | "sticker"; node: any } | undefined {
    if (m?.imageMessage) return { kind: "image", node: m.imageMessage }
    if (m?.videoMessage) return { kind: "video", node: m.videoMessage }
    if (m?.audioMessage) return { kind: "audio", node: m.audioMessage }
    if (m?.documentMessage) return { kind: "document", node: m.documentMessage }
    if (m?.stickerMessage) return { kind: "sticker", node: m.stickerMessage }
    return undefined
  }

  extForMime(mime?: string, kind?: string): string {
    const m = String(mime || "").toLowerCase()
    if (m.includes("jpeg") || m.includes("jpg")) return ".jpg"
    if (m.includes("png")) return ".png"
    if (m.includes("webp")) return ".webp"
    if (m.includes("gif")) return ".gif"
    if (m.includes("mp4")) return ".mp4"
    if (m.includes("webm")) return ".webm"
    if (m.includes("ogg")) return ".ogg"
    if (m.includes("mpeg") || m.includes("mp3")) return ".mp3"
    if (m.includes("pdf")) return ".pdf"
    if (kind === "image") return ".jpg"
    if (kind === "video") return ".mp4"
    if (kind === "audio") return ".ogg"
    if (kind === "sticker") return ".webp"
    return ".bin"
  }

  async extractIncomingMedia(msg: any): Promise<Array<{ uri: string; name: string; mime: string; kind: string }>> {
    try {
      const raw = msg?.message
      const m = this.unwrapMessage(raw)
      const media = this.getMediaKind(m)
      if (!media || !downloadMediaMessage) return []
      if (!this.sock) {
        logLine("Cannot download WhatsApp media: socket unavailable")
        return []
      }
      ensureDirs()
      const buf = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        {
          logger: pino({ level: "silent" }) as any,
          reuploadRequest: this.sock.updateMediaMessage,
        },
      )
      if (!buf || !(buf as Buffer).length) return []
      const mime = String(media.node?.mimetype || "application/octet-stream")
      const ext = this.extForMime(mime, media.kind)
      const safeId = String(msg?.key?.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "")
      const filename = `${Date.now()}-${safeId}-${media.kind}${ext}`
      const filePath = path.join(MEDIA_DIR, filename)
      fs.writeFileSync(filePath, buf as Buffer)
      const uri = pathToFileURL(filePath).href
      const name = media.node?.fileName || filename
      logLine(`Saved WhatsApp ${media.kind} (${mime}, ${(buf as Buffer).length} bytes) to ${filePath}`)
      return [{ uri, name, mime, kind: media.kind }]
    } catch (err: any) {
      logLine(`Failed to download WhatsApp media: ${err?.message || err}`)
      return []
    }
  }

  resolveFieldValue(field: FormField, rawInput: string): unknown {
    const trimmed = rawInput.trim()
    const options = field.options || []

    if (field.type === "multiselect") {
      const parts = trimmed
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const resolved = parts.map((part) => {
        const num = Number(part)
        if (Number.isInteger(num) && num >= 1 && num <= options.length) {
          return options[num - 1].value ?? options[num - 1].label
        }
        const match = options.find(
          (o) => o.label.toLowerCase() === part.toLowerCase() || o.value.toLowerCase() === part.toLowerCase(),
        )
        return match ? (match.value ?? match.label) : part
      })
      return resolved
    }

    if (options.length > 0) {
      const num = Number(trimmed)
      if (Number.isInteger(num) && num >= 1 && num <= options.length) {
        return options[num - 1].value ?? options[num - 1].label
      }
      const match = options.find(
        (o) => o.label.toLowerCase() === trimmed.toLowerCase() || o.value.toLowerCase() === trimmed.toLowerCase(),
      )
      if (match) return match.value ?? match.label
    }

    if (field.type === "boolean") {
      return ["1", "true", "yes", "y", "ok"].includes(trimmed.toLowerCase())
    }
    if (field.type === "number" || field.type === "integer") {
      const n = Number(trimmed)
      if (!Number.isNaN(n)) return n
    }

    return trimmed
  }

  async submitFormReply(pending: PendingForm) {
    const { sessionID, formID, answers } = pending
    const ctx = pending.ctx || this.resolveCtx(pending.dir)
    logLine(`Submitting form reply formID=${formID} sessionID=${sessionID} answers=${JSON.stringify(answers)}`)

    try {
      if (typeof ctx?.session?.form?.reply === "function") {
        await ctx.session.form.reply({ sessionID, formID, answer: answers })
        return true
      }
      if (typeof ctx?.form?.reply === "function") {
        await ctx.form.reply({ sessionID, formID, answer: answers })
        return true
      }
    } catch (err: any) {
      logLine(`Direct ctx form.reply failed, falling back to CLI API: ${err?.message || err}`)
    }

    return await this.callCliApi("post", `/api/session/${sessionID}/form/${formID}/reply`, {
      answer: answers,
    })
  }

  async submitPermissionReply(pending: PendingPermission, decision: "once" | "always" | "reject") {
    const { sessionID, requestID } = pending
    const ctx = pending.ctx || this.resolveCtx(pending.dir)
    logLine(`Submitting permission reply requestID=${requestID} decision=${decision}`)

    try {
      if (typeof ctx?.permission?.reply === "function") {
        await ctx.permission.reply({ sessionID, requestID, decision })
        return true
      }
    } catch (err: any) {
      logLine(`Direct ctx permission.reply failed, falling back to CLI API: ${err?.message || err}`)
    }

    return await this.callCliApi("post", `/api/session/${sessionID}/permission/${requestID}/reply`, {
      decision,
    })
  }

  callCliApi(method: string, apiPath: string, payload: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      const cliExe = path.join(
        os.homedir(),
        "AppData",
        "Local",
        "Programs",
        "ai.opencode.desktop",
        "resources",
        "opencode-cli.exe",
      )
      const bin = fs.existsSync(cliExe) ? cliExe : "opencode"
      const child = spawn(bin, ["api", method, apiPath, "--data", JSON.stringify(payload)], {
        stdio: "ignore",
        windowsHide: true,
      })
      child.on("error", (err) => {
        logLine(`CLI API spawn error: ${err.message}`)
        resolve(false)
      })
      child.on("close", (code) => {
        resolve(code === 0)
      })
    })
  }
}

function getBridge(): WhatsAppBridge {
  const g = globalThis as any
  const existing = g.__opencodeWhatsAppBridge as WhatsAppBridge | undefined
  if (existing && existing.version === BRIDGE_VERSION) return existing
  if (existing) {
    try {
      if (typeof existing.stop === "function") existing.stop()
    } catch {
      // ignore
    }
  }
  g.__opencodeWhatsAppGeneration = (g.__opencodeWhatsAppGeneration ?? 0) + 1
  const bridge = new WhatsAppBridge()
  bridge.generation = g.__opencodeWhatsAppGeneration
  g.__opencodeWhatsAppBridge = bridge
  return bridge
}

export default {
  id: "whatsapp",
  async setup(ctx: any) {
    const bridge = getBridge()
    bridge.loadTags()
    const dir = ctx?.location?.directory || "default"
    bridge.contexts.set(dir, ctx)
    void bridge.pruneStale()

    if (typeof ctx?.options?.targetNumber === "string" && ctx.options.targetNumber.trim()) {
      const digits = ctx.options.targetNumber.replace(/\D/g, "")
      if (digits) bridge.targetJidOverride = `${digits}@s.whatsapp.net`
    }

    void bridge.start()
    bridge.startPruneLoop()
    bridge.startInboxLoop()

    // 1. Subscribe to form and permission events
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["form.created", "form.replied", "form.cancelled", "permission.asked", "permission.replied"],
          signal: controller.signal,
        })) {
          if (event.type === "form.created") {
            await bridge.handleFormCreated(event.data?.form, ctx)
          } else if (event.type === "form.replied" || event.type === "form.cancelled") {
            if (event.data?.id) bridge.removePendingForm(event.data.id)
          } else if (event.type === "permission.asked") {
            await bridge.handlePermissionAsked(event.data, ctx)
          } else if (event.type === "permission.replied") {
            if (event.data?.id) bridge.removePendingPermission(event.data.id)
          }
        }
      } catch (err: any) {
        if (!controller.signal.aborted) {
          logLine(`Event stream error in ${dir}: ${err?.message || err}`)
        }
      }
    })()

    // 2. Fallback hook for `question` tool execution
    let toolHook: any
    try {
      toolHook = await ctx.tool.hook("execute.before", async (event: any) => {
        if (event.tool === "question") {
          void bridge.handleQuestionToolFallback(event.sessionID, event.input, ctx)
        }
      })
    } catch (err: any) {
      logLine(`Tool hook registration error: ${err?.message || err}`)
    }

    // 3. Register `/whatsapp` command to check status or send a test notification
    let cmdReg: any
    try {
      cmdReg = await ctx.command.transform((editor: any) => {
        editor.add({
          name: "whatsapp",
          description: "Check WhatsApp connection status or send a test WhatsApp message",
          execute: async ({ sessionID }: any) => {
            const sent = await bridge.sendMessage(
              `${BOT_PREFIX}\nðŸ”” Test notification from OpenCode! Your WhatsApp question bridge is working.`,
            )
            const statusText = bridge.connected
              ? `âœ… WhatsApp is connected (${bridge.getTargetJid()}) and a test message was sent!`
              : `â³ WhatsApp is not linked yet. Scan the QR code at: ${QR_HTML_PATH}`
            await ctx.session.synthetic({
              sessionID,
              text: statusText,
            })
          },
        })
      })
    } catch (err: any) {
      logLine(`Command registration error: ${err?.message || err}`)
    }

    // 4. Tool: let the agent push files/images (screenshots) to WhatsApp
    let toolReg: any
    try {
      toolReg = await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "whatsapp_send_file",
          description:
            "Send a local file from this computer to the user's WhatsApp (screenshot, photo, chart, PDF). Use this whenever the user asks to receive an image or file on WhatsApp.",
          input: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path to the file to send" },
              caption: { type: "string", description: "Optional caption shown with the file" },
            },
            required: ["path"],
            additionalProperties: false,
          },
          execute: async (input: any) => {
            const ok = await bridge.sendFile(String(input?.path || ""), input?.caption)
            return {
              content: ok
                ? `Sent ${input?.path} to the user's WhatsApp.`
                : `Could not send ${input?.path}. Check that the path exists and WhatsApp is connected.`,
            }
          },
        })
      })
    } catch (err: any) {
      logLine(`Tool registration error: ${err?.message || err}`)
    }

    return async () => {
      controller.abort()
      bridge.contexts.delete(dir)
      if (toolHook?.dispose) await toolHook.dispose()
      if (cmdReg?.dispose) await cmdReg.dispose()
      if (toolReg?.dispose) await toolReg.dispose()
    }
  },
}
