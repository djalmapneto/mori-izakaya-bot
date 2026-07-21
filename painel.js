/**
 * painel.js — a pagina web da equipe para ver e gerir as reservas.
 *
 * Roda dentro do mesmo processo do bot (chamado por bot.js via iniciarPainel),
 * mas tambem roda sozinho para testar no navegador:  node painel.js
 * (precisa da variavel PAINEL_SENHA definida; opcional PAINEL_PORTA, padrao 3000).
 *
 * Protegido por senha (Basic Auth). A equipe abre num link e usa no celular.
 * Usa reservas.js para tudo — aqui so tem tela e rotas.
 */

const express = require('express');
const config = require('./config.json');
const r = require('./reservas');

const PORTA_PADRAO = Number(process.env.PAINEL_PORTA) || 3000;
const SENHA = process.env.PAINEL_SENHA || '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Data de hoje (YYYY-MM-DD) no fuso do restaurante.
function hojeManaus() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Soma/subtrai dias de uma data YYYY-MM-DD (ancorada ao meio-dia UTC).
function addDias(data, n) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "terca-feira, 21/07/2026"
function rotuloData(data) {
  const d = new Date(`${data}T12:00:00Z`);
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.timezone, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(d);
}

function ehDataValida(data) { return /^\d{4}-\d{2}-\d{2}$/.test(data); }

// ---------------------------------------------------------------------------
// Telas (HTML)
// ---------------------------------------------------------------------------

function estilo() {
  return `
  :root{
    --paper:#f6f2ea; --card:#ffffff; --ink:#23201a; --muted:#8a8172;
    --line:#e7dfce; --accent:#b23a2b; --gold:#8c6f33;
    --ok:#2e7d55; --pend:#b26a00; --off:#b0a898;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.45;font-size:16px}
  .wrap{max-width:600px;margin:0 auto;padding:16px 14px 48px}
  h1{font-size:19px;margin:0;letter-spacing:.01em}
  h1 .jp{color:var(--accent)}
  .sub{color:var(--muted);font-size:13px;margin:2px 0 0}
  a{color:var(--accent);text-decoration:none}

  .nav{display:flex;align-items:center;gap:8px;margin:16px 0 8px}
  .nav form{margin:0}
  .nav .dia{flex:1;text-align:center;font-weight:600;text-transform:capitalize}
  .btn{display:inline-block;border:1px solid var(--line);background:var(--card);
    color:var(--ink);border-radius:10px;padding:9px 12px;font-size:15px;cursor:pointer;
    text-align:center;line-height:1}
  .btn:active{transform:translateY(1px)}
  .btn-arrow{min-width:44px;font-size:18px}
  .btn-sm{padding:6px 10px;font-size:13px;border-radius:8px}
  .btn-accent{background:var(--accent);border-color:var(--accent);color:#fff}
  .btn-ghost{background:transparent}
  input[type=date]{border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--card);
    color:var(--ink);font-size:14px}

  .turno{background:var(--card);border:1px solid var(--line);border-radius:14px;
    padding:14px;margin:14px 0}
  .turno-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
  .turno-nome{font-weight:700;font-size:16px}
  .lot{font-size:13px;color:var(--muted)}
  .lot b{color:var(--ink)}
  .bar{height:8px;background:var(--paper);border:1px solid var(--line);border-radius:99px;
    overflow:hidden;margin:8px 0 4px}
  .bar>span{display:block;height:100%;background:var(--gold)}
  .bar.cheio>span{background:var(--accent)}
  .fechado{color:var(--muted);font-size:14px;padding:6px 0}

  ul.res{list-style:none;margin:10px 0 0;padding:0}
  li.r{border-top:1px solid var(--line);padding:10px 0}
  li.r:first-child{border-top:0}
  .r-head{display:flex;align-items:baseline;gap:8px}
  .r-hora{font-weight:700;font-variant-numeric:tabular-nums}
  .r-nome{flex:1;font-weight:600}
  .r-pes{color:var(--muted);font-size:14px;white-space:nowrap}
  .r-info{color:var(--muted);font-size:13px;margin-top:2px}
  .r-info .mesa{color:var(--gold);font-weight:600}
  .cancelada .r-hora,.cancelada .r-nome{text-decoration:line-through;color:var(--off)}

  .badge{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;
    letter-spacing:.04em;padding:2px 7px;border-radius:99px;vertical-align:middle}
  .b-ok{background:#e6f2ea;color:var(--ok)}
  .b-pend{background:#fdf1e0;color:var(--pend)}
  .b-canc{background:#efece6;color:var(--off)}
  .b-origem{background:#f3eee2;color:var(--gold)}

  .acoes{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .acoes form{margin:0;display:flex;gap:6px}
  .acoes input[type=text]{border:1px solid var(--line);border-radius:8px;padding:6px 8px;
    font-size:13px;width:120px}

  details.nova{background:var(--card);border:1px solid var(--line);border-radius:14px;
    padding:0;margin:16px 0}
  details.nova>summary{padding:14px;font-weight:700;cursor:pointer;list-style:none}
  details.nova>summary::-webkit-details-marker{display:none}
  .form-nova{padding:0 14px 14px;display:grid;gap:10px}
  .form-nova label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
  .form-nova input,.form-nova textarea{border:1px solid var(--line);border-radius:10px;
    padding:9px;font-size:15px;color:var(--ink);background:#fff;width:100%;font-family:inherit}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .erro{background:#fdecea;border:1px solid #f4c7c1;color:#a3271b;border-radius:10px;
    padding:10px 12px;font-size:14px;margin:12px 0}
  footer{color:var(--muted);font-size:12px;text-align:center;margin-top:26px}
  `;
}

