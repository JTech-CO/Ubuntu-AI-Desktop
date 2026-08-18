/**
 * js/apps/terminal/commands/ai.js — the Gemini-backed commands.
 *
 * Every entry point streams through `gemini` (js/services/gemini.js), passes
 * `ctx.signal` down so Ctrl+C aborts the HTTP request, and turns the
 * `NO_API_KEY` error into a friendly multi-line hint instead of a stack trace.
 *
 * Nothing here ever builds markup: commands return plain strings and the
 * terminal renders them through its safe writers, so a model response can
 * never reach `innerHTML`.
 */

import { fs } from '../../../core/fs.js';
import { env } from '../../../core/env.js';
import {
  DIM, RESET, GREEN, ok, fail, aborted, termCols,
} from './util.js';

/* ------------------------------------------------------------------ *
 * Shared plumbing
 * ------------------------------------------------------------------ */

/** The braille spinner shown while the first chunk is in flight. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** How the terminal answers when no key is configured. */
function noKeyMessage(name) {
  return `${name}: no Gemini API key is configured.

  This command talks to Google Gemini and needs an API key before it can
  answer anything.

  Open Settings > AI Configuration and paste your key there. Running
  \`settings\` from this terminal opens the Settings app.

  Keys are stored in this browser only and are never sent anywhere except
  to the Gemini endpoint.
`;
}

/**
 * Turn any failure from the gemini service into a command result.
 * @param {string} name the command name, for the message prefix
 * @param {unknown} err
 * @returns {{stdout:string, stderr:string, code:number}}
 */
function geminiError(name, err) {
  const message = err && err.message ? String(err.message) : 'request failed';
  if (message === 'NO_API_KEY') return fail(noKeyMessage(name), 1);
  if (err && err.name === 'AbortError') return { stdout: '', stderr: '', code: 130 };
  return fail(`${name}: ${message}\n`, 1);
}

/**
 * Start the waiting spinner. Returns a stop function that erases it; calling
 * stop twice is safe.
 * @param {object} term
 * @param {string} [label]
 * @returns {() => void}
 */
function startSpinner(term, label = 'Thinking') {
  let index = 0;
  let stopped = false;

  const draw = () => {
    if (stopped) return;
    term.write(`\r${DIM}${SPINNER_FRAMES[index % SPINNER_FRAMES.length]} ${label}…${RESET}`);
    index += 1;
  };

  draw();
  const timer = setInterval(draw, 90);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    /* A lone carriage return clears the line the spinner was drawn on. */
    term.write('\r');
  };
}

/**
 * Stream a completion into the terminal, spinning until the first chunk.
 * @param {object} ctx
 * @param {string} prompt
 * @param {{system?:string, label?:string, temperature?:number}} [opts]
 * @returns {Promise<{text:string, result:object}>} result is non-null on failure
 */
async function streamAnswer(ctx, prompt, opts = {}) {
  /* Fail before the spinner is drawn when there is obviously no key. */
  if (ctx.gemini && typeof ctx.gemini.hasKey === 'function' && !ctx.gemini.hasKey()) {
    return { text: '', result: fail(noKeyMessage(ctx.name), 1) };
  }
  const stop = startSpinner(ctx.term, opts.label);
  let text = '';
  try {
    text = await ctx.gemini.stream(
      prompt,
      (chunk) => {
        stop();
        ctx.term.write(chunk);
      },
      { system: opts.system, temperature: opts.temperature, signal: ctx.signal },
    );
  } catch (err) {
    stop();
    return { text: '', result: geminiError(ctx.name, err) };
  } finally {
    stop();
  }

  if (aborted(ctx.signal)) {
    ctx.term.write('\n');
    return { text, result: { stdout: '', stderr: '', code: 130 } };
  }
  if (text !== '' && !text.endsWith('\n')) ctx.term.write('\n');
  if (text === '') ctx.term.write(`${ctx.name}: the model returned an empty response.\n`);
  return { text, result: null };
}

/**
 * Ask for a complete answer without streaming (used where the text has to be
 * post-processed before it is shown).
 * @param {object} ctx
 * @param {string} prompt
 * @param {{system?:string, label?:string, temperature?:number}} [opts]
 * @returns {Promise<{text:string, result:object}>}
 */
async function fetchAnswer(ctx, prompt, opts = {}) {
  if (ctx.gemini && typeof ctx.gemini.hasKey === 'function' && !ctx.gemini.hasKey()) {
    return { text: '', result: fail(noKeyMessage(ctx.name), 1) };
  }
  const stop = startSpinner(ctx.term, opts.label);
  try {
    const text = await ctx.gemini.generate(prompt, {
      system: opts.system,
      temperature: opts.temperature,
      signal: ctx.signal,
    });
    stop();
    return { text: String(text), result: null };
  } catch (err) {
    stop();
    return { text: '', result: geminiError(ctx.name, err) };
  }
}

