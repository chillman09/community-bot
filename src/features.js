import { EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const str = (v, n) => String(v ?? '').slice(0, n);
const num = (v, lo, hi, d) => Math.min(Math.max(Math.round(Number(v)) || d, lo), hi);
const list = (v, n = 10) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => str(x, 25));
const pick = (v, a, d) => (a.includes(v) ? v : d);

export const DEFAULTS = {
  general: { prefix: '?' },
  goodbye: { enabled: false, channelId: '', message: '{username} has left {server}. We now have {memberCount} members.' },
  logs: { enabled: false, channelId: '', joins: true, leaves: true, bans: true, channels: true, roles: true },
  escalation: { warnLimit: 0, warnAction: 'timeout', warnMinutes: 60 },
  leveling: { enabled: false, channelId: '', message: 'GG {user}, you reached level {level}!', mode: 'all', channelIds: [], cooldown: 60, xpMultiplier: 1, rewards: [] },
  autoroles: { enabled: false, roleIds: [] },
  antispam: { enabled: false, messages: 6, seconds: 5, timeoutMinutes: 5, mentionLimit: 0 },
  security: { enabled: false, nukeEnabled: false, nukeLimit: 3, nukeSeconds: 10, nukeAction: 'strip', raidEnabled: false, raidJoins: 6, raidSeconds: 10, raidAction: 'alert', minAgeDays: 0, blockBots: false, whitelist: [] },
};
const CLEAN = {
  general: (b) => ({ prefix: /^\S{1,3}$/.test(String(b.prefix ?? '').trim()) ? String(b.prefix).trim() : '?' }),
  leveling: (b) => ({
    enabled: !!b.enabled, channelId: str(b.channelId, 25), message: str(b.message, 500) || DEFAULTS.leveling.message,
    mode: pick(b.mode, ['all', 'only', 'except'], 'all'), channelIds: list(b.channelIds, 50),
    cooldown: num(b.cooldown, 10, 600, 60), xpMultiplier: Math.min(5, Math.max(0.5, Math.round((Number(b.xpMultiplier) || 1) * 2) / 2)),
    rewards: (Array.isArray(b.rewards) ? b.rewards : []).slice(0, 10).map((r) => ({ level: num(r.level, 1, 200, 1), roleId: str(r.roleId, 25) })).filter((r) => r.roleId),
  }),
  autoroles: (b) => ({ enabled: !!b.enabled, roleIds: list(b.roleIds) }),
  antispam: (b) => ({ enabled: !!b.enabled, messages: num(b.messages, 3, 20, 6), seconds: num(b.seconds, 2, 30, 5), timeoutMinutes: num(b.timeoutMinutes, 1, 60, 5), mentionLimit: num(b.mentionLimit, 0, 30, 0) }),
  goodbye: (b) => ({ enabled: !!b.enabled, channelId: str(b.channelId, 25), message: str(b.message, 500) || DEFAULTS.goodbye.message }),
  logs: (b) => ({ enabled: !!b.enabled, channelId: str(b.channelId, 25), joins: !!b.joins, leaves: !!b.leaves, bans: !!b.bans, channels: !!b.channels, roles: !!b.roles }),
  escalation: (b) => ({ warnLimit: num(b.warnLimit, 0, 20, 0), warnAction: pick(b.warnAction, ['timeout', 'kick', 'ban'], 'timeout'), warnMinutes: num(b.warnMinutes, 1, 40320, 60) }),
  security: (b) => ({
    enabled: !!b.nukeEnabled || !!b.raidEnabled, nukeEnabled: !!b.nukeEnabled, nukeLimit: num(b.nukeLimit, 2, 20, 3), nukeSeconds: num(b.nukeSeconds, 3, 60, 10),
    nukeAction: pick(b.nukeAction, ['strip', 'kick', 'ban'], 'strip'), raidEnabled: !!b.raidEnabled, raidJoins: num(b.raidJoins, 3, 50, 6), raidSeconds: num(b.raidSeconds, 3, 120, 10),
    raidAction: pick(b.raidAction, ['alert', 'kick', 'ban'], 'alert'), minAgeDays: num(b.minAgeDays, 0, 365, 0), blockBots: !!b.blockBots,
    whitelist: list(b.whitelist, 20).filter((x) => /^\d{15,20}$/.test(x)),
  }),
};

const lvl = (xp) => Math.floor(Math.sqrt(xp / 100));
const need = (l) => 100 * l * l;
const BLUE = '#2f4bd8';

export const featureCommands = [
  new SlashCommandBuilder().setName('rank').setDescription('Show your level and XP').addUserOption((o) => o.setName('user').setDescription('Member')).setContexts(0),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the top members').setContexts(0),
  new SlashCommandBuilder().setName('help').setDescription('List the bot commands').setContexts(0),
].map((c) => c.toJSON());

