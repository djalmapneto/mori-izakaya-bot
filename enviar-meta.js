const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { google } = require('googleapis');
const pino = require('pino');
const config = require('./config.json');

const TIMEZONE = 'America/Sao_Paulo';

function hojeYMD() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function serialParaYMD(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function formatBRL(n) {
  if (n === null || n === undefined || n === '') return '0';
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

async function pegarMetaHoje() {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `'${config.sheetName}'!A:L`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = res.data.values || [];
  const hoje = hojeYMD();

  for (const row of rows) {
    const serial = row[0];
    if (typeof serial !== 'number') continue;
    if (serialParaYMD(serial) === hoje) return row;
  }
  return null;
}

function montarMensagem(row) {
  const dataDisplay = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIMEZONE,
    day: '2-digit', month: '2-digit',
  }).format(new Date());

  const diaSemana = row[1] || '';

  const lojas = [
    { nome: 'Ponta Negra',  emoji: '🏖️',    valor: row[2] },
    { nome: 'Djalma',       emoji: '👨🏻‍💻',  valor: row[3] },
    { nome: 'CN Loja',      emoji: '🌃',    valor: row[4] },
    { nome: 'CN Delivery',  emoji: '🏍️',    valor: row[5] },
    { nome: 'Paraíba',      emoji: '😎',    valor: row[6] },
    { nome: 'Centro',       emoji: '🤩',    valor: row[7] },
    { nome: 'Laranjeiras',  emoji: '🍊',    valor: row[8] },
    { nome: 'Delivery',     emoji: '🛵',    valor: row[9] },
    { nome: 'Distrito',     emoji: '🏭',    valor: row[10] },
  ];
  const total = row[11];

  let msg = `🍣 *Metas de hoje (${dataDisplay}) - ${diaSemana}*\n\n`;
  for (const loja of lojas) {
    msg += `${loja.emoji} ${loja.nome}: R$ ${formatBRL(loja.valor)}\n`;
  }
  msg += `\n💰 *Total:* R$ ${formatBRL(total)}`;
  return msg;
}

async function conectar() {
  let resolved = false;
  let tentativas = 0;
  const MAX = 3;

  return new Promise((resolve, reject) => {
    async function tentar() {
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

      sock.ev.on('connection.update', (update) => {
        if (resolved) return;
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          resolved = true;
          resolve(sock);
        }

        if (connection === 'close') {
          const reason = lastDisconnect?.error?.output?.statusCode;
          tentativas++;
          if (tentativas > MAX) {
            resolved = true;
            reject(new Error(`Falhou ${MAX}x. Último código: ${reason}`));
            return;
          }
          console.log(`🔄 Conexão caiu (código ${reason}). Tentativa ${tentativas}/${MAX}...`);
          setTimeout(tentar, 2000);
        }
      });
    }

    tentar();
  });
}

async function main() {
  console.log('🔍 Lendo a planilha...');
  const row = await pegarMetaHoje();

  if (!row) {
    console.error('❌ Não encontrei a meta de hoje na planilha "meta por dia".');
    console.error('   Confira se há uma linha com a data de hoje.');
    process.exit(1);
  }

  const mensagem = montarMensagem(row);
  console.log('\n📝 Mensagem que será enviada:\n');
  console.log('─'.repeat(60));
  console.log(mensagem);
  console.log('─'.repeat(60));

  console.log('\n🔌 Conectando ao WhatsApp...');
  const sock = await conectar();
  console.log('✅ Conectado!');

  console.log('📤 Enviando mensagem...');
  await sock.sendMessage(config.groupJid, { text: mensagem });
  console.log('✅ Mensagem enviada!');

  await new Promise((r) => setTimeout(r, 5000));

  console.log('🏁 Concluído.');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Erro:', err.message || err);
  process.exit(1);
});

