---
name: whatsapp
description: Use the WhatsApp bridge to reach the user on WhatsApp, ask them questions there, and route work into specific OpenCode sessions. Activate when the user mentions WhatsApp, when they may be away from the computer, or when a decision is needed asynchronously.
---

# WhatsApp bridge

This project may have the `opencode-whatsapp` plugin installed. It links the
user's WhatsApp (linked device) to OpenCode, so the user can read questions and
reply from their phone.

## When to use it

- The user says they are away, on mobile, or asks to be pinged on WhatsApp.
- A decision is needed and the user is not responding in the app.
- The user wants work directed at a specific session while chatting from their phone.

## What the bridge does by itself

- Every `question` tool call and every permission prompt is forwarded to the
  user's WhatsApp automatically.
- When a question arrives from any session, the bridge makes that session the
  active one, so the user's next WhatsApp reply is applied to the right session.
- Plain WhatsApp messages run a normal agent turn in the active session and send
  the answer back to WhatsApp.

## Commands the user can send on WhatsApp

| Command | Effect |
| --- | --- |
| `ls` | Numbered list of sessions |
| `<number>` | Work in that session (stays selected) |
| `tag <number> <name>` | Tag a session |
| `@name <instruction>` | One instruction to a tagged session |
| `use <name>` / `use none` | Set or clear the active session |
| `new <name> <title>` | Create a session, tag it, make it active |
| `where` | Show the active session |
| `status` / `resend` | Bridge state / re-send the open prompt |
| `chat <text>` | Force chat while a question is pending |

## Guidance for the agent

- Prefer the `question` tool for decisions: it reaches WhatsApp automatically, so
  do not also print the question and wait.
- Keep options short and self-contained; the user answers with a number.
- For permission prompts, explain the action in the tool call so the WhatsApp
  text is understandable without the desktop UI.
- When the user asks from WhatsApp to change sessions, they mean the bridge
  routing — not that you should create local files or switch editors.
