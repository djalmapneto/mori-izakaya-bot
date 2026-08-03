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
const { iniciarPainel } = require('./painel');

// Cardapios (PDFs) enviados quando o cliente pede o menu
const CARDAPIOS = [
  { arquivo: 'cardapio.pdf', nome: 'Cardápio - Mori Izakaya.pdf' },
  { arquivo: 'sushi.pdf',    nome: 'Sushi Menu - Mori Izakaya.pdf' },
  { arquivo: 'drinks.pdf',   nome: 'Drinks - Mori Izakaya.pdf' },
];
// Carta de saquês e licores (PDF) — enviada só quando o cliente pede os saquês
const CARTA_SAQUES = { arquivo: 'saques.pdf', nome: 'Carta de Saquês e Licores - Mori Izakaya.pdf' };
const LISTAR_GRUPOS = process.argv.includes('--listar-grupos');

// Carimba data e hora em TUDO que aparece no log. Sem isso e impossivel saber
// quando algo aconteceu — numa investigacao real ficamos sem saber se o bot tinha
// parado hoje de manha ou dias antes. Vale tambem para o ruido do Baileys.
const RELOGIO = new Intl.DateTimeFormat('pt-BR', {
  timeZone: config.timezone, dateStyle: 'short', timeStyle: 'medium',
});
for (const nivel of ['log', 'warn', 'error']) {
  const original = console[nivel].bind(console);
  console[nivel] = (...args) => original(`[${RELOGIO.format(new Date())}]`, ...args);
}

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