/** The system instruction shared by the conversational commands. */
function terminalSystem(ctx, extra = '') {
  const cols = termCols(ctx);
  return `You are an assistant embedded in the terminal of an Ubuntu 24.04 LTS desktop.
Answer in plain text that reads well in a ${cols}-column terminal.
Do not use markdown headings, bold markers or tables. Short paragraphs and
"- " bullets only. Prefer concrete shell commands over prose when the question
is about how to do something.${extra ? `\n${extra}` : ''}`;
}

/**
 * Read the operand: a file when given, otherwise stdin.
 * @param {object} ctx
 * @param {string[]} operands
 * @returns {{text:string, label:string, error:object}|null}
 */
function readInput(ctx, operands) {
  if (operands.length === 0) {
    return { text: ctx.stdin || '', label: 'standard input', error: null };
  }
  const parts = [];
  for (const name of operands) {
    if (name === '-') { parts.push(ctx.stdin || ''); continue; }
    const target = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(name, env.home));
    try {
      if (fs.isDir(target)) {
        return { text: '', label: name, error: fail(`${ctx.name}: ${name}: Is a directory\n`, 1) };
      }
      parts.push(fs.readFile(target));
    } catch {
      return { text: '', label: name, error: fail(`${ctx.name}: ${name}: No such file or directory\n`, 1) };
    }
  }
  return { text: parts.join('\n'), label: operands.join(', '), error: null };
}

/** Strip a ```lang fence from a model answer. */
function stripFence(text) {
  const trimmed = String(text).trim();
  const fenced = /^```[A-Za-z0-9+#._-]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

/** Cap a block of context so a huge file cannot blow the request up. */
function clip(text, limit = 12000) {
  const s = String(text);
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n… [truncated, ${s.length - limit} more characters]`;
}

/* ------------------------------------------------------------------ *
 * ai / ask / gemini
 * ------------------------------------------------------------------ */

const MAN_AI = `NAME
       ai - ask Google Gemini a question from the terminal

SYNOPSIS
       ai [OPTION]... PROMPT...
       command | ai PROMPT...

DESCRIPTION
       Sends PROMPT to the configured Gemini model and streams the reply into
       the terminal as it arrives. A braille spinner is shown until the first
       chunk lands.

       When something is piped into ai, that text is attached to the prompt as
       context, so "cat script.sh | ai 'explain this'" works.

       The API key is read from Settings > AI Configuration. Without one every
       command in this module explains how to add a key and exits 1.

OPTIONS
       -s, --system TEXT
              Override the system instruction.

       -t, --temperature N
              Sampling temperature, 0.0 - 2.0.

       --no-stream
              Wait for the whole answer and print it in one go.

ALIASES
       ask, gemini

EXIT STATUS
       0    the model answered
       1    no API key, or the request failed
       130  interrupted with Ctrl+C`;

const aiCommand = {
  name: 'ai',
  aliases: ['ask', 'gemini'],
  synopsis: 'ai [-s SYSTEM] [-t TEMP] [--no-stream] PROMPT...',
  description: 'Ask Google Gemini a question',
  man: MAN_AI,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let system = null;
    let temperature;
    let noStream = false;
    const words = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-s' || a === '--system') { system = argv[++i] || ''; continue; }
      if (a === '-t' || a === '--temperature') { temperature = Number(argv[++i]); continue; }
      if (a === '--no-stream') { noStream = true; continue; }
      if (a === '--help') return ok(`Usage: ai [OPTION]... PROMPT...\nAsk Google Gemini a question.\n`);
      words.push(a);
    }

    const question = words.join(' ').trim();
    const piped = (ctx.stdin || '').trim();

    if (question === '' && piped === '') {
      return fail(`Usage: ${ctx.name} PROMPT...\nAsk Google Gemini a question. Pipe text in to give it context.\n`, 2);
    }

    const prompt = piped === ''
      ? question
      : `${question === '' ? 'Explain the following.' : question}\n\n--- context from the pipeline ---\n${clip(piped)}\n--- end of context ---`;

    const opts = {
      system: system === null ? terminalSystem(ctx) : system,
      temperature: Number.isFinite(temperature) ? temperature : undefined,
    };

    if (noStream) {
      const { text, result } = await fetchAnswer(ctx, prompt, opts);
      if (result) return result;
      return ok(text.endsWith('\n') ? text : `${text}\n`);
    }

    const { result } = await streamAnswer(ctx, prompt, opts);
    if (result) return result;
    return { stdout: '', stderr: '', code: 0 };
  },
};