export const initFeatures = (db) => db.query(`
  create table if not exists module_settings (guild_id text not null, module text not null, config jsonb not null default '{}', primary key (guild_id, module));
  create table if not exists levels (guild_id text not null, user_id text not null, xp int not null default 0, primary key (guild_id, user_id));
  create index if not exists levels_rank on levels (guild_id, xp desc)`);

const cache = new Map();
export async function cfg(db, gid, name) {
  let e = cache.get(gid);
  if (!e || Date.now() - e.at > 6e4) {
    const { rows } = await db.query('select module, config from module_settings where guild_id=$1', [gid]);
    e = { at: Date.now(), m: Object.fromEntries(rows.map((r) => [r.module, r.config])) };
    cache.set(gid, e);
  }
  return { ...DEFAULTS[name], ...e.m[name] };
}

async function rankEmbed(db, gid, u) {
  const { rows: [r] } = await db.query('select xp from levels where guild_id=$1 and user_id=$2', [gid, u.id]);
  const xp = r?.xp || 0, l = lvl(xp);
  const { rows: [p] } = await db.query('select count(*)::int + 1 as pos from levels where guild_id=$1 and xp > $2', [gid, xp]);
  return new EmbedBuilder().setColor(BLUE).setAuthor({ name: u.username, iconURL: u.displayAvatarURL() })
    .addFields({ name: 'Level', value: String(l), inline: true }, { name: 'XP', value: `${xp} / ${need(l + 1)}`, inline: true }, { name: 'Rank', value: `#${p.pos}`, inline: true });
}
async function boardEmbed(db, guild) {
  const { rows } = await db.query('select user_id, xp from levels where guild_id=$1 order by xp desc limit 10', [guild.id]);
  return new EmbedBuilder().setColor(BLUE).setTitle(`${guild.name} leaderboard`)
    .setDescription(rows.map((r, n) => `**${n + 1}.** <@${r.user_id}> — level ${lvl(r.xp)} (${r.xp} XP)`).join('\n') || 'No XP earned yet.');
}
const helpEmbed = (p) => new EmbedBuilder().setColor(BLUE).setTitle('Commands').addFields(
  { name: `Text commands (prefix ${p})`, value: [`${p}help`, `${p}rank [@member]`, `${p}leaderboard`, `${p}ping`].join('\n') },
  { name: 'Slash commands', value: ['/rank', '/leaderboard', '/help', '/warn, /warnings, /timeout, /kick, /ban (staff)'].join('\n') });

