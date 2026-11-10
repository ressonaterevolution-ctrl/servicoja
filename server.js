import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import db from './db/connection.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));

const REVIEW_POINTS = 30;
const ORDER_POINTS = 10;
const TIERS = [
  { name: 'Bronze', min: 0 },
  { name: 'Prata', min: 100 },
  { name: 'Ouro', min: 300 },
  { name: 'Diamante', min: 600 }
];

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

const PRO_SQL = `SELECT p.id, p.name, p.bio, p.neighborhood, p.city, p.phone, p.avg_price AS avgPrice,
  p.warranty, p.verified, p.rating_count AS ratingCount,
  CASE WHEN p.rating_count = 0 THEN 0 ELSE ROUND(1.0 * p.rating_sum / p.rating_count, 1) END AS rating,
  c.name AS category, c.icon AS categoryIcon
  FROM professionals p JOIN categories c ON c.id = p.category_id`;
const shape = (p) => ({ ...p, warranty: p.warranty > 0 ? p.warranty : 0, verified: !!p.verified });

function loyalty(clientId) {
  const points = db.prepare('SELECT COALESCE(SUM(points),0) s FROM loyalty_events WHERE client_id=?').get(clientId).s;
  let idx = 0;
  TIERS.forEach((t, i) => { if (points >= t.min) idx = i; });
  const next = TIERS[idx + 1] ?? null;
  const events = db.prepare('SELECT points, reason, created_at AS createdAt FROM loyalty_events WHERE client_id=? ORDER BY id DESC LIMIT 20').all(clientId);
  return { points, tier: TIERS[idx].name, nextTier: next?.name ?? null, pointsToNext: next ? next.min - points : 0, tierMin: TIERS[idx].min, nextMin: next?.min ?? null, events };
}
const addPoints = (clientId, points, reason) =>
  db.prepare('INSERT INTO loyalty_events (client_id, points, reason) VALUES (?,?,?)').run(clientId, points, reason);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/categories', (_req, res) =>
  res.json(db.prepare('SELECT id, name, icon FROM categories ORDER BY id').all()));

app.get('/api/cities', (_req, res) =>
  res.json(db.prepare('SELECT DISTINCT city FROM professionals ORDER BY city').all().map((r) => r.city)));

app.get('/api/professionals', (req, res) => {
  const { city, category, q } = req.query;
  const where = [], params = [];
  if (city) { where.push('p.city = ?'); params.push(str(city, 80)); }
  if (category) { where.push('c.name = ?'); params.push(str(category, 40)); }
  if (q) { where.push('(p.name LIKE ? OR p.bio LIKE ?)'); params.push(`%${str(q, 60)}%`, `%${str(q, 60)}%`); }
  const sql = `${PRO_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rating DESC, p.rating_count DESC`;
  res.json(db.prepare(sql).all(...params).map(shape));
});

app.get('/api/professionals/:id', (req, res) => {
  const p = db.prepare(`${PRO_SQL} WHERE p.id = ?`).get(Number(req.params.id));
  if (!p) return bad(res, 'Profissional não encontrado.', 404);
  const reviews = db.prepare('SELECT id, author, rating, comment, created_at AS createdAt FROM reviews WHERE professional_id=? ORDER BY id DESC LIMIT 30').all(p.id);
  res.json({ ...shape(p), reviews });
});

app.post('/api/professionals', (req, res) => {
  const b = req.body ?? {};
  const name = str(b.name, 80), bio = str(b.bio, 600), city = str(b.city, 80);
  const phone = str(b.phone, 20).replace(/\D/g, '');
  const price = Math.round(Number(b.avgPrice));
  const cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(str(b.category, 40));
  if (name.length < 3) return bad(res, 'Informe o nome completo.');
  if (!cat) return bad(res, 'Escolha uma categoria válida.');
  if (!city) return bad(res, 'Escolha a cidade de atendimento.');
  if (phone.length < 10) return bad(res, 'Informe um WhatsApp com DDD.');
  if (!Number.isFinite(price) || price <= 0) return bad(res, 'Informe o preço médio.');
  if (bio.length < 10) return bad(res, 'Descreva seu trabalho em pelo menos 10 caracteres.');
  const warranty = Math.max(0, Math.min(365, Math.round(Number(b.warranty) || 0)));
  const id = db.prepare(`INSERT INTO professionals (name, category_id, bio, neighborhood, city, phone, avg_price, warranty)
    VALUES (?,?,?,?,?,?,?,?)`).run(name, cat.id, bio, str(b.neighborhood, 60), city, phone.startsWith('55') ? phone : '55' + phone, price, warranty).lastInsertRowid;
  res.status(201).json(shape(db.prepare(`${PRO_SQL} WHERE p.id = ?`).get(id)));
});

// "IA" local: pontua categorias por palavras-chave e ordena profissionais da cidade
app.post('/api/match', (req, res) => {
  const description = str(req.body?.description, 500), city = str(req.body?.city, 80);
  if (description.length < 3) return bad(res, 'Descreva o problema com mais detalhes.');
  const text = norm(description);
  const cats = db.prepare('SELECT id, name, icon, keywords FROM categories').all();
  const scored = cats.map((c) => {
    const hits = c.keywords.split(',').map((k) => norm(k.trim())).filter((k) => k && text.includes(k));
    return { ...c, score: hits.reduce((s, k) => s + 1 + k.length / 20, 0), hits };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0] ?? null;
  const top = best ? scored.filter((c) => c.score >= best.score * 0.6).slice(0, 2) : [];
  const ids = top.map((c) => c.id);
  let professionals = [];
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    professionals = db.prepare(`${PRO_SQL} WHERE p.category_id IN (${ph}) ${city ? 'AND p.city = ?' : ''}
      ORDER BY (CASE WHEN p.verified=1 THEN 0.3 ELSE 0 END) + (CASE WHEN p.rating_count=0 THEN 0 ELSE 1.0*p.rating_sum/p.rating_count END) DESC, p.rating_count DESC LIMIT 6`)
      .all(...ids, ...(city ? [city] : [])).map(shape);
  }
  res.json({
    category: best ? { name: best.name, icon: best.icon } : null,
    confidence: best ? Math.min(98, Math.round(60 + best.score * 12)) : 0,
    summary: best ? `Parece ser um serviço de ${best.name.toLowerCase()}.` : 'Não identifiquei o tipo de serviço.',
    professionals
  });
});