/* ------------------------------------------------------------------ *
 * explain
 * ------------------------------------------------------------------ */

const explainCommand = {
  name: 'explain',
  aliases: [],
  synopsis: 'explain [COMMAND-OR-TEXT...]',
  description: 'Explain the previous command and its output',
  man: `NAME
       explain - explain a shell command, or the previous one

SYNOPSIS
       explain [COMMAND-OR-TEXT...]
       command | explain

DESCRIPTION
       With arguments, explain describes what the given command line does.

       With no arguments it explains the command you ran immediately before,
       together with the output it produced. Those are read from the shell
       session (session.lastCommand and session.lastOutput in
       js/apps/terminal/shell.js), which the shell fills in after every line,
       so "ls -l" followed by "explain" explains that listing.

       Piped text is explained directly.

EXIT STATUS
       0    the model answered
       1    no API key, no previous command, or the request failed
       130  interrupted with Ctrl+C`,
  async run(ctx) {
    const argument = ctx.argv.join(' ').trim();
    const piped = (ctx.stdin || '').trim();
    const session = ctx.session || {};

    let prompt;
    if (argument !== '') {
      prompt = piped === ''
        ? `Explain what this shell command does on Ubuntu 24.04, including each flag:\n\n${argument}`
        : `Explain the following, in the context of the command "${argument}":\n\n${clip(piped)}`;
    } else if (piped !== '') {
      prompt = `Explain the following terminal output:\n\n${clip(piped)}`;
    } else {
      const last = typeof session.lastCommand === 'string' ? session.lastCommand.trim() : '';
      const history = Array.isArray(session.history) ? session.history : [];
      const previous = last !== '' ? last : String(history[history.length - 1] || '').trim();

      if (previous === '' || /^explain(\s|$)/.test(previous)) {
        return fail(
          'explain: there is no previous command to explain.\n'
          + 'Run a command first, or pass one: explain \'find . -name "*.log" -mtime +7\'\n',
          1,
        );
      }

      const output = typeof session.lastOutput === 'string' ? session.lastOutput.trim() : '';
      prompt = `On Ubuntu 24.04 the user ran this command:\n\n$ ${previous}\n\n`
        + (output === ''
          ? 'It produced no output. Explain what the command does and why it might have printed nothing.'
          : `It produced this output:\n\n${clip(output, 6000)}\n\nExplain what the command does and what the output means.`);
    }

    const { result } = await streamAnswer(ctx, prompt, {
      system: terminalSystem(ctx, 'Be precise about flags and exit codes. Keep the answer under 25 lines.'),
      label: 'Explaining',
    });
    if (result) return result;
    return { stdout: '', stderr: '', code: 0 };
  },
};

/* ------------------------------------------------------------------ *
 * gencode
 * ------------------------------------------------------------------ */

/** Default file extension for a language name. */
const EXTENSIONS = {
  python: 'py', python3: 'py', py: 'py',
  javascript: 'js', js: 'js', node: 'js',
  typescript: 'ts', ts: 'ts',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh',
  c: 'c', 'c++': 'cpp', cpp: 'cpp', cxx: 'cpp',
  rust: 'rs', rs: 'rs',
  go: 'go', golang: 'go',
  java: 'java', kotlin: 'kt', ruby: 'rb', php: 'php',
  html: 'html', css: 'css', sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml',
  perl: 'pl', lua: 'lua', r: 'R', swift: 'swift', dart: 'dart',
};

/** Guess the language from a free-text description. */
function guessLanguage(description) {
  const text = String(description).toLowerCase();
  for (const key of Object.keys(EXTENSIONS)) {
    if (new RegExp(`\\b${key.replace('+', '\\+')}\\b`).test(text)) return key;
  }
  return 'python';
}

