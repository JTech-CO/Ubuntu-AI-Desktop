/**
 * js/services/gemini.js — Google Gemini client (ARCHITECTURE §13).
 *
 * The API key is read from `store.get('apikey')` and nowhere else. There is no
 * key in this repository and there must never be one: on a missing key every
 * entry point throws `new Error('NO_API_KEY')` so callers can offer to open
 * Settings.
 *
 * Every request emits `ai:request` / `ai:response` / `ai:error` on the bus and
 * feeds `metrics.recordRequest`.
 */

import { store } from '../core/store.js';
import { bus } from '../core/bus.js';
import { metrics } from '../core/metrics.js';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';

/** Models offered in Settings -> AI Configuration. */
export const MODELS = Object.freeze([
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'Fast, good default' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', note: 'Highest quality, slower' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', note: 'Cheapest, lowest latency' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', note: 'Previous generation' },
]);

let requestSeq = 0;

function nextRequestId() {
  requestSeq += 1;
  return `ai-${Date.now().toString(36)}-${requestSeq}`;
}

function currentModel() {
  const saved = store.get('model', null);
  if (typeof saved === 'string' && saved.trim() !== '') return saved.trim();
  return DEFAULT_MODEL;
}

function requireKey() {
  const key = store.get('apikey', '');
  if (typeof key !== 'string' || key.trim() === '') throw new Error('NO_API_KEY');
  return key.trim();
}

/**
 * Assemble a generateContent request body.
 * @param {string} prompt
 * @param {{system?:string, temperature?:number, json?:boolean, maxTokens?:number, history?:object[]}} opts
 */
function buildBody(prompt, opts = {}) {
  const contents = [];
  if (Array.isArray(opts.history)) {
    for (const turn of opts.history) {
      if (!turn || typeof turn.text !== 'string') continue;
      contents.push({
        role: turn.role === 'model' || turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.text }],
      });
    }
  }
  contents.push({ role: 'user', parts: [{ text: String(prompt) }] });

  const generationConfig = {};
  if (typeof opts.temperature === 'number') generationConfig.temperature = opts.temperature;
  if (typeof opts.maxTokens === 'number') generationConfig.maxOutputTokens = opts.maxTokens;
  if (opts.json) generationConfig.responseMimeType = 'application/json';

  const body = { contents };
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  if (opts.system) body.systemInstruction = { parts: [{ text: String(opts.system) }] };
  return body;
}

/**
 * Turn a failed fetch Response into the error the contract requires.
 * @param {Response} response
 * @returns {Promise<Error>}
 */
async function httpError(response) {
  let apiMessage = response.statusText || 'Request failed';
  try {
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error && parsed.error.message) apiMessage = parsed.error.message;
        else apiMessage = text.slice(0, 300);
      } catch {
        apiMessage = text.slice(0, 300);
      }
    }
  } catch {
    /* keep statusText */
  }
  return new Error(`HTTP ${response.status}: ${apiMessage}`);
}

/**
 * Pull the text out of a generateContent response payload.
 * @param {any} payload
 * @returns {string}
 */
function extractText(payload) {
  if (!payload || !Array.isArray(payload.candidates) || payload.candidates.length === 0) {
    if (payload && payload.promptFeedback && payload.promptFeedback.blockReason) {
      throw new Error(`Blocked by safety filters: ${payload.promptFeedback.blockReason}`);
    }
    return '';
  }
  let out = '';
  for (const candidate of payload.candidates) {
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (part && typeof part.text === 'string') out += part.text;
    }
    break; // only the first candidate is ever requested
  }
  return out;
}

/** Strip ```json fences (and bare ``` fences) so JSON.parse can run. */
function stripFences(text) {
  let out = String(text).trim();
  const fenced = /^```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(out);
  if (fenced) out = fenced[2].trim();
  else out = out.replace(/^```[A-Za-z0-9_+-]*\s*/, '').replace(/\s*```$/, '').trim();
  // Some models prepend prose; fall back to the outermost {...} or [...] block.
  if (out && out[0] !== '{' && out[0] !== '[') {
    const firstBrace = out.search(/[[{]/);
    if (firstBrace >= 0) {
      const opener = out[firstBrace];
      const closer = opener === '{' ? '}' : ']';
      const lastClose = out.lastIndexOf(closer);
      if (lastClose > firstBrace) out = out.slice(firstBrace, lastClose + 1);
    }
  }
  return out;
}

/**
 * One non-streaming call, with bus events and metrics around it.
 * @param {string} prompt
 * @param {object} opts
 * @returns {Promise<string>}
 */
async function callGenerate(prompt, opts = {}) {
  const key = requireKey();
  const model = currentModel();
  const id = nextRequestId();
  const started = performance.now();

  bus.emit('ai:request', { id, prompt: String(prompt) });

  try {
    const response = await fetch(`${ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(prompt, opts)),
      signal: opts.signal,
    });

    if (!response.ok) throw await httpError(response);

    const payload = await response.json();
    const text = extractText(payload);
    const ms = performance.now() - started;
    metrics.recordRequest(ms, text.length);
    bus.emit('ai:response', { id, ms: Math.round(ms), chars: text.length });
    return text;
  } catch (err) {
    const message = err && err.name === 'AbortError' ? 'Request cancelled' : (err && err.message) || String(err);
    bus.emit('ai:error', { id, message });
    throw err && err.name === 'AbortError' ? err : new Error(message);
  }
}

