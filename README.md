# opencode-whatsapp

Use [OpenCode](https://opencode.ai) from WhatsApp.

Your agent's questions, permission prompts and replies travel to your phone. You can
answer with a number, chat with the agent, and — the useful part — **talk to any
session separately** without opening the desktop app.

```
You  →  WhatsApp  →  OpenCode (plugin)  →  your session
You  ←  WhatsApp  ←  agent reply / question  ←
```

---

## Features

### Every session, reachable from one chat

Send `ls` and you get your sessions as a numbered list. Pick a number and you are
talking to that session — all following messages go there until you switch again.

```
1. ✅ WhatsApp alerts from OpenCode   [wa]
2. Modular Android dashboard          [deskgadget]
3. Brainstorming session
```

- `2` — continue in session 2
- `tag 2 deskgadget` — give it a short name
- `@deskgadget fix the build` — one instruction, without switching
- `new frontend Build the settings page` — create a fresh session and start working
- `where` — remind yourself which session is active

Each session keeps its own history, files and context. Conversations do not bleed
into each other; the bridge only decides *where* your next message goes.

### Automatic switching when OpenCode needs you

When **any** session asks a question or requests permission, the bridge forwards the
prompt to WhatsApp and makes that session the active one. You reply once — with a
number or free text — and the answer lands in exactly the session that asked,
even if you were talking to a different one a moment ago. After that you stay in that
session until you switch.

### Native question + permission handling

- Numbered options: reply `1`, `2`, … or type your own answer.
- Multi-question forms are asked one at a time.
- Permission prompts: `1` allow once, `2` always allow, `3` reject.
- Image and document messages are forwarded to the agent.

### Completion notifications

Any session that finishes a task — started from the desktop, a schedule, or another
agent — sends a short summary to WhatsApp: the session name, the project, the final
message, and a note that replying continues in that session. Failed and interrupted
runs are labelled too. Runs you started from WhatsApp are not duplicated; the chat
reply itself is the notification.

### Screenshots and files on demand

Send `screenshot` (or `ss`, `screen shot`, `take a screenshot`) and the bridge
captures the desktop itself and sends the PNG back to WhatsApp — no agent round
trip, works even while a question is pending.

Agents can also push files: the plugin registers a `whatsapp_send_file` tool
(`path`, optional `caption`), so a session can send a screenshot, chart or PDF
straight to your phone. Any local image path an agent mentions in a reply is
attached automatically as well.

### Survives restarts

Open questions and the active session are persisted. After a restart the bridge
reconnects with the saved WhatsApp credentials and restores what was open.

---

## Install

### Option A — install script (recommended)

```bash
git clone https://github.com/issacjohn/opencode-whatsapp.git
cd opencode-whatsapp

# macOS / Linux
bash scripts/install.sh

# Windows
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

This copies the plugin to `~/.config/opencode/plugins/whatsapp`, the skill to
`~/.config/opencode/skills/whatsapp`, and installs its dependencies.

### Option B — OpenCode plugin manager

```bash
opencode plugin add opencode-whatsapp
```

### Option C — manual

1. Copy `src/index.ts` to `~/.config/opencode/plugins/whatsapp/index.ts`
2. Copy `skills/whatsapp/SKILL.md` to `~/.config/opencode/skills/whatsapp/SKILL.md`
3. Install dependencies in your config directory:

```bash
cd ~/.config/opencode
npm install @whiskeysockets/baileys qrcode pino
```

OpenCode watches its config directory and loads the plugin automatically — no
restart needed for the install itself.

---

## Pair your WhatsApp

1. Start OpenCode. On first load the plugin opens a WhatsApp linked-device session
   and writes a QR code.
2. Open the pairing page:
   - **Windows:** `%USERPROFILE%\.local\share\opencode\whatsapp\qr.html`
   - **macOS / Linux:** `~/.local/share/opencode/whatsapp/qr.html`

   The same QR is saved as `qr.png`. In OpenCode Desktop the file can be previewed
   directly in the Review pane.
3. On your phone: **WhatsApp → Menu (⋮) or Settings → Linked devices → Link a device**
   and scan the code.
4. The page switches to "WhatsApp Connected". The bridge sends a welcome message to
   your own chat (**Message yourself**).

Connection state lives in `status.json`, activity in `bridge.log`, both in the same
folder.

> Credentials are stored locally in `whatsapp/auth`. They are never uploaded.
> To unlink, remove the device in WhatsApp and delete that folder.

---

## Commands

Send these from WhatsApp:

| Command | What it does |
| --- | --- |
| `ls` | List sessions, numbered, with active marked ✅ |
| `<number>` | Switch to that session and stay there |
| `tag <number> <name>` | Tag a session for quick access |
| `@name <instruction>` | Send one instruction to a tagged session |
| `use <name>` / `use none` | Set or clear the active session |
| `new <name> <title>` | Create a session, tag it, make it active |
| `where` | Show the active session |
| `status` | Bridge state and pending prompts |
| `resend` | Re-send the current question |
| `screenshot` | Capture the desktop and send it as an image |
| `chat <text>` | Force a chat reply while a question is pending |
| `help` | Command list |

Plain text always goes to the active session; if none is selected it goes to a
dedicated **WhatsApp chat** session.

---

## How a question flows

1. A session calls the `question` tool (or a permission is required).
2. The plugin emits a WhatsApp message with the prompt and options.
3. That session becomes active.
4. You reply `1` (or type an answer).
5. The plugin submits the answer to that session's form or permission request.
6. The agent continues, and its next reply arrives on WhatsApp.

If OpenCode asks while you are already chatting in another session, nothing is lost:
the switch is automatic and the answer is routed back to the session that asked.

---

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_WHATSAPP_DIR` | `~/.local/share/opencode/whatsapp` | Data, auth, QR and logs |
| `OPENCODE_CLI` | auto-detected | Path to the OpenCode CLI used as API fallback |

Plugin options (optional):

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "./plugins/whatsapp", "options": { "targetNumber": "+15551234567" } }
  ]
}
```

`targetNumber` sends prompts to another number instead of your own chat.

---

## Troubleshooting

**No QR code appears** — check `bridge.log`. If it shows a connection error, delete
`whatsapp/auth` and let the plugin generate a fresh code.

**Repeated disconnects (status 440)** — two processes are using the same linked
device. Keep a single OpenCode server running; the bridge retires old instances on
reload.

**Messages sent but no reply** — the agent may still be working. Send `status`; if
nothing is pending, send the text again. `bridge.log` shows every sent and received
message.

**Session not found after answering** — the question was already answered in the
desktop UI. The bridge tells you when a reply has nowhere to go.

---

## Project layout

```
src/index.ts            the bridge (server plugin)
skills/whatsapp/        SKILL.md so agents know how to use it
scripts/install.*       one-command installers
```

## License

MIT