const gencodeCommand = {
  name: 'gencode',
  aliases: [],
  synopsis: 'gencode [-l LANG] [-o FILE] DESCRIPTION...',
  description: 'Generate a program from a description',
  man: `NAME
       gencode - generate a program from a plain-English description

SYNOPSIS
       gencode [-l LANGUAGE] [-o FILE] DESCRIPTION...

DESCRIPTION
       Asks Gemini for a complete, runnable program matching DESCRIPTION,
       prints it, and then offers to save it. Answering the prompt with a
       filename writes the file through the virtual filesystem, so it shows up
       in ls, the Files app and the editors immediately.

       Shell scripts are saved with mode 0755 so they can be run straight away.

OPTIONS
       -l, --language LANG
              Target language. Guessed from the description when omitted.

       -o, --output FILE
              Write to FILE without asking.

       -q, --quiet
              Do not print the code, only save it (implies -o).

EXIT STATUS
       0    generated (and saved, if asked for)
       1    no API key, the request failed, or the file could not be written
       130  interrupted with Ctrl+C`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let language = null;
    let output = null;
    let quiet = false;
    const words = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-l' || a === '--language' || a === '--lang') { language = argv[++i] || ''; continue; }
      if (a === '-o' || a === '--output') { output = argv[++i] || ''; continue; }
      if (a === '-q' || a === '--quiet') { quiet = true; continue; }
      if (a === '--help') return ok('Usage: gencode [-l LANG] [-o FILE] DESCRIPTION...\n');
      words.push(a);
    }

    const description = words.join(' ').trim();
    const piped = (ctx.stdin || '').trim();
    if (description === '' && piped === '') {
      return fail('Usage: gencode [-l LANG] [-o FILE] DESCRIPTION...\nGenerate a program from a description.\n', 2);
    }

    const lang = (language || guessLanguage(description)).toLowerCase();
    const extension = EXTENSIONS[lang] || 'txt';

    const prompt = `Write a complete, runnable ${lang} program that does the following:\n\n`
      + `${description}${piped === '' ? '' : `\n\nUse this as input or reference material:\n${clip(piped, 6000)}`}\n\n`
      + 'Return ONLY the source code. No explanation before or after it, and no markdown fences. '
      + 'Include brief comments inside the code where the logic is not obvious.';

    const { text, result } = await fetchAnswer(ctx, prompt, {
      system: 'You are a senior engineer. You reply with source code and nothing else.',
      label: 'Generating',
      temperature: 0.2,
    });
    if (result) return result;

    const code = stripFence(text);
    if (code === '') return fail('gencode: the model returned no code.\n', 1);

    if (!quiet) {
      ctx.term.write(`${code}\n`);
    }

    /* --- save ------------------------------------------------------- */
    let target = output;
    if (target === null && !aborted(ctx.signal)) {
      const suggestion = `generated.${extension}`;
      const answer = await ctx.term.ask(`\nSave to a file? [filename, or Enter for ${suggestion}, n to skip] `);
      const value = String(answer === null || answer === undefined ? '' : answer).trim();
      if (value.toLowerCase() === 'n' || value.toLowerCase() === 'no') return { stdout: '', stderr: '', code: 0 };
      target = value === '' ? suggestion : value;
    }
    if (target === null || target === '') return { stdout: '', stderr: '', code: 0 };
    if (aborted(ctx.signal)) return { stdout: '', stderr: '', code: 130 };

    const dest = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(target, env.home));
    const executable = extension === 'sh' || /^#!/.test(code);
    try {
      fs.writeFile(dest, code.endsWith('\n') ? code : `${code}\n`, { mode: executable ? 0o755 : 0o644 });
    } catch (err) {
      return fail(`gencode: ${target}: ${err && err.message ? err.message : 'cannot write file'}\n`, 1);
    }

    ctx.term.write(`${GREEN}Saved ${ctx.path.contract(dest, env.home)}${RESET}\n`);
    return { stdout: '', stderr: '', code: 0 };
  },
};

/* ------------------------------------------------------------------ *
 * summarize
 * ------------------------------------------------------------------ */

const summarizeCommand = {
  name: 'summarize',
  aliases: ['summarise'],
  synopsis: 'summarize [-b] [-n SENTENCES] [FILE]...',
  description: 'Summarise a file or piped text',
  man: `NAME
       summarize - summarise a file or piped text with Gemini

SYNOPSIS
       summarize [OPTION]... [FILE]...
       command | summarize [OPTION]...

DESCRIPTION
       Reads FILE, or standard input when no file is given, and streams a
       summary into the terminal.

OPTIONS
       -b, --bullets
              Summarise as a bullet list instead of prose.

       -n, --sentences N
              Aim for roughly N sentences (default 5).

EXIT STATUS
       0    summarised
       1    no API key, no input, or the request failed
       130  interrupted with Ctrl+C`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let bullets = false;
    let sentences = 5;
    const operands = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-b' || a === '--bullets') { bullets = true; continue; }
      if (a === '-n' || a === '--sentences') { sentences = Math.max(1, Number(argv[++i]) || 5); continue; }
      if (a === '--help') return ok('Usage: summarize [-b] [-n SENTENCES] [FILE]...\n');
      if (a.startsWith('-') && a !== '-') continue;
      operands.push(a);
    }

    const input = readInput(ctx, operands);
    if (input.error) return input.error;
    if (input.text.trim() === '') {
      return fail('summarize: no input. Give a file name or pipe text in.\n', 1);
    }

    const shape = bullets
      ? `Summarise it as at most ${sentences} "- " bullets.`
      : `Summarise it in about ${sentences} sentences of plain prose.`;

    const prompt = `Summarise the following text taken from ${input.label}.\n${shape}\n\n`
      + `--- begin ---\n${clip(input.text)}\n--- end ---`;

    const { result } = await streamAnswer(ctx, prompt, {
      system: terminalSystem(ctx, 'Never add a preamble such as "Here is a summary".'),
      label: 'Summarising',
      temperature: 0.3,
    });
    if (result) return result;
    return { stdout: '', stderr: '', code: 0 };
  },
};

