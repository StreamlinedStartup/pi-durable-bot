# Coolify deployment

The Compose application runs the bot on an internal network. A webhook relay reaches it from Coolify's proxy, an Infisical relay connects the refresh broker to Infisical, and an outbound proxy permits HTTP and HTTPS while blocking private addresses and the VPS address. The named `pots-data` volume holds the bot's state.

Use Coolify's raw Compose deployment mode: its normal parser adds every declared network to every service, which breaks the bot's isolation. The webhook relay's explicit Traefik labels route through the application network; only the relay and egress proxy connect that network to the bot's internal network.

Set `POTS_DOMAIN`, `GOOGLE_CHAT_ENDPOINT_URL`, `GOOGLE_CHAT_BOT_USER_ID`, `CODEX_PROJECT_ID`, `INFISICAL_NETWORK`, and `VPS_PUBLIC_IP` to the values for this deployment. Coolify supplies `COOLIFY_RESOURCE_UUID`. Link the Pots Infisical project as the application's secret manager and reference only `GOOGLE_CHAT_CREDENTIALS`, `CODEX_BROKER_CLIENT_ID`, and `CODEX_BROKER_CLIENT_SECRET`. The broker identity must have read and update access only to the separate Codex refresh project. Keep the identity Coolify uses to read the Pots project read-only.

Coolify writes resolved variables to its runtime `.env` file and may pass that file to every Compose service. The explicit empty values in `x-block-secrets` prevent these credentials, `CODEX_OAUTH`, and the earlier Infisical login variables from being inherited by services that do not need them. Add every new sensitive variable to that block and override it only in the service that needs it; verify container environments without printing values after changing the stack. Protect the host's Coolify data directory accordingly.

The broker serializes OAuth refreshes and saves the rotated credential to Infisical before returning a short-lived access token to the bot. If Infisical is unavailable after a rotation, it retries saving the new credential while the broker remains alive. A crash before that save can require a fresh sign-in.

The initial bot definition is created only when missing; subsequent changes and the message database persist in the named volume. The Google Chat app endpoint must match `GOOGLE_CHAT_ENDPOINT_URL`, and its webhook continues to verify signatures. Ordinary space messages require the separately configured Workspace Events/Pub/Sub subscription.