function pausar(jid, minutos) {
  pausados.set(jid, Date.now() + minutos * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Chamada ao Claude (via cerebro.js) + gestao do historico por cliente
// ---------------------------------------------------------------------------

async function pensarResposta(jid, textoCliente, nomeCliente) {
  const hist = historico.get(jid) || [];
  // O numero do WhatsApp do cliente ja e o contato da reserva — o Morinho nao precisa pedir.
  const telefoneCliente = jid.split('@')[0];
  const { texto, handoff, cardapio, cartaSaques, reservas } = await responder(hist, textoCliente, nomeCliente, telefoneCliente);

  const novoHist = [
    ...hist,
    { role: 'user', content: textoCliente },
    { role: 'assistant', content: texto },
  ];
  historico.set(jid, novoHist.slice(-config.limiteHistorico));

  return { texto, handoff, cardapio, cartaSaques, reservas };
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

async function enviarCartaSaques(sock, jid) {
  const caminho = path.join(__dirname, 'cardapios', CARTA_SAQUES.arquivo);
  if (!fs.existsSync(caminho)) {
    console.warn(`⚠️  Carta de saques nao encontrada: ${caminho}`);
    return;
  }
  const r = await sock.sendMessage(jid, {
    document: fs.readFileSync(caminho),
    fileName: CARTA_SAQUES.nome,
    mimetype: 'application/pdf',
  });
  if (r?.key?.id) idsEnviadosPeloBot.add(r.key.id);
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
    `${config.pausaHumanoMinutos} minutos. Alguem pode assumir. 🙏`;
  await sock.sendMessage(config.grupoInternoJid, { text: aviso });
}

// "sab. 25/07 20:00" — rotulo curto da reserva para o aviso interno
function rotuloDataHora(reserva) {
  const d = new Date(`${reserva.data}T12:00:00Z`);
  const dia = new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.timezone, weekday: 'short', day: '2-digit', month: '2-digit',
  }).format(d);
  return `${dia} ${reserva.horario}`;
}

// Avisa o grupo interno que o Morinho confirmou uma reserva (para a equipe auditar
// e organizar as mesas no painel). NAO e handoff: o bot nao pausa o chat.
async function avisarReserva(sock, jidCliente, nomeCliente, reserva) {
  if (!config.grupoInternoJid || config.grupoInternoJid.startsWith('PREENCHER')) return;
  const numero = jidCliente.split('@')[0];
  const aviso =
    `📅 *Nova reserva* (o Morinho confirmou)\n\n` +
    `${rotuloDataHora(reserva)} · ${reserva.pessoas} pessoa(s) · turno: ${reserva.turno}\n` +
    `Em nome de: ${reserva.nome}\n` +
    `Cliente: ${nomeCliente || 'sem nome'} (+${numero})\n\n` +
    `Confira e organize as mesas no painel de reservas.`;
  await sock.sendMessage(config.grupoInternoJid, { text: aviso });
}

// ---------------------------------------------------------------------------
// Extrair texto de uma mensagem do WhatsApp
// ---------------------------------------------------------------------------

// Midia de verdade: coisas que o cliente MANDOU e que nao sabemos ler. So essas
// justificam chamar a equipe.
const TIPOS_MIDIA = [
  'audioMessage', 'imageMessage', 'videoMessage', 'documentMessage',
  'ptvMessage', 'contactMessage', 'contactsArrayMessage',
  'locationMessage', 'liveLocationMessage',
];

// Envelopes que ESCONDEM a mensagem real dentro (mensagem temporaria, "ver uma vez",
// documento com legenda). Sem desembrulhar, um texto normal parecia "midia".
function desembrulhar(m, profundidade = 0) {
  if (!m || profundidade > 4) return m;
  const dentro =
    m.ephemeralMessage?.message ||
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.viewOnceMessageV2Extension?.message ||
    m.documentWithCaptionMessage?.message ||
    m.editedMessage?.message?.protocolMessage?.editedMessage;
  return dentro ? desembrulhar(dentro, profundidade + 1) : m;
}

/**
 * Classifica o que chegou: { tipo: 'texto' | 'midia' | 'ignorar', texto, rotulo }.
 *
 * Antes, TUDO que nao tinha texto virava "midia" -> o bot mandava "vou chamar alguem
 * da equipe", avisava o grupo e ficava mudo 40 min. So que caiam nessa peneira reacoes
 * (👍), avisos internos do WhatsApp e mensagens que falharam de descriptografar (os
 * "Bad MAC" do log) — alarme falso que deixava o cliente no vacuo. Agora so e "midia"
 * o que o cliente realmente mandou e nao sabemos ler; o resto e ignorado em silencio.
 */
function classificarMensagem(msg) {
  const m = desembrulhar(msg.message);
  // Sem conteudo = o WhatsApp entregou algo que nao conseguimos descriptografar.
  // Isso NAO e o mesmo que uma reacao: pode ser um cliente de verdade perguntando
  // algo. Ficar calado aqui e o pior dos mundos (ele nao e respondido e ninguem
  // fica sabendo), entao tratamos como 'ilegivel' e chamamos a equipe.
  if (!m) return { tipo: 'ilegivel', rotulo: 'falha ao descriptografar' };

  const texto =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    null;
  if (texto && texto.trim()) return { tipo: 'texto', texto: texto.trim() };

  const tipo = TIPOS_MIDIA.find((t) => m[t]);
  if (tipo) return { tipo: 'midia', rotulo: tipo };

  // reacoes, figurinhas, enquetes, protocolo (apagar/editar), chaves de sessao...
  // Registramos TODAS as chaves, nao so a primeira: "messageContextInfo" costuma
  // vir acompanhando outro tipo, e mostrar so ele escondia o que era de verdade.
  return { tipo: 'ignorar', rotulo: Object.keys(m).join('+') || 'desconhecido' };
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
    const { texto, handoff, cardapio, cartaSaques, reservas } = await pensarResposta(jid, textoCliente, nome);
    if (texto) await enviar(sock, jid, texto);
    if (cardapio) {
      await enviarCardapios(sock, jid);
      console.log(`🍣 Cardapios enviados -> ${jid}`);
    }
    if (cartaSaques) {
      await enviarCartaSaques(sock, jid);
      console.log(`🍶 Carta de saques enviada -> ${jid}`);
    }
    if (reservas && reservas.length) {
      for (const rv of reservas) await avisarReserva(sock, jid, nome, rv);
      console.log(`📅 ${reservas.length} reserva(s) criada(s) -> ${jid}`);
    }
    if (handoff) {
      await avisarEquipe(sock, jid, nome, textoCliente);
      pausar(jid, config.pausaHumanoMinutos);
      console.log(`🔔 Handoff -> ${jid} (pausado ${config.pausaHumanoMinutos}min)`);
    }
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    console.error('❌ Erro ao responder:', err.message || err);
  }
}

