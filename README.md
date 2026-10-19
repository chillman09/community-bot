# Community bot + dashboard

Node 20+, discord.js, Express, Postgres. One service runs both the bot and the dashboard.

## Discord setup
1. discord.com/developers/applications → New Application. Copy the **Application ID** (`CLIENT_ID`).
2. **Bot** tab: reset/copy the token (`DISCORD_TOKEN`) and turn on **Server Members Intent**.
3. **OAuth2** tab: copy the **Client Secret** (`CLIENT_SECRET`) and add the redirect `BASE_URL/auth/callback`.

## Deploy on Railway
1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo.
3. Add a **PostgreSQL** database to the project.
4. In the service Variables set: `DISCORD_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`, `SESSION_SECRET` (long random string), `BOT_NAME`, `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.
5. Settings → Networking → Generate Domain, then set `BASE_URL` to `https://your-domain` and add `https://your-domain/auth/callback` as a redirect in the Discord portal.

## Local
Copy `.env.example` to `.env`, fill it in, run `npm install && npm run dev`.

## Premium
`guild_settings.premium` exists per server and is returned by the API. Gate premium features on it.

## Moderation
Slash commands `/kick`, `/ban`, `/timeout`, `/warn`, `/warnings` register themselves on startup (new commands can take a few minutes to appear). Choose the log channel in the dashboard. Fine-tune who can use them in Discord under Server Settings → Integrations.
The bot's invite link now asks for Kick, Ban and Timeout permissions. If the bot is already in your server, re-invite it from the dashboard's "Add to another server" link, or tick those permissions on its role. The bot's role must also sit above the roles of members it moderates.

## Leveling, auto-roles, anti-spam
- **Leveling:** XP once a minute per member, `/rank` and `/leaderboard`, level-up messages and role rewards (set in the dashboard). Level n needs 100 x n squared XP.
- **Auto-roles:** roles given on join.
- **Anti-spam:** times out members who send too many messages too fast. Staff with Manage Messages are ignored.
These need the **Manage Roles** permission. Re-invite the bot from the dashboard, or tick it on the bot's role, and keep the bot's role above any role it hands out.

## Text commands (prefix), security, auto-roles
- **Text commands** like `?help` need the privileged **Message Content Intent**: enable it in the Developer Portal (Bot tab), then add the Railway variable `MESSAGE_CONTENT=true`. Each server picks its own prefix in the dashboard (Commands page). Without the variable, slash commands still work.
- **Slash commands:** the bot logs `Registered N slash commands` on startup. If it logs `Slash command registration failed`, read the message that follows.
- **Security:** anti-nuke, anti-raid, minimum account age, unauthorized-bot removal and a whitelist. Needs **View Audit Log**. Alerts go to the moderation log channel.
- **Auto-roles:** give a role to everyone, or to one member, from the dashboard. You can only hand out roles below your own highest role.
- The invite link was updated again (adds the `applications.commands` scope plus View Audit Log and Manage Messages). Re-invite the bot to refresh permissions.
