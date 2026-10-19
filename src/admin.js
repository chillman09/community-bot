const OWNER_ID = process.env.OWNER_ID || '1354472117646786763';

/* What each staff rank can do. The owner (you) is set by OWNER_ID and is never stored in the database. */
export const RANKS = {
  helper: ['view'],
  moderator: ['view', 'blacklist'],
  admin: ['view', 'blacklist', 'premium', 'leave'],
  owner: ['view', 'blacklist', 'premium', 'leave', 'staff'],
};

export async function getRank(db, uid) {
  if (!uid) return null;
  if (uid === OWNER_ID) return { rank: 'owner', perms: RANKS.owner };
  const { rows: [r] } = await db.query('select rank from bot_staff where user_id=$1', [uid]);
  return r && r.rank !== 'owner' && RANKS[r.rank] ? { rank: r.rank, perms: RANKS[r.rank] } : null;
}

export async function isBlacklisted(db, kind, id) {
  if (!id || id === OWNER_ID) return false;
  const { rows } = await db.query('select 1 from bot_blacklist where kind=$1 and id=$2', [kind, id]);
  return rows.length > 0;
}

export const initAdmin = (db) => db.query(`
  create table if not exists bot_staff (user_id text primary key, rank text not null, added_by text, added_at timestamptz not null default now());
  create table if not exists bot_blacklist (kind text not null, id text not null, reason text, added_by text, added_at timestamptz not null default now(), primary key (kind, id));
  create table if not exists admin_log (id serial primary key, user_id text not null, action text not null, detail text, at timestamptz not null default now())`);

export function setupAdmin(client, db) {
  const sweep = async (g) => { if (await isBlacklisted(db, 'guild', g.id)) await g.leave().catch(() => {}); };
  client.on('guildCreate', (g) => sweep(g).catch(() => {}));
  client.once('ready', () => client.guilds.cache.forEach((g) => sweep(g).catch(() => {})));
}