/* ------------------------------------------------------------------ *
 * translate
 * ------------------------------------------------------------------ */

const translateCommand = {
  name: 'translate',
  aliases: [],
  synopsis: 'translate --to LANG [-f LANG] [FILE]...',
  description: 'Translate a file or piped text',
  man: `NAME
       translate - translate a file or piped text with Gemini

SYNOPSIS
       translate --to LANGUAGE [--from LANGUAGE] [FILE]...
       command | translate --to LANGUAGE

DESCRIPTION
       Reads FILE, or standard input when no file is given, and streams the
       translation into the terminal. The target language is required and may
       be written any way the model understands: "ko", "Korean", "français".

OPTIONS
       -t, --to LANGUAGE
              Target language. Required.

       -f, --from LANGUAGE
              Source language. Detected automatically when omitted.

       -o, --output FILE
              Write the translation to FILE instead of the terminal.

EXIT STATUS
       0    translated
       1    no API key, no input, missing --to, or the request failed
       130  interrupted with Ctrl+C`,
  async run(ctx) {
    const argv = ctx.argv.slice();
    let to = null;
    let from = null;
    let output = null;
    const operands = [];

    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--to' || a === '-t') { to = argv[++i] || ''; continue; }
      if (a.startsWith('--to=')) { to = a.slice(5); continue; }
      if (a === '--from' || a === '-f') { from = argv[++i] || ''; continue; }
      if (a.startsWith('--from=')) { from = a.slice(7); continue; }
      if (a === '-o' || a === '--output') { output = argv[++i] || ''; continue; }
      if (a === '--help') return ok('Usage: translate --to LANGUAGE [--from LANGUAGE] [FILE]...\n');
      if (a.startsWith('-') && a !== '-') continue;
      operands.push(a);
    }

    if (to === null || to.trim() === '') {
      return fail('translate: --to LANGUAGE is required\nUsage: translate --to LANGUAGE [--from LANGUAGE] [FILE]...\n', 2);
    }

    const input = readInput(ctx, operands);
    if (input.error) return input.error;
    if (input.text.trim() === '') {
      return fail('translate: no input. Give a file name or pipe text in.\n', 1);
    }

    const prompt = `Translate the following text ${from ? `from ${from} ` : ''}into ${to}.\n`
      + 'Preserve line breaks, code blocks, command names and file paths exactly as they are.\n'
      + 'Return only the translation.\n\n'
      + `--- begin ---\n${clip(input.text)}\n--- end ---`;

    const system = 'You are a professional translator. You return only the translated text, never a note about it.';

    if (output !== null && output !== '') {
      const { text, result } = await fetchAnswer(ctx, prompt, { system, label: 'Translating', temperature: 0.2 });
      if (result) return result;
      const dest = ctx.path.resolve(ctx.cwd, ctx.path.expandTilde(output, env.home));
      try {
        fs.writeFile(dest, text.endsWith('\n') ? text : `${text}\n`);
      } catch (err) {
        return fail(`translate: ${output}: ${err && err.message ? err.message : 'cannot write file'}\n`, 1);
      }
      return ok(`${GREEN}Saved ${ctx.path.contract(dest, env.home)}${RESET}\n`);
    }

    const { result } = await streamAnswer(ctx, prompt, { system, label: 'Translating', temperature: 0.2 });
    if (result) return result;
    return { stdout: '', stderr: '', code: 0 };
  },
};

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

/** @type {object[]} */
const aiCommands = [
  aiCommand,
  explainCommand,
  gencodeCommand,
  summarizeCommand,
  translateCommand,
];

export { noKeyMessage };
export default aiCommands;
