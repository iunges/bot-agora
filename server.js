'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function loadEnvFile() {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const AGORA_URL = (process.env.AGORA_URL || 'https://api.agora.fslab.dev').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.AGORA_WEBHOOK_SECRET;
const BOT_TOKEN = process.env.AGORA_BOT_TOKEN;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVENTS = 500;
const MAX_FAILURES = 200;
const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), 'data', 'state.json');

if (!WEBHOOK_SECRET) {
  console.error('Configuração ausente: defina AGORA_WEBHOOK_SECRET no arquivo .env.');
  process.exit(1);
}

const events = [];
const failures = [];
const queue = [];
const seen = new Set();
const conversationActivity = new Map();
let processing = false;

function persistState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const state = {
    events,
    failures,
    queue,
    seen: [...seen],
    conversationActivity: [...conversationActivity].map(([id, activity]) => [id, {
      messages: activity.messages,
      participants: [...activity.participants]
    }])
  };
  const temporary = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, STATE_FILE);
}

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(saved.events)) events.push(...saved.events.slice(-MAX_EVENTS));
    if (Array.isArray(saved.failures)) failures.push(...saved.failures.slice(0, MAX_FAILURES));
    if (Array.isArray(saved.queue)) queue.push(...saved.queue);
    if (Array.isArray(saved.seen)) for (const key of saved.seen) seen.add(key);
    if (Array.isArray(saved.conversationActivity)) {
      for (const [id, activity] of saved.conversationActivity) {
        conversationActivity.set(id, {
          messages: Number(activity.messages) || 0,
          participants: new Set(Array.isArray(activity.participants) ? activity.participants : [])
        });
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Não foi possível carregar o estado salvo: ${error.message}`);
      process.exit(1);
    }
  }
}
loadState();

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Corpo acima do limite.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function validSignature(rawBody, supplied) {
  if (typeof supplied !== 'string' || !/^[a-f\d]{64}$/i.test(supplied)) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest();
  const received = Buffer.from(supplied, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(expected, received);
}

function identityFor(envelope, rawBody) {
  const eventName = String(envelope.evento || '');
  const messageId = envelope.dados && envelope.dados.id;
  if (messageId != null && String(messageId)) return `${eventName}:${String(messageId)}`;
  return `${eventName}:sha256:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}

function isBotMessage(data) {
  return data.isBot === true || data.senderType === 'bot' || data.tipo === 'bot' ||
    data.type === 'bot' || data.botId != null || data.agente != null;
}

function updateActivity(envelope) {
  const data = envelope.dados || {};
  const conversationId = envelope.conversationId;
  if (!conversationId) return;
  const current = conversationActivity.get(conversationId) || { messages: 0, participants: new Set() };
  current.messages += 1;
  if (data.senderId != null) current.participants.add(String(data.senderId));
  conversationActivity.set(conversationId, current);
}

function commandReply(envelope) {
  const data = envelope.dados || {};
  if (envelope.evento !== 'message.created' || typeof data.text !== 'string' || isBotMessage(data)) return null;
  const text = data.text.trim();
  if (!text.startsWith('!')) return null;

  const command = text.split(/\s+/, 1)[0].toLocaleLowerCase('pt-BR');
  if (command === '!ajuda') return 'Comandos disponíveis: !ajuda, !eventos e !atividade.';
  if (command === '!eventos') {
    const recent = events.slice(-6).reverse();
    if (!recent.length) return 'Ainda não recebi eventos.';
    const lines = recent.map((event, index) => {
      const message = event.text ? ` — “${event.text.slice(0, 100)}”` : '';
      return `${index + 1}. ${event.evento} (${event.when})${message}`;
    });
    return `Últimos eventos recebidos:\n${lines.join('\n')}`;
  }
  if (command === '!atividade') {
    const activity = conversationActivity.get(envelope.conversationId) || { messages: 0, participants: new Set() };
    return `Nesta conversa, observei ${activity.messages} mensagem(ns) e ${activity.participants.size} participante(s) até agora.`;
  }
  return 'Não reconheci esse comando. Use !ajuda para ver as opções.';
}

function enqueueReply(conversationId, text, eventKey) {
  if (!BOT_TOKEN) {
    console.log(`[modo seco] responderia na conversa ${conversationId}: ${text}`);
    return;
  }
  if (!conversationId) {
    failures.unshift({ eventKey, reason: 'Evento sem conversationId; não foi possível responder.', at: new Date().toISOString() });
    failures.length = Math.min(failures.length, MAX_FAILURES);
    return;
  }
  queue.push({ conversationId, text, eventKey, attempt: 0, queuedAt: new Date().toISOString() });
}

function scheduleQueue(delayMs = 0) {
  if (processing || queue.length === 0) return;
  processing = true;
  setTimeout(processNext, delayMs);
}

async function processNext() {
  const item = queue[0];
  if (!item) {
    processing = false;
    return;
  }
  item.attempt += 1;
  persistState();
  try {
    const response = await fetch(`${AGORA_URL}/bot/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': BOT_TOKEN },
      body: JSON.stringify({ conversationId: item.conversationId, text: item.text }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Ágora respondeu HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    queue.shift();
    persistState();
    console.log(`Resposta enviada para a conversa ${item.conversationId}.`);
  } catch (error) {
    item.lastError = error.message;
    if (item.attempt >= 5) {
      queue.shift();
      failures.unshift({
        eventKey: item.eventKey,
        conversationId: item.conversationId,
        text: item.text,
        attempts: item.attempt,
        reason: item.lastError,
        at: new Date().toISOString()
      });
      failures.length = Math.min(failures.length, MAX_FAILURES);
      persistState();
      console.error(`Entrega esgotada para ${item.eventKey}: ${item.lastError}`);
    } else {
      const backoffMs = Math.min(1000 * (2 ** (item.attempt - 1)), 16000);
      console.error(`Falha na tentativa ${item.attempt}/5 para ${item.eventKey}; nova tentativa em ${backoffMs} ms.`);
      processing = false;
      scheduleQueue(backoffMs);
      return;
    }
  }
  processing = false;
  scheduleQueue();
}

async function handleWebhook(req, res) {
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    if (error.status) return json(res, error.status, { error: error.message });
    return json(res, 400, { error: 'Não foi possível ler o corpo da requisição.' });
  }

  if (!validSignature(rawBody, req.headers['x-agora-signature'])) {
    return json(res, 401, { error: 'Assinatura ausente ou inválida.' });
  }

  let envelope;
  try {
    envelope = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return json(res, 400, { error: 'JSON inválido.' });
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return json(res, 400, { error: 'O corpo deve ser um objeto JSON.' });
  }

  const key = identityFor(envelope, rawBody);
  if (seen.has(key)) return json(res, 200, { ok: true, duplicado: true });
  seen.add(key);

  const data = envelope.dados && typeof envelope.dados === 'object' ? envelope.dados : {};
  const record = {
    key,
    evento: envelope.evento || 'desconhecido',
    conversationId: envelope.conversationId || null,
    messageId: data.id || null,
    senderId: data.senderId || null,
    text: typeof data.text === 'string' ? data.text : null,
    when: envelope.enviadoEm || new Date().toISOString(),
    receivedAt: new Date().toISOString()
  };
  events.push(record);
  if (events.length > MAX_EVENTS) events.shift();
  updateActivity(envelope);

  const reply = commandReply(envelope);
  if (reply) enqueueReply(record.conversationId, reply, key);
  persistState();
  if (reply) scheduleQueue();
  return json(res, 202, { ok: true, recebido: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/saude') {
    return json(res, 200, { ok: true, naFila: queue.length });
  }
  if (req.method === 'GET' && url.pathname === '/eventos') {
    return json(res, 200, { eventos: events, naFila: queue.length });
  }
  if (req.method === 'GET' && url.pathname === '/falhas') {
    return json(res, 200, { falhas: failures });
  }
  if (req.method === 'POST' && url.pathname === '/webhooks/agora') {
    return handleWebhook(req, res);
  }
  return json(res, 404, { error: 'Rota não encontrada.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Receptor Ágora ativo em 0.0.0.0:${PORT}.`);
  if (!BOT_TOKEN) console.log('AGORA_BOT_TOKEN ausente: respostas serão registradas em modo seco.');
  if (queue.length) scheduleQueue();
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
