/**
 * whatsapp-oficial.js — o ouvido e a boca do Morinho na API OFICIAL (Cloud API da Meta).
 *
 * Existe em paralelo ao bot.js (Baileys) DE PROPOSITO: enquanto a migracao nao termina,
 * o Morinho antigo segue atendendo os clientes de verdade e este aqui e exercitado
 * contra o numero de TESTE da Meta. Quando a virada acontecer, o bot.js e apagado e a
 * logica que hoje esta duplicada aqui fica sendo a unica.
 *
 * A diferenca de fundo entre os dois:
 *   Baileys  — nos mantemos uma conexao aberta e o WhatsApp nos empurra as mensagens.
 *   Cloud API — a Meta faz uma requisicao HTTP no NOSSO servidor a cada mensagem
 *               (o "webhook"), e nos respondemos chamando a API dela de volta.
 * Some a conexao permanente, e com ela somem os sockets zumbis, o `Bad MAC` e as
 * sessoes corrompidas que consumiram a semana passada.
 *
 * Variaveis no .env:
 *   WA_TOKEN             token de acesso do app (SEGREDO)
 *   WA_PHONE_NUMBER_ID   id do numero que envia (aparece no painel do app)
 *   WA_VERIFY_TOKEN      senha que NOS inventamos, so para o aperto de mao do webhook
 *   WA_APP_SECRET        chave secreta do app (SEGREDO) — valida a assinatura
 *   WA_WEBHOOK_PORTA     opcional, padrao 3001
 *   WA_API_VERSAO        opcional, padrao v25.0
 */

const crypto = require('crypto');
const express = require('express');
const config = require('./config.json');
const { responder } = require('./cerebro');

const TOKEN = process.env.WA_TOKEN || '';
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID || '';
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || '';
const APP_SECRET = process.env.WA_APP_SECRET || '';
const PORTA_PADRAO = Number(process.env.WA_WEBHOOK_PORTA) || 3001;
const API = `https://graph.facebook.com/${process.env.WA_API_VERSAO || 'v25.0'}`;

// ---------------------------------------------------------------------------
// Estado em memoria (mesma escolha do bot.js: reinicia junto com o processo)
// ---------------------------------------------------------------------------

const historico = new Map();   // numero -> [{ role, content }]
const pausados = new Map();    // numero -> timestamp ate quando o bot fica quieto
const buffers = new Map();     // numero -> { textos: [], nome, timer }

// A Meta REENVIA o mesmo evento se nao responder 200 rapido, e reenvia de novo se
// achar que falhou. Sem esta trava o cliente receberia a mesma resposta duas ou tres
// vezes — e, pior, uma reserva poderia ser criada em duplicata.
const jaProcessadas = new Set();
const LIMITE_IDS = 500;

function lembrarId(id) {
  jaProcessadas.add(id);
  if (jaProcessadas.size > LIMITE_IDS) {
    // Set mantem ordem de insercao: descarta os mais antigos, que a Meta ja nao reenvia.
    for (const antigo of jaProcessadas) {
      jaProcessadas.delete(antigo);
      if (jaProcessadas.size <= LIMITE_IDS) break;
    }
  }
}

function estaPausado(numero) {
  const ate = pausados.get(numero);
  if (!ate) return false;
  if (Date.now() > ate) { pausados.delete(numero); return false; }
  return true;
}

