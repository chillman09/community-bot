import { EmbedBuilder, AuditLogEvent as A, PermissionFlagsBits as P } from 'discord.js';
import { cfg } from './features.js';

const DANGER = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers];

export function setupSecurity(client, db) {
  const hits = new Map(), joins = new Map();
  const bump = (map, key, secs) => { const n = Date.now(), a = (map.get(key) || []).filter((t) => n - t < secs * 1e3); a.push(n); map.set(key, a); return a.length; };
  setInterval(() => { const n = Date.now(); for (const m of [hits, joins]) for (const [k, v] of m) if (n - v.at(-1) > 12e4) m.delete(k); }, 3e5).unref();

  async function log(g, title, text) {
    try {
      const { rows: [s] } = await db.query('select log_channel from mod_settings where guild_id=$1', [g.id]);
      const ch = s?.log_channel && g.channels.cache.get(s.log_channel);
      if (ch?.isTextBased()) await ch.send({ embeds: [new EmbedBuilder().setColor('#b42318').setTitle(title).setDescription(text).setTimestamp()] });
    } catch { /* log channel unavailable */ }
  }
  async function punish(g, m, action, why) {
    if (action === 'ban' && m.bannable) return m.ban({ reason: why });
    if (action === 'kick' && m.kickable) return m.kick(why);
    if (m.manageable) return m.roles.remove(m.roles.cache.filter((r) => r.id !== g.id && !r.managed && DANGER.some((p) => r.permissions.has(p))), why);
  }

  async function watch(g, type, label, targetId) {
    try {
      const c = await cfg(db, g.id, 'security');
      if (!c.nukeEnabled) return;
      const e = (await g.fetchAuditLogs({ type, limit: 1 })).entries.first();
      if (!e?.executor || e.targetId !== targetId || Date.now() - e.createdTimestamp > 5000) return;
      const id = e.executor.id;
      if (id === client.user.id || id === g.ownerId || c.whitelist.includes(id)) return;
      if (bump(hits, `${g.id}:${id}`, c.nukeSeconds) < c.nukeLimit) return;
      hits.delete(`${g.id}:${id}`);
      const m = await g.members.fetch(id).catch(() => null);
      if (m) await punish(g, m, c.nukeAction, 'Anti-nuke triggered');
      await log(g, 'Anti-nuke triggered', `<@${id}> reached the limit for **${label}**. Action: ${c.nukeAction}.`);
    } catch (e) { console.error('anti-nuke', e.message); }
  }
  client.on('channelDelete', (ch) => ch.guild && watch(ch.guild, A.ChannelDelete, 'channel deletions', ch.id));
  client.on('roleDelete', (r) => watch(r.guild, A.RoleDelete, 'role deletions', r.id));
  client.on('guildBanAdd', (b) => watch(b.guild, A.MemberBanAdd, 'bans', b.user.id));
  client.on('guildMemberRemove', (m) => watch(m.guild, A.MemberKick, 'kicks', m.id));

  client.on('guildMemberAdd', async (m) => {
    try {
      const g = m.guild, c = await cfg(db, g.id, 'security');
      if (m.user.bot) {
        if (!c.blockBots) return;
        const by = (await g.fetchAuditLogs({ type: A.BotAdd, limit: 1 })).entries.first()?.executor?.id;
        if (by && (by === g.ownerId || c.whitelist.includes(by))) return;
        if (m.kickable) { await m.kick('Unauthorized bot'); await log(g, 'Bot removed', `**${m.user.username}** was removed. Added by ${by ? `<@${by}>` : 'someone unknown'}.`); }
        return;
      }
      if (c.minAgeDays && Date.now() - m.user.createdTimestamp < c.minAgeDays * 864e5 && m.kickable) {
        await m.kick('Account too new');
        return void log(g, 'New account removed', `**${m.user.username}** was kicked: account younger than ${c.minAgeDays} days.`);
      }
      if (c.raidEnabled) {
        const n = bump(joins, g.id, c.raidSeconds);
        if (n < c.raidJoins) return;
        if (n === c.raidJoins) await log(g, 'Possible raid', `${n} members joined within ${c.raidSeconds} seconds. Action: ${c.raidAction}.`);
        if (c.raidAction !== 'alert') await punish(g, m, c.raidAction, 'Anti-raid');
      }
    } catch (e) { console.error('anti-raid', e.message); }
  });
}
