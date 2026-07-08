/**
 * Chatbot de atendimento do WhatsApp — Mori Izakaya
 *
 * Conexao: Baileys (nao-oficial) no numero PRINCIPAL do restaurante.
 * IA: Claude Haiku 4.5 respondendo com base em restaurante.md.
 * Escopo: so tria e responde duvidas simples; o resto chama a atendente
 *         (aviso no grupo interno) e o bot recua.
 *
 * Uso:
 *   ANTHROPIC_API_KEY=sk-ant-... node bot.js
 *   node bot.js --listar-grupos   (mostra os JIDs dos grupos p/ preencher config)
 */

const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const config = require('./config.json');
const { responder } = require('./cerebro');

// Cardapios (PDFs) enviados quando o cliente pede o menu
const CARDAPIOS = [
  { arquivo: 'cardapio.pdf', nome: 'Cardápio - Mori Izakaya.pdf' },
  { arquivo: 'sushi.pdf',    nome: 'Sushi Menu - Mori Izakaya.pdf' },
  { arquivo: 'drinks.pdf',   nome: 'Drinks - Mori Izakaya.pdf' },
];
const LISTAR_GRUPOS = process.argv.includes('--listar-grupos');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Nao achei sua chave da Anthropic.');
  console.error('   Crie o arquivo .env (copie de .env.exemplo) e cole sua chave nele.');
  console.error('   Depois rode:  npm start');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Estado em memoria (reinicia se o processo cair — ok para o MVP)
// ---------------------------------------------------------------------------

const historico = new Map();      // jid -> [{ role, content }]
const pausados = new Map();       // jid -> timestamp (ms) ate quando o bot fica quieto
const buffers = new Map();        // jid -> { textos: [], timer }
const idsEnviadosPeloBot = new Set(); // ids de msgs que o BOT mandou (p/ anti-atropelo)

function estaPausado(jid) {
  const ate = pausados.get(jid);
  if (!ate) return false;
  if (Date.now() > ate) { pausados.delete(jid); return false; }
  return true;
}

function pausar(jid, horas) {
  pausados.set(jid, Date.now() + horas * 3600 * 1000);
}

// ---------------------------------------------------------------------------
// Chamada ao Claude (via cerebro.js) + gestao do historico por cliente
// ---------------------------------------------------------------------------

async function pensarResposta(jid, textoCliente, nomeCliente) {
  const hist = historico.get(jid) || [];
  const { texto, handoff, cardapio } = await responder(hist, textoCliente, nomeCliente);

  const novoHist = [
    ...hist,
    { role: 'user', content: textoCliente },
    { role: 'assistant', content: texto },
  ];
  historico.set(jid, novoHist.slice(-config.limiteHistorico));

  return { texto, handoff, cardapio };
}

// ---------------------------------------------------------------------------
// Envio + notificacao do grupo interno
// ---------------------------------------------------------------------------

async function enviar(sock, jid, texto) {
  const r = await sock.sendMessage(jid, { text: texto });
  if (r?.key?.id) idsEnviadosPeloBot.add(r.key.id);
}

async function enviarCardapios(sock, jid) {
  for (const c of CARDAPIOS) {
    const caminho = path.join(__dirname, 'cardapios', c.arquivo);
    if (!fs.existsSync(caminho)) {
      console.warn(`⚠️  Cardapio nao encontrado: ${caminho}`);
      continue;
    }
    const r = await sock.sendMessage(jid, {
      document: fs.readFileSync(caminho),
      fileName: c.nome,
      mimetype: 'application/pdf',
    });
    if (r?.key?.id) idsEnviadosPeloBot.add(r.key.id);
  }
}

async function avisarEquipe(sock, jidCliente, nomeCliente, ultimaMsg) {
  if (!config.grupoInternoJid || config.grupoInternoJid.startsWith('PREENCHER')) {
    console.warn('⚠️  grupoInternoJid nao configurado — nao consegui avisar a equipe.');
    return;
  }
  const numero = jidCliente.split('@')[0];
  const aviso =
    `🔔 *Atendimento necessario*\n\n` +
    `👤 Cliente: ${nomeCliente || 'sem nome'} (+${numero})\n` +
    `💬 "${ultimaMsg}"\n\n` +
    `O bot ja avisou o cliente e vai ficar em silencio nesse chat por ` +
    `${config.pausaHumanoHoras}h. Alguem pode assumir. 🙏`;
  await sock.sendMessage(config.grupoInternoJid, { text: aviso });
}