export const gemini = {
  /** @returns {boolean} */
  hasKey() {
    const key = store.get('apikey', '');
    return typeof key === 'string' && key.trim() !== '';
  },

  /** @returns {string} the stored key, or '' when unset */
  getKey() {
    const key = store.get('apikey', '');
    return typeof key === 'string' ? key.trim() : '';
  },

  /**
   * @param {string} k
   * @returns {boolean} true when a non-empty key was stored
   */
  setKey(k) {
    const value = typeof k === 'string' ? k.trim() : '';
    if (value === '') {
      store.remove('apikey');
      bus.emit('settings:change', { key: 'apikey', value: '' });
      return false;
    }
    store.set('apikey', value);
    bus.emit('settings:change', { key: 'apikey', value: '********' });
    return true;
  },

  clearKey() {
    store.remove('apikey');
    bus.emit('settings:change', { key: 'apikey', value: '' });
  },

  /** Currently selected model id. */
  get model() {
    return currentModel();
  },

  set model(m) {
    gemini.setModel(m);
  },

  /**
   * @param {string} m model id
   * @returns {string} the model now in use
   */
  setModel(m) {
    const value = typeof m === 'string' && m.trim() !== '' ? m.trim() : DEFAULT_MODEL;
    store.set('model', value);
    bus.emit('settings:change', { key: 'model', value });
    return value;
  },

  /**
   * @param {string} prompt
   * @param {{system?:string, temperature?:number, json?:boolean, maxTokens?:number,
   *          history?:object[], signal?:AbortSignal}} [opts]
   * @returns {Promise<string>}
   */
  generate(prompt, opts = {}) {
    return callGenerate(prompt, opts);
  },

  /**
   * Ask for JSON, strip markdown fences, and retry once with a stricter
   * instruction when the first reply does not parse.
   * @param {string} prompt
   * @param {{system?:string, temperature?:number, signal?:AbortSignal}} [opts]
   * @returns {Promise<any>}
   */
  async generateJSON(prompt, opts = {}) {
    const base = {
      ...opts,
      json: true,
      temperature: opts.temperature === undefined ? 0.2 : opts.temperature,
    };

    const first = await callGenerate(prompt, base);
    try {
      return JSON.parse(stripFences(first));
    } catch (parseError) {
      const retryPrompt =
        `${prompt}\n\n` +
        'Your previous reply was not valid JSON. Respond again with a single JSON ' +
        'value and nothing else: no prose, no explanation, no markdown code fences.\n' +
        `Previous reply:\n${first.slice(0, 2000)}`;
      const second = await callGenerate(retryPrompt, { ...base, temperature: 0 });
      try {
        return JSON.parse(stripFences(second));
      } catch {
        throw new Error(`Model did not return valid JSON: ${parseError.message}`);
      }
    }
  },

  /**
   * Stream a completion. Uses `streamGenerateContent?alt=sse` and a
   * ReadableStream reader; on any streaming failure it falls back to a single
   * non-streaming request and delivers the whole text in one chunk.
   *
   * @param {string} prompt
   * @param {(chunk: string, full: string) => void} onChunk
   * @param {{system?:string, temperature?:number, maxTokens?:number,
   *          history?:object[], signal?:AbortSignal}} [opts]
   * @returns {Promise<string>} the complete text
   */
  async stream(prompt, onChunk, opts = {}) {
    const emit = typeof onChunk === 'function' ? onChunk : () => {};
    const key = requireKey();
    const model = currentModel();
    const id = nextRequestId();
    const started = performance.now();

    bus.emit('ai:request', { id, prompt: String(prompt) });

    let full = '';
    try {
      const url =
        `${ENDPOINT_BASE}/${encodeURIComponent(model)}:streamGenerateContent` +
        `?alt=sse&key=${encodeURIComponent(key)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(prompt, opts)),
        signal: opts.signal,
      });

      if (!response.ok) throw await httpError(response);
      if (!response.body || typeof response.body.getReader !== 'function') {
        throw new Error('Streaming not supported by this browser');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Server-sent events: records are separated by a blank line.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const record = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf('\n\n');

          for (const line of record.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '' || data === '[DONE]') continue;
            let payload;
            try {
              payload = JSON.parse(data);
            } catch {
              continue;
            }
            const piece = extractText(payload);
            if (piece) {
              full += piece;
              emit(piece, full);
            }
          }
        }
      }
      buffer += decoder.decode();

      const ms = performance.now() - started;
      metrics.recordRequest(ms, full.length);
      bus.emit('ai:response', { id, ms: Math.round(ms), chars: full.length });
      return full;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        bus.emit('ai:error', { id, message: 'Request cancelled' });
        throw err;
      }
      if (full !== '') {
        // The stream broke partway through — keep what arrived.
        const ms = performance.now() - started;
        metrics.recordRequest(ms, full.length);
        bus.emit('ai:response', { id, ms: Math.round(ms), chars: full.length });
        return full;
      }

      console.warn('[gemini] streaming failed, falling back to a single request:', err && err.message);
      try {
        const text = await callGenerate(prompt, opts);
        if (text) emit(text, text);
        return text;
      } catch (fallbackError) {
        const message = (fallbackError && fallbackError.message) || String(fallbackError);
        bus.emit('ai:error', { id, message });
        throw fallbackError;
      }
    }
  },

  /**
   * Round-trip check for the Settings "Test connection" button.
   * @param {{signal?:AbortSignal}} [opts]
   * @returns {Promise<{ok:boolean, model:string, ms:number, message:string}>}
   */
  async testConnection(opts = {}) {
    const started = performance.now();
    try {
      const reply = await callGenerate('Reply with the single word: OK', {
        temperature: 0,
        maxTokens: 16,
        signal: opts.signal,
      });
      return {
        ok: true,
        model: currentModel(),
        ms: Math.round(performance.now() - started),
        message: reply.trim() || 'OK',
      };
    } catch (err) {
      return {
        ok: false,
        model: currentModel(),
        ms: Math.round(performance.now() - started),
        message: (err && err.message) || String(err),
      };
    }
  },
};
