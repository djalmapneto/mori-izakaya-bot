# Mori Izakaya — Bot de atendimento (WhatsApp)

Chatbot que responde dúvidas simples dos clientes no WhatsApp (cardápio, preços,
horário, localização) e **chama a atendente humana** (avisando num grupo interno)
quando o assunto precisa de gente — reservas, Kaitai, Omakasê, reclamações, etc.

- **Conexão:** Baileys (WhatsApp não-oficial), no número principal do restaurante.
- **IA:** Claude Haiku 4.5, respondendo **só** com base em `restaurante.md`.

## 1. Instalar (só na primeira vez)

```bash
npm install
```

## 2. Configurar a chave da IA

1. Pegue sua **chave da API da Anthropic** em https://console.anthropic.com (API Keys).
2. Copie o arquivo `.env.exemplo` para um novo chamado `.env` e cole a chave nele.
   (o `.env` fica só no seu computador, não vai para o Git)
3. Confira/atualize preços e informações em **`restaurante.md`** — o bot só sabe
   o que estiver nesse arquivo.

## 3. Testar no terminal (sem risco, recomendado)

```bash
npm run teste
```

Você conversa como se fosse um cliente e vê as respostas. Digite `/sair` para sair.

## 4. Descobrir o JID do grupo interno

O bot avisa a equipe num grupo de WhatsApp. Para pegar o "endereço" (JID) do grupo:

```bash
npm run grupos
```

Escaneie o QR code com o WhatsApp do restaurante. Ele lista os grupos e seus JIDs.
Copie o JID do grupo interno para o campo `grupoInternoJid` em `config.json`.

## 5. Rodar de verdade (no WhatsApp)

```bash
npm start
```

Na primeira vez, escaneie o QR code (WhatsApp > Aparelhos conectados > Conectar
aparelho). Depois a sessão fica salva na pasta `auth/`.

## Como funciona

- Responde conversas **1:1** de clientes (ignora grupos e status).
- **Anti-atropelo:** quando a atendente responde manualmente pelo mesmo WhatsApp,
  o bot detecta e fica em silêncio naquele chat por algumas horas.
- **Handoff:** quando precisa de humano, avisa o cliente, notifica o grupo interno
  e pausa o bot naquele chat.
- **Debounce:** espera alguns segundos para juntar mensagens quebradas antes de
  responder.

## Ajustes rápidos (`config.json`)

| Campo | O que é |
|---|---|
| `grupoInternoJid` | Grupo que recebe os avisos de atendimento |
| `debounceSegundos` | Tempo de espera antes de responder (junta mensagens) |
| `pausaHumanoHoras` | Quanto tempo o bot fica quieto após um humano assumir |
| `limiteHistorico` | Quantas mensagens de contexto o bot lembra por cliente |

## Observações

- O estado (histórico, pausas) fica **em memória** e reinicia se o processo cair.
  Para o MVP está ok; dá para persistir depois se precisar.
- `restaurante.md` tem um evento com **data fixa** (Cerimônia Kaitai). Lembre de
  atualizar/remover depois que a data passar.
