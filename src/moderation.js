import { featureCommands, cfg } from './features.js';
import { EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits as P } from 'discord.js';

const user = (c) => c.addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true));
const reason = (c) => c.addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(300));
const base = (n, d, p) => new SlashCommandBuilder().setName(n).setDescription(d).setDefaultMemberPermissions(p).setContexts(0);
const commands = [
  reason(user(base('kick', 'Kick a member', P.KickMembers))),
  reason(user(base('ban', 'Ban a member', P.BanMembers))),
  reason(user(base('timeout', 'Time out a member', P.ModerateMembers)).addIntegerOption((o) => o.setName('minutes').setDescription('Duration in minutes').setMinValue(1).setMaxValue(40320).setRequired(true))),
  reason(user(base('warn', 'Warn a member', P.ModerateMembers))),
  user(base('warnings', 'Show a member\'s warnings', P.ModerateMembers)),
].map((c) => c.toJSON());

const past = { kick: 'kicked from', ban: 'banned from', timeout: 'timed out in', warn: 'warned in' };

export const initModeration = (db) => db.query(`
  create table if not exists mod_settings (guild_id text primary key, log_channel text, dm boolean not null default false);
  create table if not exists warnings (id serial primary key, guild_id text not null, user_id text not null, mod_id text not null, reason text not null, created_at timestamptz not null default now());
  create index if not exists warnings_guild on warnings (guild_id, user_id)`);

export function setupModeration(client, db) {
  client.once('ready', async () => {
    try { const all = [...commands, ...featureCommands]; await client.application.commands.set(all); console.log(`Registered ${all.length} slash commands`); }
    catch (e) { console.error('Slash command registration failed:', e.message, e.rawError ? JSON.stringify(e.rawError).slice(0, 600) : ''); }
  });

  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || !i.inGuild() || !commands.some((c) => c.name === i.commandName)) return;
    const fail = (m) => i.reply({ content: m, ephemeral: true });
    try {
      const target = i.options.getMember('user'), why = i.options.getString('reason') || 'No reason given', cmd = i.commandName;
      if (cmd === 'warnings') {
        const { rows } = await db.query('select reason, created_at from warnings where guild_id=$1 and user_id=$2 order by id desc limit 10', [i.guildId, i.options.getUser('user').id]);
        return i.reply({ ephemeral: true, content: rows.length ? rows.map((r, n) => `${n + 1}. ${r.reason} (${r.created_at.toISOString().slice(0, 10)})`).join('\n') : 'No warnings for this member.' });
      }
      if (!target) return fail('That person is not in this server.');
      if (target.id === i.user.id || target.id === client.user.id) return fail("You can't do that to this member.");
      if (i.guild.ownerId !== i.user.id && i.member.roles.highest.position <= target.roles.highest.position) return fail('Their top role is equal to or above yours.');
      const ok = { kick: target.kickable, ban: target.bannable, timeout: target.moderatable, warn: true }[cmd];
      if (!ok) return fail(`I can't do that. My role must be above theirs and have the permission.`);

      const { rows: [s] } = await db.query('select log_channel, dm from mod_settings where guild_id=$1', [i.guildId]);
      if (s?.dm) await target.send(`You were ${past[cmd]} **${i.guild.name}**. Reason: ${why}`).catch(() => {});
      let extra = '';
      if (cmd === 'kick') await target.kick(why);
      if (cmd === 'ban') await target.ban({ reason: why });
      if (cmd === 'timeout') await target.timeout(i.options.getInteger('minutes') * 6e4, why);
      if (cmd === 'warn') {
        await db.query('insert into warnings (guild_id, user_id, mod_id, reason) values ($1,$2,$3,$4)', [i.guildId, target.id, i.user.id, why]);
        const es = await cfg(db, i.guildId, 'escalation');
        if (es.warnLimit > 0) {
          const { rows: [w] } = await db.query('select count(*)::int as n from warnings where guild_id=$1 and user_id=$2', [i.guildId, target.id]);
          if (w.n >= es.warnLimit) {
            const done = es.warnAction === 'ban' ? target.bannable && await target.ban({ reason: 'Warning limit reached' }).then(() => true)
              : es.warnAction === 'kick' ? target.kickable && await target.kick('Warning limit reached').then(() => true)
              : target.moderatable && await target.timeout(es.warnMinutes * 6e4, 'Warning limit reached').then(() => true);
            if (done) extra = `\nThey reached ${w.n} warnings, so they were ${es.warnAction === 'timeout' ? 'timed out' : es.warnAction === 'kick' ? 'kicked' : 'banned'}.`;
          }
        }
      }

      const ch = s?.log_channel && i.guild.channels.cache.get(s.log_channel);
      if (ch?.isTextBased()) {
        ch.send({ embeds: [new EmbedBuilder().setColor('#6657f5').setTitle(cmd[0].toUpperCase() + cmd.slice(1)).setThumbnail(target.user.displayAvatarURL())
          .addFields({ name: 'Member', value: `${target.user.username} (${target.id})` }, { name: 'Moderator', value: `<@${i.user.id}>` }, { name: 'Reason', value: why }).setTimestamp()] }).catch(() => {});
      }
      await i.reply({ content: `Done: **${target.user.username}** was ${past[cmd]} this server. Reason: ${why}${extra}` });
    } catch (e) { console.error('mod command', e.message); if (!i.replied) fail('Something went wrong running that command.').catch(() => {}); }
  });
}

export function mountModeration(app, guard, db) {
  app.get('/api/guilds/:id/overview', guard, async (req, res) => {
    const g = req.guild;
    const [s, w, c] = await Promise.all([
      db.query('select log_channel, dm from mod_settings where guild_id=$1', [g.id]),
      db.query('select user_id, mod_id, reason, created_at from warnings where guild_id=$1 order by id desc limit 8', [g.id]),
      db.query('select count(*)::int as n from warnings where guild_id=$1', [g.id]),
    ]);
    const name = (id) => g.members.cache.get(id)?.user.username || id;
    res.json({
      moderation: { logChannelId: s.rows[0]?.log_channel || '', dm: !!s.rows[0]?.dm },
      warnings: w.rows.map((r) => ({ user: name(r.user_id), mod: name(r.mod_id), reason: r.reason, at: r.created_at })),
      warningCount: c.rows[0].n, memberCount: g.memberCount, channelCount: g.channels.cache.size, roleCount: g.roles.cache.size,
    });
  });

  app.put('/api/guilds/:id/moderation', guard, async (req, res) => {
    const id = String(req.body?.logChannelId || '').slice(0, 25), dm = !!req.body?.dm;
    if (id && !req.guild.channels.cache.get(id)?.isTextBased()) return res.status(400).json({ error: 'That channel is not available.' });
    await db.query(`insert into mod_settings (guild_id, log_channel, dm) values ($1,$2,$3)
      on conflict (guild_id) do update set log_channel=$2, dm=$3`, [req.guild.id, id || null, dm]);
    res.json({ ok: true });
  });
}
