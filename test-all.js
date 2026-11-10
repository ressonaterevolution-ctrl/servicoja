import db from './db/connection.js';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const CITY = 'São Paulo, SP';
let passed = 0;
let client, professional;

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(label, run) {
  try {
    await run();
    passed += 1;
    console.log(`✅ ${label}`);
  } catch (error) {
    console.error(`❌ ${label}: ${error.message}`);
    process.exitCode = 1;
    throw error;
  }
}

async function main() {
  console.log(`\nTeste integrado ServiçoJá · ${BASE_URL}\n`);

  let categories, professionals, loyalty;
  await check('Categorias e profissionais em cidades diferentes', async () => {
    categories = await request('/api/categories');
    professionals = await request('/api/professionals');
    const cities = new Set(professionals.map((person) => person.city));
    assert(categories.length > 0, 'Nenhuma categoria cadastrada.');
    assert(professionals.length > 0, 'Nenhum profissional cadastrado.');
    assert(cities.size > 1, `Esperadas várias cidades; encontradas: ${[...cities].join(', ')}`);
    assert(categories.some((category) => category.name === 'Hidráulica'), 'Categoria Hidráulica não encontrada.');
  });

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await check('Cadastro do cliente e bônus inicial de 20 pontos', async () => {
    client = await request('/api/clients', {
      method: 'POST',
      body: JSON.stringify({ name: `Cliente Teste ${suffix}`, city: CITY })
    });
    loyalty = await request(`/api/clients/${client.id}/loyalty`);
    assert(loyalty.points === 20, `Saldo inicial esperado: 20; recebido: ${loyalty.points}.`);
  });

  await check('Cadastro do profissional de teste', async () => {
    professional = await request('/api/professionals', {
      method: 'POST',
      body: JSON.stringify({
        name: `Profissional Teste ${suffix}`,
        category: 'Hidráulica',
        bio: 'Atendimento de teste para instalações e vazamentos hidráulicos.',
        neighborhood: 'Centro',
        city: CITY,
        phone: '11999990000',
        avgPrice: 150,
        warranty: 30
      })
    });
    assert(professional.id > 0, 'A API não retornou o profissional criado.');
    assert(professional.category === 'Hidráulica', 'A categoria retornada não corresponde ao cadastro.');
  });

  await check('Match IA para pintura, chuveiro e torneira', async () => {
    const cases = [
      { description: 'Pintar a sala', category: 'Pintura' },
      { description: 'Chuveiro não esquenta', category: 'Elétrica' },
      { description: 'Torneira vazando', category: 'Hidráulica', expectsNewProfessional: true }
    ];
    for (const testCase of cases) {
      const result = await request('/api/match', {
        method: 'POST',
        body: JSON.stringify({ description: testCase.description, city: CITY })
      });
      assert(result.category?.name === testCase.category,
        `"${testCase.description}" deveria identificar ${testCase.category}; identificado: ${result.category?.name ?? 'nenhuma categoria'}.`);
      if (testCase.expectsNewProfessional) {
        assert(result.professionals.some((person) => person.id === professional.id),
          'O profissional recém-cadastrado não apareceu no match hidráulico.');
      }
    }
  });

  await check('Pedido registrado e bônus de 10 pontos', async () => {
    const order = await request('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        clientId: client.id,
        professionalId: professional.id,
        description: 'Verificar vazamento na torneira da cozinha'
      })
    });
    assert(order.id > 0, 'A API não retornou o pedido criado.');
    assert(order.pointsEarned === 10 && order.loyalty.points === 30,
      `Após o pedido, esperados 30 pontos; recebidos ${order.loyalty.points}.`);
    const clientOrders = await request(`/api/clients/${client.id}/orders`);
    assert(clientOrders.some((item) => item.id === order.id), 'Pedido não apareceu na lista do cliente.');
    loyalty = order.loyalty;
  });

  await check('Avaliação 5 estrelas, +30 pontos e atualização do profissional', async () => {
    const review = await request('/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        clientId: client.id,
        professionalId: professional.id,
        rating: 5,
        comment: 'Atendimento de teste aprovado.'
      })
    });
    assert(review.pointsEarned === 30 && review.loyalty.points === 60,
      `Após a avaliação, esperados 60 pontos; recebidos ${review.loyalty.points}.`);
    assert(review.professional.rating === 5 && review.professional.ratingCount === 1,
      `Esperada avaliação profissional 5.0 (1 avaliação); recebida ${review.professional.rating} (${review.professional.ratingCount}).`);
    loyalty = review.loyalty;
  });

  console.log(`\nResultado: ${passed}/6 etapas aprovadas.`);
  console.log(`Cliente de teste: ${client.name} · ${loyalty.points} pontos.`);
  console.log(`Profissional de teste: ${professional.name} · ${professional.category} · ${professional.city}.`);
}

main().catch((error) => {
  if (!process.exitCode) console.error(`\nTeste interrompido: ${error.message}`);
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
    console.log('Dados temporários do teste removidos.');
  } catch (error) {
    console.error(`Falha ao remover dados temporários do teste: ${error.message}`);
    process.exitCode = 1;
  }
});
