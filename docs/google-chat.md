# Google Chat

Pots uses the [Chat SDK Google Chat adapter](https://chat-sdk.dev/adapters/official/gchat) to verify webhooks, format outgoing messages, and access Google Chat. Each Google Chat channel listens on its own local port. A reverse proxy must expose that port at a stable public HTTPS URL and forward the `Authorization` header and request body without changes. Pots does not set up this proxy or reuse its pages tunnel.

1. Create a Google Cloud project, enable the Google Chat API, create a Chat app and a service account, and grant the Chat app access to the spaces it needs. Configure the app's connection as an HTTP endpoint with the public URL. Follow the [adapter setup instructions](https://chat-sdk.dev/adapters/official/gchat#platform-setup). Configure the app's authentication audience as the HTTP endpoint URL (or supply `projectNumber` below when using project-number audience).
2. Authenticate the app. Prefer short-lived credentials: grant the identity running Pots `roles/iam.serviceAccountTokenCreator` on the app's service account and enable the IAM Service Account Credentials API. Set `serviceAccount` to that account's email in the channel entry. Pots uses Application Default Credentials, or the explicitly named `gcloudAccount` via the gcloud CLI, to impersonate the service account. Alternatively, store a JSON service-account key **on one line** in `~/.pots/secrets/gchat.env` as `GOOGLE_CHAT_CREDENTIALS=...`, readable only by the current user, and set `secrets` instead. Use `pots chat`'s `ask-secret` or a Pots secret page to supply a key; do not put it in `bot.json` or a chat message.
3. Add an entry to the bot's `channels` in `bot.json`:

   ```json
   {
     "id": "gchat",
     "type": "gchat",
     "secrets": "~/.pots/secrets/gchat.env",
     "endpointUrl": "https://chat.example.com/webhooks/gchat",
     "port": 8088,
     "botUserId": "users/123456789"
   }
   ```

   `botUserId` is the Chat app's canonical user resource name. It is required to recognize mentions and distinguish the bot's messages from other bots. The listener binds to `127.0.0.1` by default; configure the proxy to forward `/webhooks/gchat` to `http://127.0.0.1:8088/webhooks/gchat`. In a container, set `"host": "0.0.0.0"` and restrict access to the container network and proxy. Give each channel its own port. Set `projectNumber` to the Google Cloud project number if the Chat app uses that JWT audience.

   For keyless authentication, replace `secrets` with `"serviceAccount": "bot@project.iam.gserviceaccount.com"` and, when using a specific gcloud login, add `"gcloudAccount": "you@example.com"`. If a secret manager injects the JSON key into an environment variable, replace `secrets` with `"credentialsEnv": "GOOGLE_CHAT_CREDENTIALS"`. Processes running as the bot can read its environment. For a Workspace add-on, also set `workspaceAddOnServiceAccountEmail` to the exact Google-managed add-on identity for this project.
4. Invite the app to the desired spaces. Direct Google Chat webhooks deliver messages directed to the app; they do not deliver every message in a space. To receive ordinary messages and reaction events, configure [Workspace Events and authenticated Pub/Sub push](https://chat-sdk.dev/adapters/official/gchat#pubsub-for-receiving-all-messages), create and renew a subscription for each space with resource data included, and send pushes to the same URL. Subscribe to the message and reaction event types you need. Set `pubsubAudience` to the push audience and `pubsubServiceAccountEmail` to the exact service account used by the push subscription. Both are required for push verification. Subscriptions are managed outside Pots and expire unless renewed.
5. For direct messages initiated by the bot and history backfill, configure domain-wide delegation and set `impersonateUser` to the delegated Workspace user email. The user must have access to the relevant spaces and the required scopes. The SDK's delegated-user support requires the JSON key authentication path; it is not available with `serviceAccount` impersonation. Backfill covers known spaces since the gateway last ran; it does not recover edits or deletions. Without delegation, messages missed while offline are not backfilled, though Pub/Sub may retry undelivered pushes.

Each outgoing `send` uses a stable Google request ID and custom message ID so Pots can recover it after a crash. `call` exposes Google Chat client methods such as `spaces.messages.get`; calls that create messages bypass Pots' send recovery and logging. This channel does not send reactions, automatically download attachments, or implement card interactions. Message text is limited to 30,000 UTF-8 bytes to leave room within Google's 32,000-byte message limit.