function turnoTemNoDia(data, turno) {
  return r.regraDaData(data, turno) !== null;
}

function badgeStatus(status) {
  if (status === 'confirmada') return '<span class="badge b-ok">confirmada</span>';
  if (status === 'pendente') return '<span class="badge b-pend">pendente</span>';
  return '<span class="badge b-canc">cancelada</span>';
}

function itemReserva(res, data) {
  const canc = res.status === 'cancelada';
  const origem = res.origem === 'morinho' ? 'Morinho' : 'Equipe';
  const mesas = res.mesas
    ? `<span class="mesa">Mesa(s): ${esc(res.mesas)}</span>`
    : '<span>sem mesa definida</span>';
  const tel = res.telefone ? ` · ${esc(res.telefone)}` : '';
  const obs = res.observacao ? ` · ${esc(res.observacao)}` : '';

  let acoes = '';
  if (!canc) {
    const confirmar = res.status === 'pendente'
      ? `<form method="post" action="/reserva/${res.id}/confirmar?data=${data}">
           <button class="btn btn-sm btn-accent">Confirmar</button></form>`
      : '';
    acoes = `
      <div class="acoes">
        ${confirmar}
        <form method="post" action="/reserva/${res.id}/mesas?data=${data}">
          <input type="text" name="mesas" placeholder="mesa(s)" value="${esc(res.mesas || '')}">
          <button class="btn btn-sm btn-ghost">Salvar mesa</button>
        </form>
        <form method="post" action="/reserva/${res.id}/cancelar?data=${data}"
              onsubmit="return confirm('Cancelar esta reserva?')">
          <button class="btn btn-sm btn-ghost">Cancelar</button>
        </form>
      </div>`;
  }

  return `
    <li class="r ${canc ? 'cancelada' : ''}">
      <div class="r-head">
        <span class="r-hora">${esc(res.horario)}</span>
        <span class="r-nome">${esc(res.nome)}</span>
        <span class="r-pes">${res.pessoas} ${res.pessoas === 1 ? 'pessoa' : 'pessoas'}</span>
      </div>
      <div class="r-info">
        ${badgeStatus(res.status)}
        <span class="badge b-origem">${origem}</span>
        · ${mesas}${tel}${obs}
      </div>
      ${acoes}
    </li>`;
}

function blocoTurno(nome, chave, data, reservas) {
  if (!turnoTemNoDia(data, chave)) {
    return `<section class="turno">
      <div class="turno-top"><span class="turno-nome">${nome}</span></div>
      <p class="fechado">Sem ${nome.toLowerCase()} neste dia.</p>
    </section>`;
  }
  const doTurno = reservas.filter((x) => x.turno === chave);
  const resumo = r.resumoTurno(data, chave);
  const pct = Math.min(100, Math.round((resumo.reservado / resumo.teto) * 100));
  const cheio = resumo.vagas === 0 ? 'cheio' : '';
  const lista = doTurno.length
    ? `<ul class="res">${doTurno.map((x) => itemReserva(x, data)).join('')}</ul>`
    : '<p class="fechado">Nenhuma reserva ainda.</p>';

  return `<section class="turno">
    <div class="turno-top">
      <span class="turno-nome">${nome}</span>
      <span class="lot"><b>${resumo.reservado}</b> / ${resumo.teto} lugares · <b>${resumo.vagas}</b> livres</span>
    </div>
    <div class="bar ${cheio}"><span style="width:${pct}%"></span></div>
    ${lista}
  </section>`;
}

