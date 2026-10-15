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
