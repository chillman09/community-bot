import express from 'express';
import cookieSession from 'cookie-session';
import pg from 'pg';
import crypto from 'node:crypto';
import { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, CLIENT_SECRET, BASE_URL, SESSION_SECRET, DATABASE_URL, PORT = 3000, BOT_NAME = 'Beacon' } = process.env;

const local = /localhost|railway\.internal/.test(DATABASE_URL || '');
const db = new pg.Pool({ connectionString: DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

/* ---------- welcome settings ---------- */
const DEFAULT = {
  enabled: false, channelId: '', content: 'Welcome {user}!',
  embed: { color: '#2f4bd8', author: true, title: 'Welcome to {server}', description: 'Read the rules, grab your roles, then say hi.', thumbnail: 'user', footer: 'We now have {memberCount} members', footerIcon: true, timestamp: false },
};
const str = (v, n) => String(v ?? '').slice(0, n);
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : DEFAULT.embed.color);

function clean(b = {}) {
  const e = b.embed ?? {};
  return {
    enabled: !!b.enabled, channelId: str(b.channelId, 25), content: str(b.content, 2000),
    embed: {
      color: hex(e.color), author: !!e.author, title: str(e.title, 256), description: str(e.description, 4000),
      thumbnail: ['user', 'server'].includes(e.thumbnail) ? e.thumbnail : 'none',
      footer: str(e.footer, 2000), footerIcon: !!e.footerIcon, timestamp: !!e.timestamp,
    },
  };
}

async function load(gid) {
  const { rows } = await db.query('select premium, welcome from guild_settings where guild_id=$1', [gid]);
  const r = rows[0];
  return { premium: !!r?.premium, welcome: { ...DEFAULT, ...r?.welcome, embed: { ...DEFAULT.embed, ...r?.welcome?.embed } } };
}

const fill = (s, m) => String(s ?? '')
  .replaceAll('{user}', `<@${m.id}>`).replaceAll('{username}', m.user.username)
  .replaceAll('{server}', m.guild.name).replaceAll('{memberCount}', m.guild.memberCount);

function buildMessage(w, m) {
  const e = w.embed, embed = new EmbedBuilder().setColor(hex(e.color));
  if (e.author) embed.setAuthor({ name: m.user.username, iconURL: m.user.displayAvatarURL() });
  if (e.title) embed.setTitle(fill(e.title, m));
  if (e.description) embed.setDescription(fill(e.description, m));
  if (e.thumbnail === 'user') embed.setThumbnail(m.user.displayAvatarURL({ size: 256 }));
  if (e.thumbnail === 'server' && m.guild.iconURL()) embed.setThumbnail(m.guild.iconURL({ size: 256 }));
  if (e.footer) embed.setFooter({ text: fill(e.footer, m), iconURL: (e.footerIcon && m.guild.iconURL()) || undefined });
  if (e.timestamp) embed.setTimestamp();
  const hasEmbed = e.title || e.description || e.footer;
  return { content: fill(w.content, m) || undefined, embeds: hasEmbed ? [embed] : [], allowedMentions: { users: [m.id] } };
}

client.on('guildMemberAdd', async (member) => {
  try {
    const { welcome } = await load(member.guild.id);
    const ch = welcome.enabled && member.guild.channels.cache.get(welcome.channelId);
    if (ch?.isTextBased()) await ch.send(buildMessage(welcome, member));
  } catch (err) { console.error('welcome failed', member.guild.id, err.message); }
});
client.once('ready', () => console.log(`Bot online as ${client.user.tag}`));

/* ---------- dashboard server ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(cookieSession({ name: 'sid', keys: [SESSION_SECRET], maxAge: 7 * 864e5, sameSite: 'lax', httpOnly: true }));
app.use(express.static('public'));
app.get('/health', (_, res) => res.send('ok'));

const redirect = `${BASE_URL}/auth/callback`;
app.get('/auth/login', (req, res) => {
  req.session.state = crypto.randomUUID();
  res.redirect('https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', scope: 'identify', redirect_uri: redirect, state: req.session.state }));
});
app.get('/auth/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.state) throw new Error('state');
    const tok = await (await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirect }),
    })).json();
    const u = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
    req.session = { uid: u.id, name: u.global_name || u.username, avatar: u.avatar };
    res.redirect('/');
  } catch { req.session = null; res.redirect('/?error=login'); }
});
app.get('/auth/logout', (req, res) => { req.session = null; res.redirect('/'); });

const canManage = (m) => m?.permissions.has(PermissionFlagsBits.ManageGuild);

app.get('/api/me', async (req, res) => {
  const base = { botName: BOT_NAME, invite: `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot&permissions=19456` };
  if (!req.session?.uid) return res.json({ ...base, user: null });
  const guilds = [];
  for (const g of client.guilds.cache.values()) {
    const m = await g.members.fetch(req.session.uid).catch(() => null);
    if (canManage(m)) guilds.push({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) });
  }
  const { uid, name, avatar } = req.session;
  res.json({ ...base, guilds, user: { name, avatar: avatar ? `https://cdn.discordapp.com/avatars/${uid}/${avatar}.png?size=64` : null } });
});

async function guard(req, res, next) {
  const guild = client.guilds.cache.get(req.params.id);
  const member = guild && req.session?.uid && await guild.members.fetch(req.session.uid).catch(() => null);
  if (!canManage(member)) return res.status(403).json({ error: 'You need the Manage Server permission in this server.' });
  Object.assign(req, { guild, member });
  next();
}

app.get('/api/guilds/:id', guard, async (req, res) => {
  const { guild, member } = req;
  const channels = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).sort((a, b) => a.rawPosition - b.rawPosition).values()].map((c) => ({ id: c.id, name: c.name }));
  res.json({
    ...(await load(guild.id)), channels,
    sample: { username: member.user.username, avatar: member.user.displayAvatarURL({ size: 64 }), server: guild.name, icon: guild.iconURL({ size: 64 }), memberCount: guild.memberCount },
  });
});

app.put('/api/guilds/:id/welcome', guard, async (req, res) => {
  const w = clean(req.body);
  if (w.enabled && !req.guild.channels.cache.get(w.channelId)?.isTextBased()) return res.status(400).json({ error: 'Pick a channel before turning welcome messages on.' });
  await db.query(`insert into guild_settings (guild_id, welcome) values ($1,$2)
    on conflict (guild_id) do update set welcome=$2, updated_at=now()`, [req.guild.id, w]);
  res.json({ ok: true });
});

app.post('/api/guilds/:id/welcome/test', guard, async (req, res) => {
  const w = clean(req.body), ch = req.guild.channels.cache.get(w.channelId);
  if (!ch?.isTextBased()) return res.status(400).json({ error: 'Pick a channel to send the test to.' });
  try { await ch.send(buildMessage(w, req.member)); res.json({ ok: true }); }
  catch { res.status(400).json({ error: `${BOT_NAME} can't send messages in #${ch.name}. Check its permissions there.` }); }
});

await db.query(`create table if not exists guild_settings (
  guild_id text primary key, premium boolean not null default false,
  welcome jsonb not null default '{}', updated_at timestamptz not null default now())`);
await client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`Dashboard on :${PORT}`));
