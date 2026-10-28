# Bot Ágora — receptor de webhooks

Serviço Node.js para receber eventos assinados do Ágora e responder a comandos em uma conversa.

## Endereço público

`https://SEU-NOME.fslab.dev` — substitua pelo subdomínio que você criar em Endereços na cloud do FSLab. O endereço e o acesso à VM ainda precisam ser configurados para este projeto.

## Integrantes

- Lucas (complete com o nome completo e acrescente os demais integrantes, se houver)

## Requisitos e instalação

- Node.js 20 ou superior.
- Copie `.env.example` para `.env` e preencha os valores reais **somente no computador/VM**, nunca no projeto entregue:

```env
PORT=3000
AGORA_URL=https://api.agora.fslab.dev
AGORA_WEBHOOK_SECRET=whsec_...
AGORA_BOT_TOKEN=bot_...
```

O `AGORA_WEBHOOK_SECRET` é obrigatório; o serviço recusa iniciar sem ele. O `AGORA_BOT_TOKEN` é necessário para publicar respostas. Sem o token, o receptor funciona em modo seco.

Inicie com:

```bash
npm start
```

O processo escuta em `0.0.0.0` e a porta padrão é `3000`. Na VM, coloque `.env`, `Dockerfile`, `compose.yaml`, `package.json` e `server.js` na mesma pasta e inicie com `docker compose up -d --build`; a política `unless-stopped` mantém o serviço após reinícios. Crie em `cloud.fslab.dev` o endereço HTTPS apontando para o IP interno da VM e para essa porta. Cadastre no Ágora o webhook do bot como `https://SEU-NOME.fslab.dev/webhooks/agora`.

## Comandos

- `!ajuda` — lista os comandos disponíveis.
- `!eventos` — mostra até seis eventos recentes.
- `!atividade` — conta as mensagens e os participantes observados na conversa atual desde que o serviço iniciou.
- Qualquer outro comando iniciado por `!` recebe uma orientação para usar `!ajuda`.

## Proteção contra laços

O bot só responde a mensagens cujo texto começa com `!`; todas as respostas começam com texto normal, então não reativam os comandos. Eventos marcados pelo Ágora como mensagem de bot/agente também são ignorados, e a chave `evento + dados.id` impede que uma entrega repetida gere outra resposta.

## Conferência

Substitua o domínio de exemplo pelo endereço que você criou:

```bash
curl https://SEU-NOME.fslab.dev/saude
curl https://SEU-NOME.fslab.dev/eventos
curl https://SEU-NOME.fslab.dev/falhas
```

`/eventos` e `/falhas` não exigem autenticação neste projeto de aula; mantenha apenas dados de teste e desligue ou proteja esses endpoints após a correção. Eventos, deduplicação, atividade, fila e falhas ficam salvos em `data/state.json`, montado como volume persistente no Compose, e são restaurados após reinício.

## Evidências

Coloque em `evidencias/` as capturas pedidas na atividade: Integrações com bot/webhook ativo; `/saude` acessado de fora da VM; conversa com os três comandos e respostas; assinatura forjada com resposta 401 e entrega válida duplicada com respostas 202/200; `/eventos` e `/falhas`. Não inclua `.env`, tokens, secrets ou valores confidenciais nas capturas.
