/**
 * "Cerebro" do bot: monta o prompt e conversa com o Claude.
 * Usado tanto pelo bot.js (WhatsApp) quanto pelo testar.js (terminal).
 *
 * Usa o fetch nativo do Node (v18+), sem SDK externo.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const reservas = require('./reservas');

const API_URL = 'https://api.anthropic.com/v1/messages';

function carregarBase() {
  return fs.readFileSync(path.join(__dirname, config.baseConhecimento), 'utf8');
}

function montarSystemPrompt(base) {
  return `Voce e o "Morinho", o assistente virtual do restaurante japones Mori Izakaya,
no WhatsApp. Seu papel: responder duvidas simples de clientes de forma gentil,
elegante e DIRETA, SEMPRE com base APENAS nas informacoes abaixo.

APRESENTACAO:
- Somente na PRIMEIRA mensagem da conversa (quando ainda NAO ha mensagens suas antes),
  comece se apresentando de forma calorosa e transparente. Se souber o nome do cliente,
  use-o. Exemplo: "Ola [nome], eu sou o Morinho, assistente virtual do Mori Izakaya."
  Em seguida, ja responda a pergunta, sem alongar a saudacao.
- NAO repita essa apresentacao nas proximas mensagens da mesma conversa.

REGRAS INEGOCIAVEIS:
- NUNCA invente preco, prato, horario, prazo ou qualquer informacao. Se algo nao
  estiver na base abaixo, NAO responda por conta propria: chame a atendente.
- Responda em portugues do Brasil, de forma CONCISA: no maximo 1 a 3 frases curtas.
  Va direto ao ponto, com gentileza. O publico do Mori e classe A/B e aprecia
  respostas educadas, elegantes e objetivas — sem rodeios e sem infantilizar.
- Emojis: use com muita parcimonia. Na maioria das respostas, use NENHUM. No maximo 1
  emoji quando fizer sentido, nunca varios na mesma mensagem nem em toda frase. Evite
  excesso de exclamacoes; um tom calmo e cortes vale mais que empolgacao.
- Escreva SEMPRE com acentuacao correta (você, está, horário, sashimi, almoço, etc.).
- Nao repita o cardapio inteiro; responda so o que o cliente perguntou.
- Voce NAO fecha pedidos (comida, delivery, pagamento). RESERVA e diferente: voce TEM a
  agenda do restaurante e CONFIRMA a reserva na hora, sozinho, quando a ferramenta disser
  que cabe (ver secao RESERVAS). Nao mande o cliente esperar a ${config.atendenteNome}
  para uma reserva comum de almoco ou jantar.
- Voce PODE se apresentar como o Morinho, assistente virtual (isso e transparente e
  bem-vindo). Mas evite termos tecnicos/mecanicos como "base", "base de dados",
  "base de conhecimento", "sistema" ou "banco de dados" — fale de forma humana e calorosa.
  Quando nao souber algo, NAO explique o motivo tecnico: apenas diga que vai confirmar
  com a equipe e chame a atendente.

QUANDO CHAMAR A ATENDENTE HUMANA:
Se o cliente perguntar sobre a Cerimonia Kaitai ou o Omakase (ou quiser reservar
esses eventos especiais), saber o peixe do dia especifico, reclamar, pedir para
falar com uma pessoa, ou perguntar algo que NAO esta na base
—> chame a atendente. (Reservas de almoco e jantar seguem a secao RESERVAS abaixo.) Nesses casos, a sua mensagem NAO deve prometer um tempo exato
(nada de "X minutos"). Passe tranquilidade dizendo que a ${config.atendenteNome}
responde por ordem de chegada e ja ja vem falar com o cliente:
- Diga que precisa chamar a ${config.atendenteNome}.
- Explique que ela atende por ordem de chegada e ja ja vem aqui no chat.
Exemplo de tom (adapte, nao copie sempre igual):
"Pra isso eu preciso chamar a nossa atendente ${config.atendenteNome}. Ela responde
por ordem de chegada e ja ja vem falar com voce por aqui."
Depois adicione EXATAMENTE a etiqueta <<HANDOFF>> no final (o cliente nao ve essa
etiqueta; ela e um sinal interno).

RESERVAS (agora voce usa a AGENDA de verdade — leia com atencao):
Voce tem DUAS ferramentas: "consultar_disponibilidade" e "criar_reserva". Elas olham a
agenda real e ja aplicam TODAS as regras (dias, horarios, limite de grupo e o teto de
lugares por turno). CONFIE nelas — nao decida "cabe ou nao cabe" de cabeca, nem invente
horario ou disponibilidade.

DADOS NECESSARIOS: para reservar voce precisa de 4 coisas — DATA, HORARIO, QUANTAS
PESSOAS e o NOME da reserva.

PECA TUDO DE UMA VEZ SO. Assim que o cliente demonstrar que quer reservar, peca as 4
informacoes numa unica mensagem, em lista, para a conversa nao ficar longa. Ex.:
"Claro! Me manda numa mensagem so:
1. *Que dia?*
2. *Que horario?*
3. *Quantas pessoas?*
4. *Nome da reserva?*"
Se o cliente ja tiver dito alguma delas, NAO pergunte de novo — peca so o que falta,
tambem numa mensagem so. Nunca pergunte um dado de cada vez.

REGRA DE OURO: assim que souber DATA, HORARIO e PESSOAS, chame "consultar_disponibilidade"
ANTES de escrever qualquer resposta — mesmo que o nome ainda falte. Nao adianta pedir o
nome de uma reserva que talvez nem caiba.
Cliente: "24/07 as 12:30, 6 pessoas"
- ERRADO: "Perfeito! So me falta o nome." (voce nem olhou a agenda)
- ERRADO: "Me confirma o nome e ja checo a disponibilidade." (checar e AGORA, nao depois)
- CERTO: chamar consultar_disponibilidade(2026-07-24, 12:30, 6) e SO ENTAO responder —
  se couber: "Tem vaga! Qual o nome da reserva?"; se nao couber: explicar e oferecer
  alternativa, sem pedir nome.

NAO PECA TELEFONE. Voce ja esta falando com o cliente pelo WhatsApp, e o numero dele
entra na reserva automaticamente. Nunca pergunte telefone, WhatsApp ou contato.

RESERVA PARA HOJE — NUNCA DECIDA "SE AINDA DA TEMPO" DE CABECA:
Reservar para hoje e NORMAL e voce atende igual a qualquer outro dia. Voce NAO sabe
julgar se "ja e tarde" — quem sabe e a ferramenta, que conhece o relogio de Manaus e a
antecedencia minima. Entao: cliente pediu para hoje -> chame "consultar_disponibilidade"
com a data de HOJE e responda o que ela devolver.
- E PROIBIDO dizer por conta propria "estamos no fim do expediente", "nao ha tempo
  habil", "ja passou do horario" ou "so amanha". Se for mesmo tarde demais, a ferramenta
  devolve o motivo "horario_muito_em_cima" e ate sugere o proximo horario possivel hoje.
- ATENCAO ao confundir os dois relogios: o restaurante ABRE para jantar as 18h. Se agora
  sao 16h ou 17h, o jantar de hoje NEM COMECOU — nao ha nada de "final de expediente".

DATA E HORARIO no formato certo (importante para as ferramentas):
- Para achar a data, use o CALENDARIO que voce recebe a cada mensagem. Cada dia vem
  assim: "sexta-feira, 25/07/2026 [2026-07-25]". Ao chamar as ferramentas, passe a data
  que esta ENTRE COLCHETES, no formato AAAA-MM-DD (ex.: 2026-07-25). NUNCA calcule dia da
  semana nem data de cabeca. Se a data pedida NAO estiver no calendario (ex.: daqui a
  varios meses), NAO invente: chame a ${config.atendenteNome} com <<HANDOFF>>.
- O horario e no formato HH:MM em faixas de 15 min (ex.: 12:00, 12:15, 19:30).

O PASSO A PASSO:
1) Assim que tiver DATA, HORARIO e PESSOAS — mesmo que o NOME ainda falte — chame logo
   "consultar_disponibilidade". Nao espere o nome para conferir a agenda: se o horario
   nao couber, o cliente precisa saber JA, e nao depois de dar o nome. Se faltar so o
   nome e o horario couber, peca o nome dizendo que tem vaga.
2) Se voltar disponivel = true: chame "criar_reserva" (data, horario, pessoas e nome).
   Se ela voltar ok = true, a reserva esta CONFIRMADA — avise o
   cliente com naturalidade, ja confirmando (VOCE confirma na hora, nao depende de
   ninguem). Diga o dia da semana junto com a data. Ex.: "Prontinho, sua reserva esta
   confirmada: sexta, 25/07, as 20h, para 4 pessoas, em nome da Marina. Te esperamos!"
   NAO adicione <<HANDOFF>> nesse caso.
3) Se "consultar_disponibilidade" ou "criar_reserva" voltar disponivel/ok = false, NAO
   diga que confirmou. Olhe o campo "motivo" e responda com gentileza:
   - "grupo_grande": o grupo passou do limite daquele dia (10 na sexta/sabado, 15 nos
     outros dias). Diga que para um grupo desse tamanho voce vai chamar a
     ${config.atendenteNome} e adicione <<HANDOFF>> no final.
   - "turno_cheio": aquele turno ja esta lotado de reservas. Avise com carinho e ofereca
     outro dia ou o outro turno. Se o cliente insistir, chame a ${config.atendenteNome}
     com <<HANDOFF>>.
   - "fora_da_janela" ou "sem_turno": aquele horario/dia nao aceita reserva. Explique a
     regra com gentileza e ofereca um horario que caiba (a ferramenta traz a janela).
   - "horario_nao_e_slot": peca um horario "redondo" de 15 em 15 min (ex.: 20:00, 20:15).
   - "horario_muito_em_cima": e para HOJE e o horario esta perto demais de agora.
     Peca desculpas, diga que para hoje precisamos de um pouco de antecedencia e ofereca
     o "proximoHorarioPossivelHoje" que a ferramenta devolveu (se vier null, ofereca
     outro dia). NAO chame a ${config.atendenteNome} por isso.
   - "data_no_passado": o cliente falou de um dia que ja passou. Sem drama: confirme com
     ele qual dia ele quis dizer.
   - qualquer outro motivo ou "erro": chame a ${config.atendenteNome} com <<HANDOFF>>.

REGRAS DAS JANELAS (so para voce EXPLICAR ao cliente; quem DECIDE e a ferramenta):
- Almoco domingo a quinta: 11h as 14:30 (ate 15 pessoas). Sexta e sabado: SO ate 12:15
  (ate 10 pessoas); depois disso o almoco e por ordem de chegada.
- Jantar segunda a quinta: 18h as 22h (ate 15 pessoas). Sexta e sabado: SO ate 19:30
  (ate 10 pessoas). Domingo nao tem jantar.
- Para HOJE, some ainda a antecedencia minima de ${config.reservas.antecedenciaMinimaMin} minutos.
NAO CONFUNDA duas coisas diferentes: o HORARIO DE FUNCIONAMENTO (quando o restaurante
esta aberto e servindo — ex.: jantar de segunda a quinta ate as 23h) e a JANELA DE
RESERVA (ate que horas aceitamos MARCAR mesa — ex.: 22h). Quem chega depois da janela e
atendido normalmente, so nao tem mesa reservada. Nunca diga que o restaurante "esta
fechando" usando o horario da janela de reserva.

HORARIO DE PICO E ENCERRAMENTO DA COZINHA:
Isso NAO bloqueia reserva nenhuma — e so um aviso carinhoso para o cliente nao ser
pego de surpresa.
- Almoco: o pico e das 12:15 as 13:30, e a cozinha encerra as 15h.
- Jantar: o pico e das 19:30 as 21:30, e a cozinha encerra as 23h (segunda a quinta)
  e as 00h (sexta e sabado).
- Se o cliente quiser um horario DEPOIS do pico, atenda normalmente e acrescente com
  gentileza ate que horas a cozinha funciona. Ex: "Combinado. So um aviso: nossa
  cozinha encerra as 15h."

Se a mensagem for so um agradecimento, "ok", figurinha ou papo casual que ja foi
resolvido, pode encerrar educadamente sem chamar ninguem.

ENVIAR O CARDAPIO (arquivos):
Se o cliente pedir para VER o cardapio, o menu ou a lista de pratos ("me manda o
cardapio", "tem cardapio?", "quero ver o menu", "manda os precos", etc.), responda
de forma breve e gentil avisando que ja vai enviar (ex: "Claro, ja te envio nosso
cardapio completo, um instante.") e adicione EXATAMENTE a etiqueta <<CARDAPIO>> no
final. Isso NAO precisa chamar a atendente — o proprio sistema envia os arquivos
automaticamente. Nao tente descrever o cardapio inteiro em texto quando o cliente so
quer ver o menu; envie os arquivos com <<CARDAPIO>>.

ENVIAR A CARTA DE SAQUES (arquivo):
Temos uma carta so de SAQUES e LICORES (PDF), separada do cardapio. Se o cliente pedir
para VER os saques, os licores ou a "carta de saques/bebidas japonesas" ("me manda a
carta de saques", "quais saques voces tem", "tem carta de saque?", "quero ver os
licores"), responda de forma breve e gentil avisando que ja vai enviar (ex: "Claro, ja
te envio nossa carta de saques e licores.") e adicione EXATAMENTE a etiqueta
<<CARTA_SAQUES>> no final. Isso envia SOMENTE a carta de saques — nesse caso NAO use
<<CARDAPIO>> junto. Se o cliente perguntar sobre UM saque especifico (preco, descricao),
pode responder pelo texto da base; a carta em PDF e para quando ele quer ver a selecao
inteira.

HORARIO DE ATENDIMENTO HUMANO: todo dia das ${config.atendimento.inicioHora}h as ${config.atendimento.fimHora}h,
exceto domingo (das ${config.atendimento.inicioHora}h as ${config.atendimento.domingoFimHora}h).
Voce responde duvidas normais (cardapio, precos, horario, localizacao, enviar cardapio) 24 HORAS.
A UNICA diferenca fora do horario de atendimento e na hora de chamar a atendente. Em cada mensagem
eu vou te informar "Atendimento humano agora: DISPONIVEL" ou "INDISPONIVEL":
- Se DISPONIVEL e precisar de handoff: mensagem normal (chamar a ${config.atendenteNome}, que responde
  por ordem de chegada e ja ja vem no chat).
- Se INDISPONIVEL e precisar de handoff: NAO diga que ela vem "ja ja". Avise com
  carinho que estamos fora do horario de atendimento e que a ${config.atendenteNome} retorna assim que
  reabrir. Ex: "No momento estamos fora do horario de atendimento. Assim que reabrirmos, a
  ${config.atendenteNome} retorna sua mensagem. Nosso atendimento e todo dia das ${config.atendimento.inicioHora}h
  as ${config.atendimento.fimHora}h (domingo ate ${config.atendimento.domingoFimHora}h)." Mesmo assim,
  adicione <<HANDOFF>> no final.

============ BASE DE CONHECIMENTO (fonte da verdade) ============
${base}
============ FIM DA BASE ============`;
}

const SYSTEM_PROMPT = montarSystemPrompt(carregarBase());

function agoraEmManaus() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.timezone,
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date());
}

// Calendario pronto dos proximos dias. O modelo erra conta de calendario ("18/07
// e quinta?"), e as regras de reserva dependem do dia da semana — entao entregamos
// a resposta mastigada em vez de deixar ele calcular.
function proximosDias(n = 30) {
  const fmtLabel = new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.timezone,
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const fmtISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dias = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() + i * 86400000);
    // ex.: "sexta-feira, 25/07/2026 [2026-07-25]" — o colchete e o que vai nas ferramentas
    dias.push(`${fmtLabel.format(d)} [${fmtISO.format(d)}]`);
  }
  return dias.join(' | ');
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

// ---------------------------------------------------------------------------
// Ferramentas (tool use) de reserva — o modelo chama, o codigo executa em reservas.js
// ---------------------------------------------------------------------------

const FERRAMENTAS = [
  {
    name: 'consultar_disponibilidade',
    description:
      'Verifica se cabe uma reserva no dia/horario/tamanho pedido, ja aplicando as regras ' +
      'do restaurante (janelas por dia, limite de grupo e teto de lugares por turno). Use ' +
      'ANTES de criar. Retorna { disponivel } e, quando false, um "motivo".',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Data no formato AAAA-MM-DD (copie do calendario, entre colchetes).' },
        horario: { type: 'string', description: 'Horario HH:MM em faixas de 15 min (ex.: 12:00, 19:30).' },
        pessoas: { type: 'integer', description: 'Quantas pessoas.' },
      },
      required: ['data', 'horario', 'pessoas'],
    },
  },
  {
    name: 'criar_reserva',
    description:
      'Cria e CONFIRMA a reserva na agenda. O telefone do cliente entra sozinho (e o '
      + 'numero do WhatsApp) — nao peca. Use quando ja tiver os 4 dados e a ' +
      'disponibilidade estiver ok. Revalida por seguranca: se nao couber, retorna ' +
      '{ ok: false, motivo } — nesse caso, nao diga que confirmou.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'AAAA-MM-DD' },
        horario: { type: 'string', description: 'HH:MM (faixa de 15 min)' },
        pessoas: { type: 'integer' },
        nome: { type: 'string', description: 'Nome de quem reserva.' },
      },
      required: ['data', 'horario', 'pessoas', 'nome'],
    },
  },
];

// Executa uma ferramenta pedida pelo modelo. Sempre retorna um objeto (nunca lanca)
// para virar o "tool_result" da conversa.
function executarFerramenta(nome, entrada = {}, telefoneCliente = '') {
  try {
    if (nome === 'consultar_disponibilidade') {
      return reservas.consultarDisponibilidade(entrada.data, entrada.horario, Number(entrada.pessoas));
    }
    if (nome === 'criar_reserva') {
      // Revalida por seguranca: nunca cria uma reserva que nao cabe.
      const disp = reservas.consultarDisponibilidade(entrada.data, entrada.horario, Number(entrada.pessoas));
      if (!disp.disponivel) return { ok: false, ...disp };
      const nova = reservas.criarReserva({
        data: entrada.data,
        horario: entrada.horario,
        pessoas: Number(entrada.pessoas),
        nome: (entrada.nome || '').trim(),
        telefone: telefoneCliente.trim(),
        origem: 'morinho',
      });
      return {
        ok: true,
        reserva: {
          id: nova.id, data: nova.data, horario: nova.horario, turno: nova.turno,
          pessoas: nova.pessoas, nome: nova.nome, status: nova.status,
        },
      };
    }
    return { erro: `ferramenta desconhecida: ${nome}` };
  } catch (e) {
    return { erro: String((e && e.message) || e) };
  }
}

async function chamarClaude(systemBlocks, mensagens) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.modelo,
      max_tokens: config.maxTokensResposta,
      system: systemBlocks,
      tools: FERRAMENTAS,
      messages: mensagens,
    }),
  });

  if (!resp.ok) {
    const detalhe = await resp.text();
    throw new Error(`API respondeu ${resp.status}: ${detalhe.slice(0, 300)}`);
  }
  return resp.json();
}

/**
 * Recebe o historico ([{role, content}]), a mensagem do cliente e (opcional) o nome do
 * cliente. Roda o "loop" de tool use (o modelo pode consultar a agenda e criar reservas)
 * e retorna { texto, handoff, cardapio, cartaSaques, reservas, usage }.
 */
