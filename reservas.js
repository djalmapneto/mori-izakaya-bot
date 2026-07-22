/**
 * reservas.js — a "agenda" de reservas do Mori Izakaya.
 *
 * Guarda as reservas num banco SQLite (um arquivo so: reservas.db) e concentra
 * TODA a regra de disponibilidade num lugar. E usado por:
 *   - painel.js  (a equipe cria/confirma/cancela pela pagina web)
 *   - cerebro.js (o Morinho consulta a disponibilidade e cria a reserva via tool use)
 *
 * As regras (janelas de horario por dia, limites de pessoas, teto por turno e o
 * mapa do salao) ficam em config.json -> bloco "reservas", para poder ajustar sem
 * mexer no codigo.
 *
 * Nao invente disponibilidade: quem decide "cabe ou nao cabe" e a funcao
 * consultarDisponibilidade() aqui, olhando o que ja esta gravado no banco.
 */

const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config.json');

const R = config.reservas;
// Permite apontar para um banco de teste via variavel de ambiente (usado nos testes).
const DB_PATH = process.env.RESERVAS_DB || path.join(__dirname, 'reservas.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // aguenta bot + painel escrevendo ao mesmo tempo

db.exec(`
  CREATE TABLE IF NOT EXISTS reservas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    data       TEXT    NOT NULL,           -- YYYY-MM-DD
    horario    TEXT    NOT NULL,           -- HH:MM
    turno      TEXT    NOT NULL,           -- 'almoco' | 'jantar'
    pessoas    INTEGER NOT NULL,
    nome       TEXT    NOT NULL,
    telefone   TEXT,
    mesas      TEXT,                       -- quais mesas (preenchido pela equipe)
    origem     TEXT    NOT NULL,           -- 'morinho' | 'equipe'
    status     TEXT    NOT NULL,           -- 'pendente' | 'confirmada' | 'cancelada'
    observacao TEXT,
    criado_em  TEXT    NOT NULL            -- ISO
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reservas_data ON reservas (data, turno, status);`);

// ---------------------------------------------------------------------------
// Helpers de data/horario
// ---------------------------------------------------------------------------

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORARIO = /^\d{2}:\d{2}$/;

function paraMinutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// data 'YYYY-MM-DD' -> indice do dia da semana no fuso de Manaus (0=domingo ... 6=sabado).
// Ancoramos ao meio-dia UTC so para nao correr risco de "virar o dia" na conversao.
function diaSemanaIndice(data) {
  const instante = new Date(`${data}T12:00:00Z`);
  const nome = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, weekday: 'short',
  }).format(instante);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[nome];
}

// "Agora" no fuso de Manaus, ja mastigado: { data: 'YYYY-MM-DD', minutos: 1045 }.
// Existe porque a agenda precisa saber que horas sao para nao aceitar reserva de um
// horario que ja passou (ou que esta em cima da hora demais).
function agoraEmManaus(instante = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(instante);
  const v = (t) => p.find((x) => x.type === t).value;
  let hora = Number(v('hour'));
  if (hora === 24) hora = 0; // meia-noite vem como "24" em alguns ambientes
  return { data: `${v('year')}-${v('month')}-${v('day')}`, minutos: hora * 60 + Number(v('minute')) };
}

// Almoco de manha/inicio da tarde; jantar a noite. A fronteira (16h) cai num vao
// sem reserva (entre o fim do almoco 14:30 e o inicio do jantar 18h), entao qualquer
// horario "no meio" e barrado depois pela checagem de janela.
function turnoDoHorario(horario) {
  return paraMinutos(horario) < 16 * 60 ? 'almoco' : 'jantar';
}

// Regra da janela para uma data+turno, ou null se aquele turno nao existe no dia
// (ex.: jantar de domingo). Retorna { inicio, fim, limitePessoas, grupo }.
function regraDaData(data, turno) {
  const janela = R.janelas[turno];
  const grupoNome = janela.dias[String(diaSemanaIndice(data))];
  if (!grupoNome) return null;
  return { ...janela.grupos[grupoNome], grupo: grupoNome };
}