// ---------------------------------------------------------------------------
// Conexao Baileys
// ---------------------------------------------------------------------------

// O UNICO socket que vale. Todo evento que chegar de um socket diferente deste e
// de um zumbi (uma conexao antiga que ainda nao morreu) e deve ser ignorado.
let socketAtual = null;
let timerReconexao = null;
// Vira true quando o WhatsApp desloga (401). Trava qualquer tentativa de reconexao,
// porque so uma pessoa com o celular resolve — insistir so gera loop.
let sessaoDeslogada = false;

// Estado da conexao, mostrado no painel para a equipe. Existe porque o bot ja ficou
// mudo tres vezes sem ninguem perceber — quem descobriu foi sempre por acaso.
let estadoConexao = 'iniciando'; // iniciando | conectado | reconectando | deslogado
const statusWhatsApp = () => estadoConexao;

/**
 * REDE 1: reconecta sem deixar erro escapar e SEM empilhar conexoes.
 *
 * Duas coisas moram aqui, e as duas ja causaram incidente:
 *
 * 1) `setTimeout(conectar, 3000)` deixava o erro da reconexao solto — e no Node isso
 *    MATA o processo. Era a causa das ~800 mortes em ~1100 quedas de conexao.
 *
 * 2) Cada reconexao criava um socket novo SEM fechar o anterior. Os antigos seguiam
 *    vivos, com seus listeners, e quando caiam pediam reconexao tambem — os sockets
 *    se multiplicavam. Chegamos a SETE conexoes simultaneas com a mesma credencial,
 *    brigando pelo mesmo estado de criptografia do Signal: dai a enxurrada de
 *    "Bad MAC" / "Failed to decrypt" e o bot mudo, parecendo online. Isso era um
 *    vazamento antigo, mascarado pelas mortes do item 1 (o pm2 reiniciava limpo);
 *    ao parar as mortes, o lixo passou a acumular.
 *
 * Por isso: uma reconexao agendada por vez, e conectar() derruba a anterior.
 */
function reconectar(segundos = 3) {
  if (sessaoDeslogada) return; // sem QR novo, tentar de novo e so barulho
  if (timerReconexao) return; // ja tem uma a caminho — nao empilha outra
  estadoConexao = 'reconectando';
  console.log(`🔄 Reconectando em ${segundos}s...`);
  timerReconexao = setTimeout(() => {
    timerReconexao = null;
    conectar().catch((err) => {
      console.error('❌ Falhou ao reconectar:', err.message || err);
      reconectar(Math.min(segundos * 2, 60));
    });
  }, segundos * 1000);
}

// Encerra um socket de vez: primeiro tira os ouvidos (para o end() nao disparar
// outro ciclo de reconexao), depois desliga. NUNCA usar logout() aqui — logout
// apaga a sessao e exigiria escanear o QR de novo.
function derrubarSocket(sock) {
  if (!sock) return;
  try { sock.ev.removeAllListeners(); } catch {}
  try { sock.end(undefined); } catch {}
}