export function setupFeatures(client, db) {
  const spam = new Map(), cool = new Map();
  setInterval(() => {
    const n = Date.now();
    for (const [k, v] of spam) if (n - v.at(-1) > 6e4) spam.delete(k);
    for (const [k, t] of cool) if (n - t > 6e5) cool.delete(k);
  }, 3e5).unref();

  client.on('guildMemberAdd', async (mem) => {
    try {
      const c = await cfg(db, mem.guild.id, 'autoroles');
      const roles = c.enabled ? c.roleIds.map((id) => mem.guild.roles.cache.get(id)).filter((r) => r?.editable) : [];
      if (roles.length) await mem.roles.add(roles, 'Auto-role');
    } catch (e) { console.error('autorole', e.message); }
  });

  client.on('guildMemberRemove', async (mem) => {
    try {
      const c = await cfg(db, mem.guild.id, 'goodbye');
      const ch = c.enabled && mem.guild.channels.cache.get(c.channelId);
      if (ch?.isTextBased()) await ch.send({ content: c.message.replaceAll('{username}', mem.user.username).replaceAll('{server}', mem.guild.name).replaceAll('{memberCount}', mem.guild.memberCount), allowedMentions: { parse: [] } });
    } catch (e) { console.error('goodbye', e.message); }
  });

  client.on('interactionCreate', async (i) => {
    if (!i.isButton() || !i.inGuild() || !i.customId.startsWith('rr:')) return;
    try {
      const role = i.guild.roles.cache.get(i.customId.slice(3));
      if (!role?.editable) return await i.reply({ content: "I can't manage that role anymore.", ephemeral: true });
      const has = i.member.roles.cache.has(role.id);
      await (has ? i.member.roles.remove(role, 'Role panel') : i.member.roles.add(role, 'Role panel'));
      await i.reply({ content: `${has ? 'Removed' : 'Added'} **${role.name}**.`, ephemeral: true });
    } catch (e) { console.error('role panel', e.message); if (!i.replied) i.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {}); }
  });

  client.on('messageCreate', async (m) => {
    if (!m.inGuild() || m.author.bot || !m.member) return;
    try {
      if (process.env.MESSAGE_CONTENT === 'true' && m.content) {
        const { prefix } = await cfg(db, m.guildId, 'general');
        if (m.content.startsWith(prefix)) {
          const [name, ...rest] = m.content.slice(prefix.length).trim().split(/\s+/);
          const cmd = name.toLowerCase(), quiet = { allowedMentions: { repliedUser: false, users: [] } };
          if (cmd === 'help') return void m.reply({ embeds: [helpEmbed(prefix)], ...quiet });
          if (cmd === 'ping') return void m.reply({ content: `Pong! ${Math.round(client.ws.ping)}ms`, ...quiet });
          if (cmd === 'rank') return void m.reply({ embeds: [await rankEmbed(db, m.guildId, m.mentions.users.first() || m.author)], ...quiet });
          if (cmd === 'leaderboard' || cmd === 'lb') return void m.reply({ embeds: [await boardEmbed(db, m.guild)], ...quiet });
        }
      }
      const [lv, sp] = await Promise.all([cfg(db, m.guildId, 'leveling'), cfg(db, m.guildId, 'antispam')]);
      const k = `${m.guildId}:${m.author.id}`, now = Date.now();

      if (sp.enabled && !m.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        if (sp.mentionLimit && m.mentions.users.size >= sp.mentionLimit) {
          m.delete().catch(() => {});
          if (m.member.moderatable) await m.member.timeout(sp.timeoutMinutes * 6e4, 'Mention spam');
          m.channel.send({ content: `<@${m.author.id}> was timed out for mass mentions.`, allowedMentions: { users: [] } }).catch(() => {});
          return;
        }
        const hits = (spam.get(k) || []).filter((t) => now - t < sp.seconds * 1e3);
        hits.push(now); spam.set(k, hits);
        if (hits.length >= sp.messages && m.member.moderatable) {
          spam.delete(k);
          await m.member.timeout(sp.timeoutMinutes * 6e4, 'Anti-spam');
          m.channel.send({ content: `<@${m.author.id}> was timed out for spamming.`, allowedMentions: { users: [] } }).catch(() => {});
          return;
        }
      }

      const cid = m.channel.isThread() ? m.channel.parentId : m.channelId;
      const inScope = lv.mode === 'all' || (lv.mode === 'only' ? lv.channelIds.includes(cid) : !lv.channelIds.includes(cid));
      if (lv.enabled && inScope && now - (cool.get(k) || 0) >= lv.cooldown * 1e3) {
        cool.set(k, now);
        const gain = Math.max(1, Math.round((15 + Math.floor(Math.random() * 11)) * lv.xpMultiplier));
        const { rows: [r] } = await db.query(`insert into levels (guild_id, user_id, xp) values ($1,$2,$3)
          on conflict (guild_id, user_id) do update set xp = levels.xp + $3 returning xp`, [m.guildId, m.author.id, gain]);
        const after = lvl(r.xp);
        if (after > lvl(r.xp - gain)) {
          const ch = (lv.channelId && m.guild.channels.cache.get(lv.channelId)) || m.channel;
          ch.send({ content: lv.message.replaceAll('{user}', `<@${m.author.id}>`).replaceAll('{level}', after), allowedMentions: { users: [m.author.id] } }).catch(() => {});
        }
        for (const w of lv.rewards) {
          const role = after >= w.level && m.guild.roles.cache.get(w.roleId);
          if (role?.editable && !m.member.roles.cache.has(role.id)) await m.member.roles.add(role, 'Level reward').catch(() => {});
        }
      }
    } catch (e) { console.error('message handler', e.message); }
  });

  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || !i.inGuild() || !featureCommands.some((c) => c.name === i.commandName)) return;
    try {
      if (i.commandName === 'help') return await i.reply({ embeds: [helpEmbed((await cfg(db, i.guildId, 'general')).prefix)], ephemeral: true });
      if (i.commandName === 'rank') return await i.reply({ embeds: [await rankEmbed(db, i.guildId, i.options.getUser('user') || i.user)] });
      await i.reply({ embeds: [await boardEmbed(db, i.guild)], allowedMentions: { users: [] } });
    } catch (e) { console.error('feature command', e.message); if (!i.replied) i.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {}); }
  });
}