// ---------------------------------------------------------------------------
// Extrair texto de uma mensagem do WhatsApp
// ---------------------------------------------------------------------------

function extrairTexto(msg) {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

// ---------------------------------------------------------------------------
// Processamento com debounce (junta mensagens rapidas em sequencia)
// ---------------------------------------------------------------------------

function agendarProcessamento(sock, jid, nome, texto) {
  const buf = buffers.get(jid) || { textos: [], timer: null };
  buf.textos.push(texto);
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => processar(sock, jid, nome), config.debounceSegundos * 1000);
  buffers.set(jid, buf);
}

async function processar(sock, jid, nome) {
  const buf = buffers.get(jid);
  if (!buf) return;
  buffers.delete(jid);
  const textoCliente = buf.textos.join('\n').trim();
  if (!textoCliente) return;

  if (estaPausado(jid)) return; // humano assumiu enquanto o timer rodava

  try {
    await sock.sendPresenceUpdate('composing', jid); // "digitando..."
    const { texto, handoff, cardapio } = await pensarResposta(jid, textoCliente, nome);
    if (texto) await enviar(sock, jid, texto);
    if (cardapio) {
      await enviarCardapios(sock, jid);
      console.log(`🍣 Cardapios enviados -> ${jid}`);
    }
    if (handoff) {
      await avisarEquipe(sock, jid, nome, textoCliente);
      pausar(jid, config.pausaHumanoHoras);
      console.log(`🔔 Handoff -> ${jid} (pausado ${config.pausaHumanoHoras}h)`);
    }
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    console.error('❌ Erro ao responder:', err.message || err);
  }
}

// ---------------------------------------------------------------------------
// Conexao Baileys
// ---------------------------------------------------------------------------

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Escaneie o QR code abaixo no WhatsApp do restaurante:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp!');
      if (LISTAR_GRUPOS) {
        const grupos = await sock.groupFetchAllParticipating();
        console.log('\n📋 Grupos que esse numero participa (copie o JID do grupo interno):\n');
        for (const g of Object.values(grupos)) {
          console.log(`  ${g.subject}  ->  ${g.id}`);
        }
        console.log('\nColoque o JID em config.json (grupoInternoJid) e rode sem --listar-grupos.\n');
        process.exit(0);
      }
      console.log('🤖 Bot ativo. Aguardando mensagens de clientes...\n');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const deslogado = code === DisconnectReason.loggedOut;
      console.log(`🔌 Conexao caiu (codigo ${code}).`);
      if (deslogado) {
        console.error('❌ Sessao encerrada. Apague a pasta "auth" e escaneie o QR de novo.');
        process.exit(1);
      }
      console.log('🔄 Reconectando em 3s...');
      setTimeout(conectar, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid) continue;

      // ignora status, newsletters e o proprio grupo interno
      if (jid === 'status@broadcast') continue;
      if (jid.endsWith('@newsletter')) continue;
      if (jid === config.grupoInternoJid) continue;

      // ANTI-ATROPELO: mensagem enviada pela nossa conta.
      // Se NAO foi o bot que enviou, foi um humano digitando -> pausa o bot nesse chat.
      if (msg.key.fromMe) {
        if (!idsEnviadosPeloBot.has(msg.key.id)) {
          pausar(jid, config.pausaHumanoHoras);
          console.log(`🙋 Humano assumiu ${jid} — bot em silencio por ${config.pausaHumanoHoras}h.`);
        }
        continue;
      }

      // ignora grupos (o bot so atende conversas 1:1 de clientes)
      if (jid.endsWith('@g.us')) continue;

      if (estaPausado(jid)) continue;

      const texto = extrairTexto(msg);
      const nome = msg.pushName;

      if (!texto) {
        // audio / imagem sem legenda / figurinha -> nao sabemos ler, chama a atendente
        await enviar(sock, jid,
          'Recebi sua mensagem! 😊 Vou chamar alguem da nossa equipe para te ajudar melhor. 🏮');
        await avisarEquipe(sock, jid, nome, '[mensagem de midia/audio]');
        pausar(jid, config.pausaHumanoHoras);
        continue;
      }

      agendarProcessamento(sock, jid, nome, texto);
    }
  });
}

conectar().catch((err) => {
  console.error('❌ Erro fatal:', err.message || err);
  process.exit(1);
});