function renderPagina(data, erro) {
  const reservas = r.listarReservas(data);
  const ativas = reservas.filter((x) => x.status !== 'cancelada');
  const canceladas = reservas.filter((x) => x.status === 'cancelada');

  const bannerErro = erro
    ? `<div class="erro">Não consegui salvar: confira nome, número de pessoas e horário.</div>`
    : '';

  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reservas · Mori Izakaya</title>
<style>${estilo()}</style>
</head><body>
<div class="wrap">
  <header>
    <h1><span class="jp">森</span> Reservas · Mori Izakaya</h1>
    <p class="sub">Agenda da equipe</p>
  </header>

  <div class="nav">
    <form method="get" action="/"><input type="hidden" name="data" value="${addDias(data, -1)}">
      <button class="btn btn-arrow" title="Dia anterior">‹</button></form>
    <div class="dia">${rotuloData(data)}</div>
    <form method="get" action="/"><input type="hidden" name="data" value="${addDias(data, 1)}">
      <button class="btn btn-arrow" title="Próximo dia">›</button></form>
  </div>
  <div class="nav">
    <form method="get" action="/"><input type="hidden" name="data" value="${hojeManaus()}">
      <button class="btn btn-sm btn-ghost">Hoje</button></form>
    <form method="get" action="/" style="flex:1;display:flex;gap:8px;justify-content:flex-end">
      <input type="date" name="data" value="${data}">
      <button class="btn btn-sm">Ir</button>
    </form>
  </div>

  ${bannerErro}

  ${blocoTurno('Almoço', 'almoco', data, ativas)}
  ${blocoTurno('Jantar', 'jantar', data, ativas)}

  <details class="nova">
    <summary>+ Nova reserva (telefone / balcão)</summary>
    <form class="form-nova" method="post" action="/reserva?data=${data}">
      <label>Nome
        <input type="text" name="nome" required placeholder="Nome do cliente">
      </label>
      <div class="grid2">
        <label>Data
          <input type="date" name="data" value="${data}" required>
        </label>
        <label>Horário
          <input type="time" name="horario" step="900" required>
        </label>
      </div>
      <div class="grid2">
        <label>Pessoas
          <input type="number" name="pessoas" min="1" max="60" required>
        </label>
        <label>Telefone (opcional)
          <input type="text" name="telefone" placeholder="(92) 9...">
        </label>
      </div>
      <label>Mesa(s) (opcional)
        <input type="text" name="mesas" placeholder="ex.: 3 + 4">
      </label>
      <label>Observação (opcional)
        <input type="text" name="observacao" placeholder="aniversário, cadeirão...">
      </label>
      <button class="btn btn-accent" type="submit">Adicionar reserva</button>
    </form>
  </details>

  ${canceladas.length ? `<details class="nova"><summary>Canceladas do dia (${canceladas.length})</summary>
    <ul class="res" style="padding:0 14px 14px">${canceladas.map((x) => itemReserva(x, data)).join('')}</ul></details>` : ''}

  <footer>Mori Izakaya · uso interno</footer>
</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

function autenticar(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const [tipo, credB64] = cabecalho.split(' ');
  if (tipo === 'Basic' && credB64) {
    const [, senha] = Buffer.from(credB64, 'base64').toString().split(':');
    if (senha === SENHA) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Reservas Mori"');
  return res.status(401).send('Acesso restrito.');
}

function dataDaReq(req) {
  const d = req.query.data;
  return ehDataValida(d) ? d : hojeManaus();
}

function iniciarPainel(porta = PORTA_PADRAO) {
  if (!SENHA) {
    console.warn('⚠️  Painel de reservas NAO iniciado: defina PAINEL_SENHA no .env para ligar a pagina.');
    return null;
  }

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(autenticar);

  app.get('/', (req, res) => {
    res.send(renderPagina(dataDaReq(req), req.query.erro === '1'));
  });

  app.post('/reserva', (req, res) => {
    const { nome, data, horario, pessoas, telefone, mesas, observacao } = req.body;
    const pes = parseInt(pessoas, 10);
    const dataVolta = ehDataValida(data) ? data : hojeManaus();
    if (!nome || !ehDataValida(data) || !/^\d{2}:\d{2}$/.test(horario) || !Number.isInteger(pes) || pes < 1) {
      return res.redirect(`/?data=${dataVolta}&erro=1`);
    }
    r.criarReserva({
      data, horario, pessoas: pes, nome: nome.trim(),
      telefone: (telefone || '').trim(), mesas: (mesas || '').trim(),
      observacao: (observacao || '').trim(), origem: 'equipe',
    });
    res.redirect(`/?data=${dataVolta}`);
  });

  app.post('/reserva/:id/confirmar', (req, res) => {
    r.confirmarReserva(Number(req.params.id));
    res.redirect(`/?data=${dataDaReq(req)}`);
  });
  app.post('/reserva/:id/cancelar', (req, res) => {
    r.cancelarReserva(Number(req.params.id));
    res.redirect(`/?data=${dataDaReq(req)}`);
  });
  app.post('/reserva/:id/mesas', (req, res) => {
    r.definirMesas(Number(req.params.id), (req.body.mesas || '').trim());
    res.redirect(`/?data=${dataDaReq(req)}`);
  });

  const server = app.listen(porta, () => {
    console.log(`📅 Painel de reservas em http://localhost:${porta}`);
  });
  return server;
}

module.exports = { iniciarPainel, renderPagina };

// Permite rodar sozinho para testar:  PAINEL_SENHA=... node painel.js
if (require.main === module) {
  iniciarPainel();
}