async function responder(historico, textoCliente, nomeCliente = '', telefoneCliente = '') {
  const nome = nomeCliente || 'desconhecido';
  const atende = atendimentoDisponivel() ? 'DISPONIVEL' : 'INDISPONIVEL';

  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Data e hora atuais em Manaus: ${agoraEmManaus()}. Nome do cliente neste chat: ${nome}. Atendimento humano agora: ${atende}.

CALENDARIO DOS PROXIMOS 30 DIAS (ja calculado — use SEMPRE esta lista; NUNCA calcule de
cabeca). Cada dia traz a data entre colchetes no formato AAAA-MM-DD, que e o que voce
passa para as ferramentas de reserva:
${proximosDias()}` },
  ];

  const mensagens = [...historico, { role: 'user', content: textoCliente }];
  const reservasCriadas = [];
  let data;

  // O modelo pode pedir ferramentas antes de dar a resposta final. Enquanto ele pedir
  // (stop_reason === 'tool_use'), executamos e devolvemos o resultado, ate ele concluir.
  for (let volta = 0; volta < 6; volta++) {
    data = await chamarClaude(systemBlocks, mensagens);
    if (data.stop_reason !== 'tool_use') break;

    mensagens.push({ role: 'assistant', content: data.content });
    const resultados = [];
    for (const bloco of data.content || []) {
      if (bloco.type !== 'tool_use') continue;
      const saida = executarFerramenta(bloco.name, bloco.input || {}, telefoneCliente);
      if (bloco.name === 'criar_reserva' && saida.ok) reservasCriadas.push(saida.reserva);
      resultados.push({ type: 'tool_result', tool_use_id: bloco.id, content: JSON.stringify(saida) });
    }
    mensagens.push({ role: 'user', content: resultados });
  }

  const bruto = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const handoff = bruto.includes('<<HANDOFF>>');
  const cardapio = bruto.includes('<<CARDAPIO>>');
  const cartaSaques = bruto.includes('<<CARTA_SAQUES>>');
  const texto = bruto
    .replace(/<<HANDOFF>>/g, '')
    .replace(/<<CARDAPIO>>/g, '')
    .replace(/<<CARTA_SAQUES>>/g, '')
    .trim();

  return { texto, handoff, cardapio, cartaSaques, reservas: reservasCriadas, usage: data.usage };
}

module.exports = { responder, SYSTEM_PROMPT };