export function mountFeatures(app, guard, db) {
  const busy = new Set();
  const canGive = (g, member, role) => role && !role.managed && role.id !== g.id && (g.ownerId === member.id || role.position < member.roles.highest.position);

  app.get('/api/guilds/:id/modules', guard, async (req, res) => {
    const g = req.guild, modules = {};
    for (const n in DEFAULTS) modules[n] = await cfg(db, g.id, n);
    const roles = [...g.roles.cache.values()].filter((r) => r.id !== g.id && !r.managed).sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, ok: r.editable && canGive(g, req.member, r) }));
    const { rows } = await db.query('select user_id, xp from levels where guild_id=$1 order by xp desc limit 10', [g.id]);
    await g.members.fetch({ user: rows.map((r) => r.user_id) }).catch(() => {});
    res.json({ modules, roles, contentIntent: process.env.MESSAGE_CONTENT === 'true',
      leaders: rows.map((r) => ({ name: g.members.cache.get(r.user_id)?.user.username || 'Former member', xp: r.xp, level: lvl(r.xp) })) });
  });

  app.put('/api/guilds/:id/modules/:name', guard, async (req, res) => {
    const n = req.params.name, g = req.guild;
    if (!CLEAN[n]) return res.status(404).json({ error: 'Unknown module.' });
    const c = CLEAN[n](req.body || {});
    const ok = (id) => canGive(g, req.member, g.roles.cache.get(id));
    if (c.roleIds) c.roleIds = c.roleIds.filter(ok);
    if (c.rewards) c.rewards = c.rewards.filter((r) => ok(r.roleId));
    if (c.channelIds) c.channelIds = c.channelIds.filter((id) => g.channels.cache.has(id));
    if (c.channelId && !g.channels.cache.get(c.channelId)?.isTextBased()) c.channelId = '';
    await db.query(`insert into module_settings (guild_id, module, config) values ($1,$2,$3)
      on conflict (guild_id, module) do update set config=$3`, [g.id, n, c]);
    cache.delete(g.id);
    res.json({ ok: true });
  });

  app.post('/api/guilds/:id/rolepanel', guard, async (req, res) => {
    const g = req.guild, ch = g.channels.cache.get(String(req.body?.channelId));
    if (!ch?.isTextBased()) return res.status(400).json({ error: 'Pick a channel to post the panel in.' });
    const roles = list(req.body.roleIds).map((id) => g.roles.cache.get(id))
      .filter((r) => r?.editable && canGive(g, req.member, r) && !r.permissions.has(PermissionFlagsBits.Administrator));
    if (!roles.length) return res.status(400).json({ error: 'Pick at least one role the bot can assign.' });
    const rows = [];
    for (let i = 0; i < roles.length; i += 5) rows.push(new ActionRowBuilder().addComponents(roles.slice(i, i + 5).map((r) => new ButtonBuilder().setCustomId('rr:' + r.id).setLabel(r.name.slice(0, 80)).setStyle(ButtonStyle.Secondary))));
    const embed = new EmbedBuilder().setColor(BLUE).setTitle(str(req.body.title, 256) || 'Pick your roles').setDescription(str(req.body.description, 2000) || null);
    try { await ch.send({ embeds: [embed], components: rows }); res.json({ ok: true }); }
    catch { res.status(400).json({ error: `I can't post in #${ch.name}. Check my permissions there.` }); }
  });

  app.post('/api/guilds/:id/autoroles/give', guard, async (req, res) => {
    const g = req.guild, role = g.roles.cache.get(String(req.body?.roleId));
    if (!role?.editable) return res.status(400).json({ error: "I can't assign that role. Move my role above it first." });
    if (!canGive(g, req.member, role)) return res.status(403).json({ error: 'You can only give roles below your own highest role.' });
    if (req.body.target === 'all') {
      if (busy.has(g.id)) return res.status(429).json({ error: 'A bulk role update is already running for this server.' });
      busy.add(g.id);
      let todo;
      try { todo = [...(await g.members.fetch()).values()].filter((m) => !m.roles.cache.has(role.id) && !(req.body.skipBots && m.user.bot)); }
      catch { busy.delete(g.id); return res.status(500).json({ error: 'Could not load the member list.' }); }
      res.json({ ok: true, count: todo.length });
      (async () => { for (const m of todo) await m.roles.add(role, 'Bulk role from dashboard').catch(() => {}); busy.delete(g.id); })();
      return;
    }
    const q = String(req.body?.user ?? '').trim().replace(/^@/, '');
    if (!q) return res.status(400).json({ error: 'Enter a username or user ID.' });
    const m = /^\d{15,20}$/.test(q) ? await g.members.fetch(q).catch(() => null)
      : (await g.members.search({ query: q, limit: 5 }).catch(() => null))?.find((x) => x.user.username.toLowerCase() === q.toLowerCase()) ?? null;
    if (!m) return res.status(404).json({ error: 'No member found. Try their exact username or user ID.' });
    await m.roles.add(role, 'Role from dashboard');
    res.json({ ok: true, name: m.user.username });
  });
}