// Lista os horarios (faixas de 15 min) que aceitam reserva numa data+turno.
function slotsDoDia(data, turno) {
  const regra = regraDaData(data, turno);
  if (!regra) return [];
  const slots = [];
  for (let t = paraMinutos(regra.inicio); t <= paraMinutos(regra.fim); t += R.intervaloSlotMin) {
    const h = String(Math.floor(t / 60)).padStart(2, '0');
    const m = String(t % 60).padStart(2, '0');
    slots.push(`${h}:${m}`);
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Consultas ao banco
// ---------------------------------------------------------------------------

const stmtSomaTurno = db.prepare(
  `SELECT COALESCE(SUM(pessoas), 0) AS total
     FROM reservas
    WHERE data = ? AND turno = ? AND status != 'cancelada'`
);
const stmtBuscar = db.prepare(`SELECT * FROM reservas WHERE id = ?`);
const stmtListarData = db.prepare(`SELECT * FROM reservas WHERE data = ? ORDER BY turno, horario, id`);

function somaPessoasTurno(data, turno) {
  return stmtSomaTurno.get(data, turno).total;
}
function buscarReserva(id) {
  return stmtBuscar.get(id);
}
function listarReservas(data) {
  return stmtListarData.all(data);
}
function resumoTurno(data, turno) {
  const reservado = somaPessoasTurno(data, turno);
  return {
    turno,
    reservado,
    teto: R.tetoPorTurno,
    vagas: Math.max(0, R.tetoPorTurno - reservado),
  };
}

// ---------------------------------------------------------------------------
// A pergunta central: cabe esta reserva?
// ---------------------------------------------------------------------------
/**
 * Decide se uma reserva pode ser feita, na ordem: formato -> data nao passou ->
 * turno existe no dia -> dentro da janela -> horario e uma faixa valida -> grupo
 * dentro do limite -> antecedencia minima -> ha vaga no teto do turno.
 * Retorna { disponivel, motivo, ... }.
 *
 * O relogio entra aqui porque o modelo NAO sabe julgar "ainda da tempo?" — ele ja
 * errou isso em producao (recusou um jantar as 17:25 dizendo que era tarde, quando o
 * jantar nem tinha aberto). Quem decide passa a ser esta funcao.
 *
 * motivos possiveis quando disponivel=false:
 *  data_invalida | horario_invalido | pessoas_invalido | data_no_passado | sem_turno |
 *  fora_da_janela | horario_nao_e_slot | grupo_grande | horario_muito_em_cima | turno_cheio
 */
function consultarDisponibilidade(data, horario, pessoas, agora = agoraEmManaus()) {
  if (!RE_DATA.test(data)) return { disponivel: false, motivo: 'data_invalida' };
  if (!RE_HORARIO.test(horario)) return { disponivel: false, motivo: 'horario_invalido' };
  pessoas = Number(pessoas);
  if (!Number.isInteger(pessoas) || pessoas < 1) return { disponivel: false, motivo: 'pessoas_invalido' };
  if (data < agora.data) return { disponivel: false, motivo: 'data_no_passado', hoje: agora.data };

  const turno = turnoDoHorario(horario);
  const regra = regraDaData(data, turno);
  if (!regra) return { disponivel: false, motivo: 'sem_turno', turno };

  const t = paraMinutos(horario);
  if (t < paraMinutos(regra.inicio) || t > paraMinutos(regra.fim)) {
    return { disponivel: false, motivo: 'fora_da_janela', turno, janela: { inicio: regra.inicio, fim: regra.fim } };
  }
  if (t % R.intervaloSlotMin !== 0) {
    return { disponivel: false, motivo: 'horario_nao_e_slot', turno, intervaloMin: R.intervaloSlotMin };
  }
  if (pessoas > regra.limitePessoas) {
    return { disponivel: false, motivo: 'grupo_grande', turno, limitePessoas: regra.limitePessoas };
  }

  // Reserva para HOJE precisa de um respiro para a cozinha e o salao se organizarem.
  if (data === agora.data && t < agora.minutos + R.antecedenciaMinimaMin) {
    const proximo = slotsDoDia(data, turno).find((s) => paraMinutos(s) >= agora.minutos + R.antecedenciaMinimaMin);
    return {
      disponivel: false,
      motivo: 'horario_muito_em_cima',
      turno,
      antecedenciaMinimaMin: R.antecedenciaMinimaMin,
      horaAgora: `${String(Math.floor(agora.minutos / 60)).padStart(2, '0')}:${String(agora.minutos % 60).padStart(2, '0')}`,
      proximoHorarioPossivelHoje: proximo || null,
    };
  }

  const reservado = somaPessoasTurno(data, turno);
  const vagas = R.tetoPorTurno - reservado;
  if (pessoas > vagas) {
    return { disponivel: false, motivo: 'turno_cheio', turno, vagasRestantesNoTurno: Math.max(0, vagas), teto: R.tetoPorTurno };
  }

  return { disponivel: true, turno, vagasRestantesNoTurno: vagas - pessoas, teto: R.tetoPorTurno };
}

// ---------------------------------------------------------------------------
// Escritas
// ---------------------------------------------------------------------------

const stmtInserir = db.prepare(
  `INSERT INTO reservas (data, horario, turno, pessoas, nome, telefone, mesas, origem, status, observacao, criado_em)
   VALUES (@data, @horario, @turno, @pessoas, @nome, @telefone, @mesas, @origem, @status, @observacao, @criado_em)`
);
const stmtStatus = db.prepare(`UPDATE reservas SET status = ? WHERE id = ?`);
const stmtMesas = db.prepare(`UPDATE reservas SET mesas = ? WHERE id = ?`);

/**
 * Grava uma reserva. Por padrao ja entra 'confirmada': o Morinho confirma na hora
 * as reservas que passam nas regras (o cliente sai com a certeza, sem esperar), e a
 * equipe lanca reservas de telefone/balcao ja confirmadas. O campo 'origem' registra
 * quem criou (morinho | equipe) para a equipe auditar. Passe { status: 'pendente' }
 * se algum dia quiser reter uma reserva para revisao manual.
 *
 * NAO valida disponibilidade sozinha: quem chama deve consultar antes
 * (consultarDisponibilidade). A equipe PODE lancar reserva mesmo com o turno cheio
 * (decisao humana) — por isso a checagem fica de fora daqui.
 */
function criarReserva({ data, horario, pessoas, nome, telefone = '', mesas = '', origem = 'morinho', observacao = '', status }) {
  const turno = turnoDoHorario(horario);
  const st = status || 'confirmada';
  const info = stmtInserir.run({
    data,
    horario,
    turno,
    pessoas: Number(pessoas),
    nome,
    telefone,
    mesas,
    origem,
    status: st,
    observacao,
    criado_em: new Date().toISOString(),
  });
  return buscarReserva(info.lastInsertRowid);
}

function confirmarReserva(id) {
  stmtStatus.run('confirmada', id);
  return buscarReserva(id);
}
function cancelarReserva(id) {
  stmtStatus.run('cancelada', id);
  return buscarReserva(id);
}
function definirMesas(id, mesas) {
  stmtMesas.run(mesas, id);
  return buscarReserva(id);
}

module.exports = {
  db,
  consultarDisponibilidade,
  criarReserva,
  listarReservas,
  buscarReserva,
  resumoTurno,
  confirmarReserva,
  cancelarReserva,
  definirMesas,
  slotsDoDia,
  regraDaData,
  turnoDoHorario,
  diaSemanaIndice,
  agoraEmManaus,
};