function pausar(numero, minutos) {
  pausados.set(numero, Date.now() + minutos * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Falar com a API da Meta
// ---------------------------------------------------------------------------

async function chamarAPI(caminho, corpo) {
  const r = await fetch(`${API}/${caminho}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(corpo),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    // O erro da Meta vem estruturado e e MUITO mais util que "falhou": traz o motivo
    // exato (token vencido, numero fora da lista de teste, janela de 24h fechada...).
    const e = dados?.error || {};
    throw new Error(`Meta ${r.status}: ${e.message || 'sem detalhe'}${e.code ? ` (code ${e.code})` : ''}`);
  }
  return dados;
}

async function enviarTexto(numero, texto) {
  return chamarAPI(`${PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to: numero,
    type: 'text',
    // preview_url: false para o link do cardapio digital nao virar um card gigante
    text: { body: texto, preview_url: false },
  });
}

// Marca a mensagem do cliente como lida (os dois tiquinhos azuis). Nao e enfeite:
// sem isso o cliente fica olhando para uma mensagem "nao entregue" enquanto o Morinho
// pensa, e costuma reenviar tudo de novo.
async function marcarComoLida(idMensagem) {
  return chamarAPI(`${PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: idMensagem,
  });
}

// ---------------------------------------------------------------------------
// Seguranca: a requisicao veio mesmo da Meta?
// ---------------------------------------------------------------------------

/**
 * O endereco do webhook e publico — qualquer um na internet pode bater nele e fingir
 * ser um cliente. A Meta assina cada requisicao com a chave secreta do app; conferimos
 * a assinatura sobre o corpo BRUTO (por isso guardamos ele no express.json abaixo:
 * reserializar o JSON mudaria um espaco e derrubaria a assinatura).
 */
function assinaturaValida(req) {
  if (!APP_SECRET) {
    console.warn('⚠️  WA_APP_SECRET nao definido — nao da para conferir quem esta chamando.');
    return false;
  }
  const enviada = req.get('x-hub-signature-256') || '';
  if (!enviada.startsWith('sha256=')) return false;

  const esperada = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.corpoBruto || Buffer.alloc(0))
    .digest('hex');

  const a = Buffer.from(enviada);
  const b = Buffer.from(esperada);
  // timingSafeEqual exige mesmo tamanho e compara sem vazar onde as strings diferem
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Entender o que chegou
// ---------------------------------------------------------------------------

// Tipos que o cliente manda e que o Morinho nao sabe ler — mesma regra do bot.js:
// so estes justificam chamar a equipe.
const TIPOS_MIDIA = ['audio', 'image', 'video', 'document', 'sticker', 'location', 'contacts'];

/**
 * Devolve { tipo, texto, rotulo } para uma mensagem do webhook.
 * O formato da Cloud API e bem mais simples que o do Baileys: nao ha envelopes
 * aninhados nem "ver uma vez" para desembrulhar.
 */
function classificarMensagem(msg) {
  if (msg.type === 'text') {
    const t = (msg.text?.body || '').trim();
    return t ? { tipo: 'texto', texto: t } : { tipo: 'ignorar', rotulo: 'texto vazio' };
  }
  // Botao/lista: o cliente escolheu uma opcao — tratamos como texto
  const escolha = msg.button?.text || msg.interactive?.button_reply?.title
    || msg.interactive?.list_reply?.title;
  if (escolha) return { tipo: 'texto', texto: escolha.trim() };

  if (msg.type === 'reaction') return { tipo: 'ignorar', rotulo: 'reacao' };
  if (TIPOS_MIDIA.includes(msg.type)) return { tipo: 'midia', rotulo: msg.type };
  return { tipo: 'ignorar', rotulo: msg.type || 'desconhecido' };
}

// ---------------------------------------------------------------------------
// Responder o cliente
// ---------------------------------------------------------------------------

async function pensarResposta(numero, textoCliente, nomeCliente) {
  const hist = historico.get(numero) || [];
  const r = await responder(hist, textoCliente, nomeCliente, numero);
  historico.set(numero, [
    ...hist,
    { role: 'user', content: textoCliente },
    { role: 'assistant', content: r.texto },
  ].slice(-config.limiteHistorico));
  return r;
}

// Junta mensagens picadas ("oi" / "queria reservar" / "pra sabado") numa so, para o
// Morinho responder uma vez e nao tres.
function agendarProcessamento(numero, nome, texto) {
  const buf = buffers.get(numero) || { textos: [], nome, timer: null };
  buf.textos.push(texto);
  buf.nome = nome || buf.nome;
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    processar(numero).catch((err) =>
      console.error('❌ Erro ao responder:', err.message || err));
  }, config.debounceSegundos * 1000);
  buffers.set(numero, buf);
}

async function processar(numero) {
  const buf = buffers.get(numero);
  if (!buf) return;
  buffers.delete(numero);

  const textoCliente = buf.textos.join('\n').trim();
  if (!textoCliente) return;
  if (estaPausado(numero)) return; // humano assumiu enquanto o timer corria

  const { texto, handoff, cardapio, cartaSaques, reservas } =
    await pensarResposta(numero, textoCliente, buf.nome);

  if (texto) await enviarTexto(numero, texto);

  // ponytail: cardapio/carta de saques em PDF ainda nao — na Cloud API o arquivo
  // precisa ser enviado por link publico ou por upload previo (media_id). Como o site
  // ja esta no ar, o caminho barato e publicar os PDFs nele e mandar o link. Fica para
  // o proximo passo; por ora avisamos no log para nao passar despercebido.
  if (cardapio) console.warn(`🍣 PEDIU CARDAPIO (${numero}) — envio de PDF ainda nao implementado aqui.`);
  if (cartaSaques) console.warn(`🍶 PEDIU CARTA DE SAQUES (${numero}) — idem.`);

  if (reservas && reservas.length) {
    for (const rv of reservas) {
      console.log(`📅 Reserva criada: ${rv.data} ${rv.horario} · ${rv.pessoas}p · ${rv.nome}`);
    }
    await avisarEquipe(`📅 Nova reserva confirmada pelo Morinho para +${numero}.`);
  }

  if (handoff) {
    await avisarEquipe(`🔔 +${numero} precisa de atendimento: "${textoCliente}"`);
    pausar(numero, config.pausaHumanoMinutos);
    console.log(`🔔 Handoff -> ${numero} (pausado ${config.pausaHumanoMinutos}min)`);
  }
}

/**
 * Avisa a equipe que alguem precisa entrar na conversa.
 *
 * ⚠️ PENDENTE DE REDESENHO. Hoje (Baileys) isso vira mensagem no grupo interno do
 * WhatsApp. Na API oficial a Meta NAO entrega grupos para numeros em Coexistence:
 * o grupo continua existindo para a equipe no aplicativo, mas o Morinho nao alcanca
 * mais ele. Por enquanto so registramos no log — o destino definitivo (painel com uma
 * tela de "precisa de atendimento", Telegram, ou os dois) fica para a proxima etapa.
 */
async function avisarEquipe(mensagem) {
  console.log(`👥 [AVISO A EQUIPE] ${mensagem}`);
}

// ---------------------------------------------------------------------------
// O webhook
// ---------------------------------------------------------------------------

// Cada evento do webhook pode trazer varias mensagens; percorremos tudo.
async function processarEvento(corpo) {
  if (corpo.object !== 'whatsapp_business_account') return;

  for (const entrada of corpo.entry || []) {
    for (const mudanca of entrada.changes || []) {
      const valor = mudanca.value || {};

      // "statuses" e recibo de entrega/leitura das NOSSAS mensagens. Nao e pergunta
      // de cliente: nao respondemos nada.
      if (valor.statuses) continue;

      const nomePorNumero = new Map(
        (valor.contacts || []).map((c) => [c.wa_id, c.profile?.name])
      );

      for (const msg of valor.messages || []) {
        if (!msg.id || jaProcessadas.has(msg.id)) continue;
        lembrarId(msg.id);

        const numero = msg.from;
        if (!numero) continue;

        // ANTI-ATROPELO: com Coexistence, o que a equipe manda pelo celular volta para
        // nos como "echo". Se veio de nos e nao fomos nos que mandamos, foi um humano
        // digitando — o Morinho se cala nessa conversa.
        if (mudanca.field === 'smb_message_echoes' || msg.from === valor.metadata?.display_phone_number) {
          pausar(msg.to || numero, config.pausaHumanoMinutos);
          console.log(`🙋 Humano assumiu ${msg.to || numero} — silencio por ${config.pausaHumanoMinutos}min.`);
          continue;
        }

        if (estaPausado(numero)) continue;

        const nome = nomePorNumero.get(numero);
        const { tipo, texto, rotulo } = classificarMensagem(msg);

        marcarComoLida(msg.id).catch(() => { /* nao vale derrubar a resposta por causa do visto */ });

        if (tipo === 'ignorar') {
          console.log(`🔇 Ignorado (${rotulo}) de ${numero}`);
          continue;
        }

        if (tipo === 'midia') {
          await enviarTexto(numero,
            'Recebi sua mensagem. Vou chamar alguém da nossa equipe para te ajudar melhor.');
          await avisarEquipe(`🎧 +${numero} mandou ${rotulo} — o Morinho não sabe ler.`);
          pausar(numero, config.pausaHumanoMinutos);
          console.log(`🎧 Midia (${rotulo}) -> handoff em ${numero}`);
          continue;
        }

        agendarProcessamento(numero, nome, texto);
      }
    }
  }
}

function montarRotas(app) {
  // Aperto de mao: a Meta chama UMA vez, ao salvar o webhook no painel dela. Se nao
  // devolvermos o desafio dela em texto puro, ela recusa o endereco na hora.
  app.get('/webhook', (req, res) => {
    const modo = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const desafio = req.query['hub.challenge'];
    if (modo === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      console.log('🤝 Webhook verificado pela Meta.');
      return res.status(200).send(String(desafio));
    }
    console.warn('⚠️  Tentativa de verificacao do webhook com token errado.');
    res.sendStatus(403);
  });

  app.post('/webhook', (req, res) => {
    if (!assinaturaValida(req)) {
      console.warn('⚠️  Requisicao no webhook com assinatura invalida — descartada.');
      return res.sendStatus(403);
    }
    // Responder ANTES de processar. A Meta espera poucos segundos; se demorarmos (e o
    // Claude demora), ela considera falha e reenvia o mesmo evento — o cliente
    // receberia a resposta repetida.
    res.sendStatus(200);
    processarEvento(req.body).catch((err) =>
      console.error('❌ Erro ao processar evento do webhook:', err.message || err));
  });

  // Para conferirmos de fora se o ouvido esta de pe, sem depender da Meta.
  app.get('/webhook/saude', (req, res) => {
    res.json({
      ok: true,
      configurado: Boolean(TOKEN && PHONE_ID && VERIFY_TOKEN && APP_SECRET),
      faltando: ['WA_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_VERIFY_TOKEN', 'WA_APP_SECRET']
        .filter((v) => !process.env[v]),
    });
  });
}

function iniciarWebhook(porta = PORTA_PADRAO) {
  const faltando = ['WA_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_VERIFY_TOKEN', 'WA_APP_SECRET']
    .filter((v) => !process.env[v]);
  if (faltando.length) {
    console.warn(`⚠️  Webhook da API oficial NAO iniciado — falta no .env: ${faltando.join(', ')}`);
    return null;
  }

  const app = express();
  // Guardamos o corpo bruto para conferir a assinatura da Meta (ver assinaturaValida).
  app.use(express.json({ verify: (req, res, buf) => { req.corpoBruto = buf; } }));
  montarRotas(app);

  return app.listen(porta, '127.0.0.1', () => {
    console.log(`📡 Webhook da API oficial ouvindo em 127.0.0.1:${porta} (o nginx publica em /webhook)`);
  });
}

module.exports = {
  iniciarWebhook, montarRotas, classificarMensagem, processarEvento,
  assinaturaValida, estaPausado, enviarTexto,
};

// Permite subir so o webhook para testar:  node whatsapp-oficial.js
if (require.main === module) iniciarWebhook();
