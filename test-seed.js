import db from './db/connection.js';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const CITY = 'São Paulo, SP';
let client;
let professional;
let passed = 0;

async function request(path, options) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${options?.method ?? 'GET'} ${path} respondeu ${response.status}: ${body?.error ?? 'sem detalhes'}`);
  }
  return body;
}

async function step(name, run) {
  await run();
  passed += 1;
  console.log(`✅ ${name}`);
}

async function main() {
  console.log(`\nTeste de cadastros ServiçoJá · ${BASE_URL}\n`);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let loyalty, finalRating;

  await step('Base seed contém categorias e profissionais em várias cidades', async () => {
    const [categories, professionals] = await Promise.all([
      request('/api/categories'),
      request('/api/professionals')
    ]);
    if (!categories.length || !professionals.length || new Set(professionals.map((person) => person.city)).size < 2) {
      throw new Error('Categorias ou profissionais seed insuficientes para o teste.');
    }
  });

  await step('Cadastro de cliente concede 20 pontos iniciais', async () => {
    client = await request('/api/clients', {
      method: 'POST',
      body: JSON.stringify({ name: `Cliente Seed ${suffix}`, city: CITY, contact: `cliente-seed-${suffix}@example.com` })
    });
    loyalty = await request(`/api/clients/${client.id}/loyalty`);
    if (loyalty.points !== 20) throw new Error(`Esperados 20 pontos iniciais; recebidos ${loyalty.points}.`);
    const savedEmail = db.prepare('SELECT email FROM clients WHERE id=?').get(client.id)?.email;
    if (savedEmail !== `cliente-seed-${suffix}@example.com`) throw new Error('E-mail de contato não foi salvo corretamente.');
  });

  await step('Cadastro do profissional de teste', async () => {
    professional = await request('/api/professionals', {
      method: 'POST',
      body: JSON.stringify({
        name: `Profissional Seed ${suffix}`,
        category: 'Hidráulica',
        bio: 'Atendimento de teste para serviços hidráulicos residenciais.',
        neighborhood: 'Centro',
        city: CITY,
        phone: '11999990002',
        avgPrice: 140,
        warranty: 30
      })
    });
    if (!professional.id || professional.category !== 'Hidráulica') {
      throw new Error('A API não confirmou o cadastro do profissional hidráulico.');
    }
  });

  await step('Pedido cria registro e soma 10 pontos', async () => {
    const order = await request('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        clientId: client.id,
        professionalId: professional.id,
        description: 'Verificar vazamento na torneira'
      })
    });
    loyalty = await request(`/api/clients/${client.id}/loyalty`);
    if (!order.id || loyalty.points !== 30) throw new Error(`Pedido/saldo inválido: ${loyalty.points} pontos.`);
    const orders = await request(`/api/clients/${client.id}/orders`);
    if (!orders.some((item) => item.id === order.id)) throw new Error('Pedido não consta no histórico do cliente.');
  });

  await step('Avaliação 5 estrelas soma 30 pontos e atualiza profissional', async () => {
    const review = await request('/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        clientId: client.id,
        professionalId: professional.id,
        rating: 5,
        comment: 'Teste automatizado de avaliação.'
      })
    });
    finalRating = review.professional.rating;
    loyalty = await request(`/api/clients/${client.id}/loyalty`);
    if (loyalty.points !== 60 || review.professional.rating !== 5 || review.professional.ratingCount !== 1) {
      throw new Error(`Saldo ou avaliação inválidos: ${loyalty.points} pontos, nota ${review.professional.rating}.`);
    }
  });

  console.log(`\nResultado: ${passed}/5 etapas aprovadas.`);
  console.log(`Cliente: ${client.name} · saldo final ${loyalty.points} pontos.`);
  console.log(`Profissional: ${professional.name} · ${professional.category} · nota ${finalRating}.`);
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  const clientId = Number(client?.id);
  const professionalId = Number(professional?.id);
  if (!clientId && !professionalId) return;
  try {
    db.transaction(() => {
      if (clientId) {
        db.prepare('DELETE FROM loyalty_events WHERE client_id=?').run(clientId);
        db.prepare('DELETE FROM orders WHERE client_id=?').run(clientId);
        db.prepare('DELETE FROM reviews WHERE client_id=?').run(clientId);
      }
      if (professionalId) {
        db.prepare('DELETE FROM orders WHERE professional_id=?').run(professionalId);
        db.prepare('DELETE FROM reviews WHERE professional_id=?').run(professionalId);
        db.prepare('DELETE FROM professionals WHERE id=?').run(professionalId);
      }
      if (clientId) db.prepare('DELETE FROM clients WHERE id=?').run(clientId);
    })();
    console.log('Dados temporários removidos.');
  } catch (error) {
    console.error(`Falha ao remover dados temporários: ${error.message}`);
    process.exitCode = 1;
  }
});
