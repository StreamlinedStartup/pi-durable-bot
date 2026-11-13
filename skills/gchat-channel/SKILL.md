---
name: gchat-channel
description: Google Chat for a Pots bot, including webhook and Workspace Events setup. Use when connecting or using Google Chat.
---

# Google Chat

Follow the [Google Chat setup guide](../../docs/google-chat.md) for configuration, authentication and the limitations. The webhook must have a stable public HTTPS URL routed to the channel's loopback port; it is separate from Pots pages. Help the person configure Google Cloud and Workspace. Prefer keyless service-account impersonation. If using a key, ask for it through a Pots secret page or terminal `ask-secret`; keep the JSON on one line in `GOOGLE_CHAT_CREDENTIALS`, never in chat, logs or bot.json. Domain-wide delegation requires a Workspace administrator.

Addresses look like `gchat:#SPACE`, `gchat:#SPACE/t/THREAD`, `gchat:#SPACE/m/MESSAGE` and `gchat:@USER`. Send accepts a place, thread, message or person. Initiating DMs and reading history may need domain-wide delegation. Sending reactions is not supported. `call` takes a Google Chat client method such as `spaces.messages.get` and its Google API parameters. Messages created through `call` do not use Pots' send ID or enter its log automatically; use `send` for ordinary messages.
