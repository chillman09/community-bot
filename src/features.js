import { EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const DEFAULTS = {
  leveling: { enabled: false, channelId: '', message: 'GG {user}, you reached level {level}!', rewards: [] },
  autoroles: { enabled: false, roleIds: [] },
  antispam: { enabled: false, messages: 6, seconds: 5, timeoutMinutes: 5 },
};
const str = (v, n) => String(v ?? '').slice(0, n);
const num = (v, lo, hi, d) => Math.min(Math.max(Math.round(Number(v)) || d, lo), hi);
const list = (v) => (Array.isArray(v) ? v : []).slice(0, 10);
const CLEAN = {
  leveling: (b) => ({
    enabled: !!b.enabled, channelId: str(b.channelId, 25), message: str(b.message, 500) || DEFAULTS.leveling.message,
    rewards: list(b.rewards).map((r) => ({ level: num(r.level, 1, 200, 1), roleId: str(r.roleId, 25) })).filter((r) => r.roleId),
  }),
  autoroles: (b) => ({ enabled: !!b.enabled, roleIds: list(b.roleIds).map((x) => str(x, 25)) }),
  antispam: (b) => ({ enabled: !!b.enabled, messages: num(b.messages, 3, 20, 6), seconds: num(b.seconds, 2, 30, 5), timeoutMinutes: num(b.timeoutMinutes, 1, 60, 5) }),
};

const lvl = (xp) => Math.floor(Math.sqrt(xp / 100));
const need = (l) => 100 * l * l;

export const featureCommands = [
  new SlashCommandBuilder().setName('rank').setDescription('Show your level and XP').addUserOption((o) => o.setName('user').setDescription('Member')).setContexts(0),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the top members').setContexts(0),
].map((c) => c.toJSON());

export const initFeatures = (db) => db.query(`
  create table if not exists module_settings (guild_id text not null, module text not null, config jsonb not null default '{}', primary key (guild_id, module));
  create table if not exists levels (guild_id text not null, user_id text not null, xp int not null default 0, primary key (guild_id, user_id));
  create index if not exists levels_rank on levels (guild_id, xp desc)`);

const cache = new Map();
async function cfg(db, gid, name) {
  let e = cache.get(gid);
  if (!e || Date.now() - e.at > 6e4) {
    const { rows } = await db.query('select module, config from module_settings where guild_id=$1', [gid]);
    e = { at: Date.now(), m: Object.fromEntries(rows.map((r) => [r.module, r.config])) };
    cache.set(gid, e);
  }
  return { ...DEFAULTS[name], ...e.m[name] };
}

export function setupFeatures(client, db) {
  const spam = new Map(), cool = new Map();
  setInterval(() => {
    const n = Date.now();
    for (const [k, v] of spam) if (n - v.at(-1) > 6e4) spam.delete(k);
    for (const [k, t] of cool) if (n - t > 6e4) cool.delete(k);
  }, 3e5).unref();

  client.on('guildMemberAdd', async (mem) => {
    try {
      const c = await cfg(db, mem.guild.id, 'autoroles');
      const roles = c.enabled ? c.roleIds.map((id) => mem.guild.roles.cache.get(id)).filter((r) => r?.editable) : [];
      if (roles.length) await mem.roles.add(roles, 'Auto-role');
    } catch (e) { console.error('autorole', e.message); }
  });

  client.on('messageCreate', async (m) => {
    if (!m.inGuild() || m.author.bot || !m.member) return;
    try {
      const [lv, sp] = await Promise.all([cfg(db, m.guildId, 'leveling'), cfg(db, m.guildId, 'antispam')]);
      const k = `${m.guildId}:${m.author.id}`, now = Date.now();

      if (sp.enabled && !m.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        const hits = (spam.get(k) || []).filter((t) => now - t < sp.seconds * 1e3);
        hits.push(now); spam.set(k, hits);
        if (hits.length >= sp.messages && m.member.moderatable) {
          spam.delete(k);
          await m.member.timeout(sp.timeoutMinutes * 6e4, 'Anti-spam');
          m.channel.send({ content: `<@${m.author.id}> was timed out for spamming.`, allowedMentions: { users: [] } }).catch(() => {});
          return;
        }
      }

      if (lv.enabled && now - (cool.get(k) || 0) >= 6e4) {
        cool.set(k, now);
        const gain = 15 + Math.floor(Math.random() * 11);
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
      if (i.commandName === 'rank') {
        const u = i.options.getUser('user') || i.user;
        const { rows: [r] } = await db.query('select xp from levels where guild_id=$1 and user_id=$2', [i.guildId, u.id]);
        const xp = r?.xp || 0, l = lvl(xp);
        const { rows: [p] } = await db.query('select count(*)::int + 1 as pos from levels where guild_id=$1 and xp > $2', [i.guildId, xp]);
        return i.reply({ embeds: [new EmbedBuilder().setColor('#2f4bd8').setAuthor({ name: u.username, iconURL: u.displayAvatarURL() })
          .addFields({ name: 'Level', value: String(l), inline: true }, { name: 'XP', value: `${xp} / ${need(l + 1)}`, inline: true }, { name: 'Rank', value: `#${p.pos}`, inline: true })] });
      }
      const { rows } = await db.query('select user_id, xp from levels where guild_id=$1 order by xp desc limit 10', [i.guildId]);
      await i.reply({ embeds: [new EmbedBuilder().setColor('#2f4bd8').setTitle(`${i.guild.name} leaderboard`)
        .setDescription(rows.map((r, n) => `**${n + 1}.** <@${r.user_id}> — level ${lvl(r.xp)} (${r.xp} XP)`).join('\n') || 'No XP earned yet.')], allowedMentions: { users: [] } });
    } catch (e) { console.error('feature command', e.message); if (!i.replied) i.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {}); }
  });
}

export function mountFeatures(app, guard, db) {
  app.get('/api/guilds/:id/modules', guard, async (req, res) => {
    const g = req.guild, modules = {};
    for (const n in DEFAULTS) modules[n] = await cfg(db, g.id, n);
    const roles = [...g.roles.cache.values()].filter((r) => r.id !== g.id && !r.managed).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, ok: r.editable }));
    const { rows } = await db.query('select user_id, xp from levels where guild_id=$1 order by xp desc limit 10', [g.id]);
    await g.members.fetch({ user: rows.map((r) => r.user_id) }).catch(() => {});
    res.json({ modules, roles, leaders: rows.map((r) => ({ name: g.members.cache.get(r.user_id)?.user.username || 'Former member', xp: r.xp, level: lvl(r.xp) })) });
  });

  app.put('/api/guilds/:id/modules/:name', guard, async (req, res) => {
    const n = req.params.name, g = req.guild;
    if (!CLEAN[n]) return res.status(404).json({ error: 'Unknown module.' });
    const c = CLEAN[n](req.body || {});
    if (c.roleIds) c.roleIds = c.roleIds.filter((id) => g.roles.cache.has(id));
    if (c.rewards) c.rewards = c.rewards.filter((r) => g.roles.cache.has(r.roleId));
    if (c.channelId && !g.channels.cache.get(c.channelId)?.isTextBased()) c.channelId = '';
    await db.query(`insert into module_settings (guild_id, module, config) values ($1,$2,$3)
      on conflict (guild_id, module) do update set config=$3`, [g.id, n, c]);
    cache.delete(g.id);
    res.json({ ok: true });
  });
}
