/**
 * "Cerebro" do bot: monta o prompt e conversa com o Claude.
 * Usado tanto pelo bot.js (WhatsApp) quanto pelo testar.js (terminal).
 *
 * Usa o fetch nativo do Node (v18+), sem SDK externo.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config.json');

const API_URL = 'https://api.anthropic.com/v1/messages';

function carregarBase() {
  return fs.readFileSync(path.join(__dirname, config.baseConhecimento), 'utf8');
}

function montarSystemPrompt(base) {
  return `Voce e o "Morinho", o assistente virtual do restaurante japones Mori Izakaya,
no WhatsApp. Seu papel: responder duvidas simples de clientes de forma acolhedora,
curta e com alguns emojis japoneses (🏮🍣😊), SEMPRE com base APENAS nas informacoes abaixo.

APRESENTACAO:
- Somente na PRIMEIRA mensagem da conversa (quando ainda NAO ha mensagens suas antes),
  comece se apresentando de forma calorosa e transparente. Se souber o nome do cliente,
  use-o. Exemplo: "Ola [nome]! Eu sou o Morinho, assistente virtual aqui do Mori Izakaya 🏮"
  e em seguida responda a pergunta.
- NAO repita essa apresentacao nas proximas mensagens da mesma conversa.

REGRAS INEGOCIAVEIS:
- NUNCA invente preco, prato, horario, prazo ou qualquer informacao. Se algo nao
  estiver na base abaixo, NAO responda por conta propria: chame a atendente.
- Responda em portugues do Brasil, no maximo 2 a 4 frases. Seja direto e simpatico.
- Escreva SEMPRE com acentuacao correta (você, está, horário, sashimi, almoço, etc.).
- Nao repita o cardapio inteiro; responda so o que o cliente perguntou.
- Voce NAO fecha pedidos nem confirma reservas — quem faz isso e a atendente humana.
- Voce PODE se apresentar como o Morinho, assistente virtual (isso e transparente e
  bem-vindo). Mas evite termos tecnicos/mecanicos como "base", "base de dados",
  "base de conhecimento", "sistema" ou "banco de dados" — fale de forma humana e calorosa.
  Quando nao souber algo, NAO explique o motivo tecnico: apenas diga que vai confirmar
  com a equipe e chame a atendente.

QUANDO CHAMAR A ATENDENTE HUMANA:
Se o cliente quiser confirmar/fazer uma reserva (almoco, jantar, Omakase, Kaitai),
perguntar sobre Cerimonia Kaitai ou Omakase, saber o peixe do dia especifico,
reclamar, pedir para falar com uma pessoa, ou perguntar algo que NAO esta na base
—> chame a atendente. Nesses casos, a sua mensagem NAO deve prometer um tempo exato
(nada de "X minutos"). Passe tranquilidade dizendo que a ${config.atendenteNome}
responde por ordem de chegada e ja ja vem falar com o cliente:
- Diga que precisa chamar a ${config.atendenteNome}.
- Explique que ela atende por ordem de chegada e ja ja vem aqui no chat.
Exemplo de tom (adapte, nao copie sempre igual):
"Pra essa duvida eu preciso chamar a nossa atendente ${config.atendenteNome} 😊 Ela
responde as mensagens por ordem de chegada, entao ja ja ela vem aqui contigo! 🏮"
Depois adicione EXATAMENTE a etiqueta <<HANDOFF>> no final (o cliente nao ve essa
etiqueta; ela e um sinal interno).

Se a mensagem for so um agradecimento, "ok", figurinha ou papo casual que ja foi
resolvido, pode encerrar educadamente sem chamar ninguem.

ENVIAR O CARDAPIO (arquivos):
Se o cliente pedir para VER o cardapio, o menu ou a lista de pratos ("me manda o
cardapio", "tem cardapio?", "quero ver o menu", "manda os precos", etc.), responda
de forma breve e simpatica avisando que ja vai enviar (ex: "Claro! 🍣 Ja te mando
nosso cardapio completo, um instante 😊") e adicione EXATAMENTE a etiqueta
<<CARDAPIO>> no final. Isso NAO precisa chamar a atendente — o proprio sistema envia
os arquivos automaticamente. Nao tente descrever o cardapio inteiro em texto quando
o cliente so quer ver o menu; envie os arquivos com <<CARDAPIO>>.

HORARIO DE ATENDIMENTO HUMANO: todo dia das ${config.atendimento.inicioHora}h as ${config.atendimento.fimHora}h,
exceto domingo (das ${config.atendimento.inicioHora}h as ${config.atendimento.domingoFimHora}h).
Voce responde duvidas normais (cardapio, precos, horario, localizacao, enviar cardapio) 24 HORAS.
A UNICA diferenca fora do horario de atendimento e na hora de chamar a atendente. Em cada mensagem
eu vou te informar "Atendimento humano agora: DISPONIVEL" ou "INDISPONIVEL":
- Se DISPONIVEL e precisar de handoff: mensagem normal (chamar a ${config.atendenteNome}, que responde
  por ordem de chegada e ja ja vem no chat).
- Se INDISPONIVEL e precisar de handoff: NAO diga que ela vem "ja ja". Avise com
  carinho que estamos fora do horario de atendimento e que a ${config.atendenteNome} retorna assim que
  reabrir. Ex: "No momento estamos fora do horario de atendimento 🌙. Assim que reabrirmos, a
  ${config.atendenteNome} retorna sua mensagem! Nosso atendimento e todo dia das ${config.atendimento.inicioHora}h
  as ${config.atendimento.fimHora}h (domingo ate ${config.atendimento.domingoFimHora}h) 😊". Mesmo assim,
  adicione <<HANDOFF>> no final.

============ BASE DE CONHECIMENTO (fonte da verdade) ============
${base}
============ FIM DA BASE ============`;
}

const SYSTEM_PROMPT = montarSystemPrompt(carregarBase());

function agoraEmManaus() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.timezone,
    weekday: 'long', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date());
}

// true se o atendimento humano (Jheni/equipe) esta disponivel neste momento
function atendimentoDisponivel(agora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, weekday: 'short', hour: '2-digit', hour12: false,
  }).formatToParts(agora);
  const dia = partes.find((p) => p.type === 'weekday').value; // Sun, Mon, ...
  let hora = parseInt(partes.find((p) => p.type === 'hour').value, 10);
  if (hora === 24) hora = 0; // meia-noite em alguns ambientes
  const fim = dia === 'Sun' ? config.atendimento.domingoFimHora : config.atendimento.fimHora;
  return hora >= config.atendimento.inicioHora && hora < fim;
}

/**
 * Recebe o historico ([{role, content}]), a mensagem do cliente e (opcional) o
 * nome do cliente. Retorna { texto, handoff, usage }.
 */
async function responder(historico, textoCliente, nomeCliente = '') {
  const mensagens = [...historico, { role: 'user', content: textoCliente }];
  const nome = nomeCliente || 'desconhecido';
  const atende = atendimentoDisponivel() ? 'DISPONIVEL' : 'INDISPONIVEL';

  const corpo = {
    model: config.modelo,
    max_tokens: config.maxTokensResposta,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `Data e hora atuais em Manaus: ${agoraEmManaus()}. Nome do cliente neste chat: ${nome}. Atendimento humano agora: ${atende}.` },
    ],
    messages: mensagens,
  };

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(corpo),
  });

  if (!resp.ok) {
    const detalhe = await resp.text();
    throw new Error(`API respondeu ${resp.status}: ${detalhe.slice(0, 300)}`);
  }

  const data = await resp.json();
  const bruto = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const handoff = bruto.includes('<<HANDOFF>>');
  const cardapio = bruto.includes('<<CARDAPIO>>');
  const texto = bruto
    .replace(/<<HANDOFF>>/g, '')
    .replace(/<<CARDAPIO>>/g, '')
    .trim();

  return { texto, handoff, cardapio, usage: data.usage };
}

module.exports = { responder, SYSTEM_PROMPT };
