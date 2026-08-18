/**
 * js/apps/settings/sections-ai.js — the AI Configuration panel.
 *
 * The Gemini API key lives in `store` under `apikey` and nowhere else. There
 * is no key in this repository and none is ever written into the page, so the
 * only copy is the one the user pastes into this panel — which is exactly what
 * the warning card at the top of the page explains.
 */

import { h, svg } from '../../core/dom.js';
import { dialog } from '../../core/dialog.js';
import { metrics } from '../../core/metrics.js';
import { gemini, MODELS } from '../../services/gemini.js';
import { settings } from './state.js';
import { prefPage, prefGroup, actionRow, switchRow, comboRow, buttonRow, infoRow, banner, button } from './widgets.js';

const icon = (paths) => () => svg(paths, { size: 16, strokeWidth: 1.7 });

/** Mask a key for display: first 4 and last 4 characters only. */
function maskKey(key) {
  if (key.length <= 10) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(Math.min(24, key.length - 8))}${key.slice(-4)}`;
}

export const aiSection = {
  id: 'ai',
  title: 'AI Configuration',
  icon: icon(['M12 3l2.2 5.3L20 10l-5.8 1.7L12 17l-2.2-5.3L4 10l5.8-1.7z', 'M18 16.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z']),
  keywords: 'ai gemini api key model token connection security localstorage',
  build() {
    /* --- key entry ------------------------------------------------- */

    const keyInput = h('input.adw-entry.adw-entry--mono', {
      type: 'password',
      value: gemini.getKey(),
      placeholder: 'AIza…',
      'aria-label': 'Gemini API key',
      spellcheck: 'false',
      autocomplete: 'off',
    });

    const revealButton = h('button.adw-entry__reveal', {
      type: 'button',
      title: 'Show the key',
      'aria-label': 'Show the key',
      'aria-pressed': 'false',
      text: '👁',
    });
    revealButton.addEventListener('click', () => {
      const showing = keyInput.type === 'text';
      keyInput.type = showing ? 'password' : 'text';
      revealButton.setAttribute('aria-pressed', showing ? 'false' : 'true');
      revealButton.title = showing ? 'Show the key' : 'Hide the key';
      revealButton.setAttribute('aria-label', revealButton.title);
    });

    const statusValue = h('span.adw-row__value');
    const statusRow = actionRow({
      title: 'Status',
      suffix: statusValue,
      class: 'adw-row--info',
      keywords: 'api key status connected',
    });

    function refreshStatus(message, tone) {
      if (message) {
        statusValue.textContent = message;
        statusValue.dataset.tone = tone || 'neutral';
        return;
      }
      const key = gemini.getKey();
      if (key === '') {
        statusValue.textContent = 'No API key configured';
        statusValue.dataset.tone = 'warning';
      } else {
        statusValue.textContent = `Key set · ${maskKey(key)}`;
        statusValue.dataset.tone = 'success';
      }
    }

    const saveButton = button({
      label: 'Save Key',
      style: 'suggested',
      onClick: () => {
        const value = keyInput.value.trim();
        if (value === '') {
          refreshStatus('Enter a key before saving', 'warning');
          return;
        }
        gemini.setKey(value);
        keyInput.value = gemini.getKey();
        refreshStatus();
      },
    });

    keyInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        saveButton.click();
      }
    });

    const keyRow = actionRow({
      title: 'Gemini API Key',
      subtitle: 'Stored in this browser only — never sent anywhere except Google’s API',
      class: 'adw-row--entry adw-row--key',
      suffix: h('div.adw-key-field', {}, keyInput, revealButton, saveButton),
      keywords: 'api key gemini google',
    });

    /* --- test connection -------------------------------------------- */

    const testResult = h('span.adw-row__value');
    const testButton = button({
      label: 'Test Connection',
      onClick: async () => {
        if (!gemini.hasKey()) {
          testResult.textContent = 'No API key configured';
          testResult.dataset.tone = 'warning';
          return;
        }
        testButton.disabled = true;
        testResult.textContent = 'Contacting the API…';
        testResult.dataset.tone = 'neutral';
        const outcome = await gemini.testConnection();
        testButton.disabled = false;
        if (outcome.ok) {
          testResult.textContent = `Connected to ${outcome.model} in ${outcome.ms} ms`;
          testResult.dataset.tone = 'success';
        } else {
          testResult.textContent = outcome.message;
          testResult.dataset.tone = 'error';
        }
      },
    });

    const testRow = actionRow({
      title: 'Test Connection',
      subtitle: 'Sends one minimal request and reports the round-trip time',
      suffix: h('div.adw-row__stack', {}, testResult, testButton),
      keywords: 'test connection latency ping',
    });

    /* --- usage --------------------------------------------------------- */

    const usage = metrics.totals();

    refreshStatus();

    return prefPage(
      { title: 'AI Configuration' },
      banner({
        style: 'warning',
        icon: '⚠',
        title: 'Your API key is stored in this browser',
        body:
          'The key is saved in this browser’s localStorage (key “uad:apikey”). Anyone who can use ' +
          'this browser profile, or open the developer tools on this page, can read it in plain text.\n' +
          'Never commit an API key to the repository and never embed one in a page published on ' +
          'GitHub Pages — every file served by a static site is public, including your JavaScript.\n' +
          'Use a key restricted to the Generative Language API, and revoke it immediately in Google ' +
          'AI Studio if you suspect it has been exposed.',
      }),
      prefGroup(
        { title: 'Google Gemini' },
        keyRow,
        statusRow,
        testRow,
        buttonRow({
          title: 'Clear Key',
          subtitle: 'Removes the key from this browser’s storage',
          label: 'Clear Key',
          style: 'destructive',
          onClick: async () => {
            const ok = await dialog.confirm({
              title: 'Remove the stored API key?',
              body: 'AI features will stop working until a new key is entered. Nothing is revoked on Google’s side.',
              okLabel: 'Clear Key',
              destructive: true,
            });
            if (!ok) return;
            gemini.clearKey();
            keyInput.value = '';
            keyInput.type = 'password';
            revealButton.setAttribute('aria-pressed', 'false');
            refreshStatus();
            testResult.textContent = '';
            delete testResult.dataset.tone;
          },
          keywords: 'clear remove delete api key',
        }),
        infoRow('Where to get a key', 'aistudio.google.com/app/apikey', { keywords: 'get api key studio' }),
      ),
      prefGroup(
        { title: 'Model' },
        comboRow({
          title: 'Model',
          subtitle: 'Used by the Terminal `ai` command, Code-OSS and the browser search page',
          value: gemini.model,
          options: MODELS.map((model) => ({ value: model.id, label: `${model.label} — ${model.note}` })),
          onChange: (value) => {
            gemini.setModel(value);
            settings.set('ai.model', value);
          },
          keywords: 'model flash pro gemini',
        }),
        switchRow({
          title: 'Stream Responses',
          subtitle: 'Show text as it arrives instead of waiting for the whole reply',
          value: settings.get('ai.streaming') === true,
          onChange: (v) => settings.set('ai.streaming', v),
          keywords: 'stream streaming responses',
        }),
      ),
      prefGroup(
        { title: 'Usage This Session' },
        infoRow('Requests', String(usage.requests), { keywords: 'usage requests' }),
        infoRow('Errors', String(usage.errors), { keywords: 'usage errors' }),
        infoRow('Average Latency', usage.requests > 0 ? `${usage.avgMs} ms` : '—', { keywords: 'usage latency' }),
        infoRow('Characters Received', usage.totalChars.toLocaleString('en-GB'), { keywords: 'usage characters tokens' }),
      ),
    );
  },
};
