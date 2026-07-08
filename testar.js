/**
 * Testa as respostas do bot no TERMINAL, sem WhatsApp e sem risco.
 * Simula um cliente conversando. Digite mensagens e veja o que o bot responde.
 *
 * Uso:
 *   ANTHROPIC_API_KEY=sk-ant-... node testar.js
 *
 * Comandos: "/sair" encerra, "/limpar" zera o historico da conversa.
 */

const readline = require('readline');
const config = require('./config.json');
const { responder } = require('./cerebro');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Nao achei sua chave da Anthropic.');
  console.error('   Crie o arquivo .env (copie de .env.exemplo) e cole sua chave nele.');
  console.error('   Depois rode:  npm run teste');
  process.exit(1);
}

let historico = [];
let nomeCliente = '';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('🍣 Modo de teste — Mori Izakaya');
console.log('   Digite como se fosse um cliente. (/limpar para zerar, /sair para sair)\n');

function perguntar() {
  rl.question('👤 Cliente: ', async (msg) => {
    const texto = msg.trim();
    if (!texto) return perguntar();
    if (texto === '/sair') { rl.close(); return; }
    if (texto === '/limpar') { historico = []; console.log('🧹 Historico zerado.\n'); return perguntar(); }

    try {
      const { texto: resposta, handoff, usage } = await responder(historico, texto, nomeCliente);
      console.log(`\n🤖 Bot: ${resposta}`);
      if (handoff) console.log('   🔔 [handoff: avisaria o grupo interno e pausaria o chat]');
      if (usage) {
        const lidoCache = usage.cache_read_input_tokens || 0;
        console.log(`   💴 tokens: entrada ${usage.input_tokens} (+${lidoCache} cache) / saida ${usage.output_tokens}`);
      }
      console.log('');

      historico.push({ role: 'user', content: texto });
      historico.push({ role: 'assistant', content: resposta });
      historico = historico.slice(-config.limiteHistorico);
    } catch (err) {
      console.error('❌ Erro:', err.message || err, '\n');
    }
    perguntar();
  });
}

rl.question('📝 Nome do cliente (enter para pular): ', (nome) => {
  nomeCliente = nome.trim();
  console.log('');
  perguntar();
});