export function mountAdmin(app, client, db) {
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => { console.error('admin api', e.message); if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' }); });
  const need = (perm) => wrap(async (req, res, next) => {
    const a = await getRank(db, req.session?.uid);
    if (!a || (perm && !a.perms.includes(perm))) return res.status(403).json({ error: 'You do not have access to this.' });
    req.admin = a; next();
  });
  const log = (req, action, detail = '') => db.query('insert into admin_log (user_id, action, detail) values ($1,$2,$3)', [req.session.uid, action, String(detail).slice(0, 300)]).catch(() => {});
  const nameOf = async (id) => (await client.users.fetch(id).catch(() => null))?.username || id;
  const validId = (v) => /^\d{15,20}$/.test(String(v ?? '').trim());

  app.get('/api/admin/overview', need('view'), wrap(async (req, res) => {
    const n = (sql) => db.query(sql).then((r) => r.rows[0].n);
    const [premium, blocked, warnings] = await Promise.all([
      n('select count(*)::int as n from guild_settings where premium'), n('select count(*)::int as n from bot_blacklist'), n('select count(*)::int as n from warnings')]);
    res.json({ servers: client.guilds.cache.size, members: client.guilds.cache.reduce((a, g) => a + g.memberCount, 0), ping: Math.round(client.ws.ping), uptime: process.uptime(), memory: Math.round(process.memoryUsage().rss / 1048576), premium, blocked, warnings });
  }));

  app.get('/api/admin/servers', need('view'), wrap(async (req, res) => {
    const { rows } = await db.query('select guild_id from guild_settings where premium');
    const prem = new Set(rows.map((r) => r.guild_id));
    res.json([...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount)
      .map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }), members: g.memberCount, ownerId: g.ownerId, premium: prem.has(g.id) })));
  }));

  app.post('/api/admin/servers/:id/premium', need('premium'), wrap(async (req, res) => {
    if (!client.guilds.cache.has(req.params.id)) return res.status(404).json({ error: 'The bot is not in that server.' });
    const on = !!req.body?.premium;
    await db.query('insert into guild_settings (guild_id, premium) values ($1,$2) on conflict (guild_id) do update set premium=$2', [req.params.id, on]);
    log(req, on ? 'premium on' : 'premium off', req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/admin/servers/:id/leave', need('leave'), wrap(async (req, res) => {
    const g = client.guilds.cache.get(req.params.id);
    if (!g) return res.status(404).json({ error: 'The bot is not in that server.' });
    await g.leave();
    log(req, 'left server', `${g.name} (${g.id})`);
    res.json({ ok: true });
  }));

  app.get('/api/admin/blacklist', need('view'), wrap(async (req, res) => {
    const { rows } = await db.query('select kind, id, reason, added_by, added_at from bot_blacklist order by added_at desc limit 200');
    res.json(rows.map((r) => ({ kind: r.kind, id: r.id, reason: r.reason, by: r.added_by, at: r.added_at })));
  }));

  app.post('/api/admin/blacklist', need('blacklist'), wrap(async (req, res) => {
    const kind = req.body?.kind === 'user' ? 'user' : 'guild', id = String(req.body?.id ?? '').trim();
    if (!validId(id)) return res.status(400).json({ error: 'Enter a valid ID (15 to 20 digits).' });
    if (id === OWNER_ID) return res.status(400).json({ error: "The owner can't be blocked." });
    if (kind === 'user' && req.admin.rank !== 'owner' && await getRank(db, id)) return res.status(403).json({ error: 'Only the owner can block staff.' });
    await db.query(`insert into bot_blacklist (kind, id, reason, added_by) values ($1,$2,$3,$4)
      on conflict (kind, id) do update set reason=$3`, [kind, id, String(req.body?.reason ?? '').slice(0, 200), req.session.uid]);
    if (kind === 'guild') await client.guilds.cache.get(id)?.leave().catch(() => {});
    log(req, `blocked ${kind}`, id);
    res.json({ ok: true });
  }));

  app.delete('/api/admin/blacklist/:kind/:id', need('blacklist'), wrap(async (req, res) => {
    await db.query('delete from bot_blacklist where kind=$1 and id=$2', [req.params.kind, req.params.id]);
    log(req, `unblocked ${req.params.kind}`, req.params.id);
    res.json({ ok: true });
  }));

  app.get('/api/admin/staff', need('staff'), wrap(async (req, res) => {
    const { rows } = await db.query('select user_id, rank from bot_staff order by added_at');
    res.json({ ranks: RANKS, staff: await Promise.all(rows.map(async (r) => ({ id: r.user_id, rank: r.rank, name: await nameOf(r.user_id) }))) });
  }));

  app.post('/api/admin/staff', need('staff'), wrap(async (req, res) => {
    const id = String(req.body?.userId ?? '').trim(), rank = req.body?.rank;
    if (!validId(id)) return res.status(400).json({ error: 'Enter a valid Discord user ID.' });
    if (!RANKS[rank] || rank === 'owner') return res.status(400).json({ error: 'Pick helper, moderator or admin.' });
    if (id === OWNER_ID) return res.status(400).json({ error: "You're the owner already." });
    const u = await client.users.fetch(id).catch(() => null);
    if (!u) return res.status(404).json({ error: 'No Discord user has that ID.' });
    await db.query(`insert into bot_staff (user_id, rank, added_by) values ($1,$2,$3)
      on conflict (user_id) do update set rank=$2`, [id, rank, req.session.uid]);
    log(req, 'staff set', `${u.username} (${id}) as ${rank}`);
    res.json({ ok: true, name: u.username });
  }));

  app.delete('/api/admin/staff/:id', need('staff'), wrap(async (req, res) => {
    await db.query('delete from bot_staff where user_id=$1', [req.params.id]);
    log(req, 'staff removed', req.params.id);
    res.json({ ok: true });
  }));

  app.get('/api/admin/log', need('view'), wrap(async (req, res) => {
    const { rows } = await db.query('select user_id, action, detail, at from admin_log order by id desc limit 50');
    const names = Object.fromEntries(await Promise.all([...new Set(rows.map((r) => r.user_id))].map(async (id) => [id, await nameOf(id)])));
    res.json(rows.map((r) => ({ who: names[r.user_id], action: r.action, detail: r.detail, at: r.at })));
  }));
}