app.post('/api/clients', (req, res) => {
  const name = str(req.body?.name, 80), city = str(req.body?.city, 80);
  const contact = str(req.body?.contact, 120);
  const email = contact.includes('@') ? contact : null;
  const phone = email ? null : str(req.body?.phone ?? contact, 20) || null;
  if (name.length < 2) return bad(res, 'Informe seu nome.');
  if (!city) return bad(res, 'Escolha sua cidade.');
  const id = db.prepare('INSERT INTO clients (name, city, phone, email) VALUES (?,?,?,?)').run(name, city, phone, email).lastInsertRowid;
  addPoints(id, 20, 'Bônus de boas-vindas');
  res.status(201).json({ id: Number(id), name, city });
});

app.get('/api/clients/:id', (req, res) => {
  const c = db.prepare('SELECT id, name, city, phone FROM clients WHERE id=?').get(Number(req.params.id));
  return c ? res.json(c) : bad(res, 'Cliente não encontrado.', 404);
});

app.patch('/api/clients/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM clients WHERE id=?').get(id)) return bad(res, 'Cliente não encontrado.', 404);
  const city = str(req.body?.city, 80);
  if (city) db.prepare('UPDATE clients SET city=? WHERE id=?').run(city, id);
  res.json(db.prepare('SELECT id, name, city, phone FROM clients WHERE id=?').get(id));
});

app.get('/api/clients/:id/loyalty', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM clients WHERE id=?').get(id)) return bad(res, 'Cliente não encontrado.', 404);
  res.json(loyalty(id));
});

app.get('/api/clients/:id/orders', (req, res) => {
  res.json(db.prepare(`SELECT o.id, o.description, o.address, o.status, o.created_at AS createdAt,
    p.id AS professionalId, p.name AS professionalName, p.phone AS professionalPhone, c.name AS category
    FROM orders o JOIN professionals p ON p.id=o.professional_id JOIN categories c ON c.id=p.category_id
    WHERE o.client_id=? ORDER BY o.id DESC`).all(Number(req.params.id)));
});

app.post('/api/orders', (req, res) => {
  const clientId = Number(req.body?.clientId), proId = Number(req.body?.professionalId);
  const description = str(req.body?.description, 500);
  if (!db.prepare('SELECT 1 FROM clients WHERE id=?').get(clientId)) return bad(res, 'Cliente não encontrado.', 404);
  const pro = db.prepare('SELECT id, name, phone FROM professionals WHERE id=?').get(proId);
  if (!pro) return bad(res, 'Profissional não encontrado.', 404);
  if (description.length < 5) return bad(res, 'Descreva o que você precisa.');
  const id = db.prepare('INSERT INTO orders (client_id, professional_id, description, address) VALUES (?,?,?,?)')
    .run(clientId, proId, description, str(req.body?.address, 200) || null).lastInsertRowid;
  addPoints(clientId, ORDER_POINTS, `Pedido para ${pro.name}`);
  res.status(201).json({ id: Number(id), professional: pro, pointsEarned: ORDER_POINTS, loyalty: loyalty(clientId) });
});

app.post('/api/reviews', (req, res) => {
  const clientId = Number(req.body?.clientId), proId = Number(req.body?.professionalId);
  const rating = Math.round(Number(req.body?.rating)), comment = str(req.body?.comment, 500);
  const client = db.prepare('SELECT id, name FROM clients WHERE id=?').get(clientId);
  if (!client) return bad(res, 'Cliente não encontrado.', 404);
  if (!db.prepare('SELECT 1 FROM professionals WHERE id=?').get(proId)) return bad(res, 'Profissional não encontrado.', 404);
  if (!(rating >= 1 && rating <= 5)) return bad(res, 'Escolha uma nota de 1 a 5.');
  if (db.prepare('SELECT 1 FROM reviews WHERE client_id=? AND professional_id=?').get(clientId, proId))
    return bad(res, 'Você já avaliou este profissional.', 409);
  db.transaction(() => {
    db.prepare('INSERT INTO reviews (professional_id, client_id, author, rating, comment) VALUES (?,?,?,?,?)').run(proId, clientId, client.name, rating, comment);
    db.prepare('UPDATE professionals SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE id=?').run(rating, proId);
    addPoints(clientId, REVIEW_POINTS, 'Avaliação enviada');
  })();
  res.status(201).json({
    pointsEarned: REVIEW_POINTS,
    professional: shape(db.prepare(`${PRO_SQL} WHERE p.id=?`).get(proId)),
    loyalty: loyalty(clientId)
  });
});

app.use('/api', (_req, res) => bad(res, 'Rota não encontrada.', 404));

// Em produção, serve o frontend compilado (frontend/dist)
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => { console.error(err); bad(res, 'Erro interno do servidor.', 500); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ServiçoJá rodando em http://localhost:${PORT}`));