async function conectar() {
  derrubarSocket(socketAtual); // sem isso, a conexao antiga vira zumbi
  socketAtual = null;

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

  socketAtual = sock; // a partir daqui, ESTE e o socket valido

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (sock !== socketAtual) return; // evento de um socket velho: ignorar
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Escaneie o QR code abaixo no WhatsApp do restaurante:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      estadoConexao = 'conectado';
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

      // Deslogado (401) NAO se resolve tentando de novo: alguem precisa escanear o QR.
      // Aqui morava um `process.exit(1)` — e o pm2, fiel ao seu trabalho, reiniciava.
      // O processo caia, subia, tomava 401 e caia outra vez: chegamos a 52.920 voltas
      // em ~1 dia, sem NUNCA conectar. Agora paramos de tentar e ficamos vivos, para
      // (1) nao martelar o WhatsApp e (2) manter o PAINEL de reservas no ar para a
      // equipe, que nao tem culpa da sessao ter caido.
      if (deslogado) {
        sessaoDeslogada = true;
        estadoConexao = 'deslogado';
        derrubarSocket(sock);
        socketAtual = null;
        console.error('❌ SESSAO DO WHATSAPP ENCERRADA (deslogado).');
        console.error('   O bot NAO vai reconectar sozinho — isso exige uma pessoa:');
        console.error('   apague a pasta "auth" e escaneie o QR code de novo.');
        console.error('   O painel de reservas continua funcionando normalmente.');
        return;
      }
      reconectar();
    }
  });

  // REDE 2: qualquer erro ao tratar uma mensagem (tipicamente um envio que falha
  // logo depois da conexao cair) ficava solto e derrubava o processo INTEIRO.
  // Agora fica preso aqui: registramos e seguimos para a proxima mensagem.
  sock.ev.on('messages.upsert', async (evento) => {
    if (sock !== socketAtual) return; // socket velho nao atende ninguem
    try {
      await tratarMensagens(sock, evento);
    } catch (err) {
      console.error('❌ Erro ao tratar mensagem recebida:', err.message || err);
    }
  });
}

async function tratarMensagens(sock, { messages, type }) {
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
          pausar(jid, config.pausaHumanoMinutos);
          console.log(`🙋 Humano assumiu ${jid} — bot em silencio por ${config.pausaHumanoMinutos}min.`);
        }
        continue;
      }

      // ignora grupos (o bot so atende conversas 1:1 de clientes)
      if (jid.endsWith('@g.us')) continue;

      if (estaPausado(jid)) continue;

      const nome = msg.pushName;
      const { tipo, texto, rotulo } = classificarMensagem(msg);

      if (tipo === 'ignorar') {
        // reacao, figurinha, aviso do WhatsApp, falha de decriptacao... nao e pergunta
        // de cliente: nao respondemos e nao incomodamos a equipe.
        console.log(`🔇 Ignorado (${rotulo}) de ${jid}`);
        continue;
      }

      // Midia (audio/foto/documento) e mensagem ilegivel caem no mesmo tratamento:
      // avisamos o cliente e chamamos a equipe. A pausa de 40min tambem serve de
      // freio — se a criptografia quebrar em serie, o grupo interno nao e inundado.
      if (tipo === 'midia' || tipo === 'ilegivel') {
        await enviar(sock, jid,
          'Recebi sua mensagem. Vou chamar alguem da nossa equipe para te ajudar melhor.');
        await avisarEquipe(sock, jid, nome, `[${rotulo}]`);
        pausar(jid, config.pausaHumanoMinutos);
        console.log(`${tipo === 'midia' ? '🎧 Midia' : '🔐 Ilegivel'} (${rotulo}) -> handoff em ${jid}`);
        continue;
      }

      agendarProcessamento(sock, jid, nome, texto);
    }
}

// So liga o bot de verdade quando este arquivo e EXECUTADO (npm start / pm2).
// Se for apenas importado (testes), nada conecta — da para testar as funcoes puras.
if (require.main === module) {
  // REDE 3: a ultima. Se algum erro ainda escapar de tudo (o Baileys tem erros
  // esporadicos de socket e de criptografia), ANOTAMOS o motivo e seguimos vivos,
  // em vez de morrer calado. Antes o log so mostrava "erros fatais: 0" e o bot
  // sumia sem deixar pista. Se algo aparecer aqui, e o proximo a investigar.
  process.on('unhandledRejection', (motivo) => {
    console.error('⚠️  Promessa rejeitada sem tratamento:', motivo?.message || motivo);
  });
  process.on('uncaughtException', (err) => {
    console.error('⚠️  Excecao nao tratada:', err?.message || err, '\n', err?.stack || '');
  });

  // Sobe o painel de reservas (pagina web da equipe) junto com o bot.
  // So liga se PAINEL_SENHA estiver definido no .env; senao, apenas avisa e segue.
  if (!LISTAR_GRUPOS) iniciarPainel(undefined, statusWhatsApp);

  conectar().catch((err) => {
    console.error('❌ Erro fatal:', err.message || err);
    process.exit(1);
  });
}

module.exports = { classificarMensagem, desembrulhar, tratarMensagens, estaPausado, conectar };
