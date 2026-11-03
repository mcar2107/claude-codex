const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const state = require('./state.cjs');

const sleep = (ms) => {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
};

function selfCommand(args) {
  const standalone = typeof Bun !== 'undefined' && Bun.main.startsWith('/$bunfs/');

  return [process.execPath, ...(standalone ? [] : [process.argv[1]]), ...args];
}

function parseOverrides(args) {
  const overrides = {},
    rest = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }

    if (arg === '--model' || arg === '--effort') {
      if (!args[i + 1] || args[i + 1].startsWith('-'))
        throw new Error(`Missing value for ${arg}`);
      overrides[arg === '--model' ? 'model' : 'reasoningEffort'] = args[++i];
    } else if (arg.startsWith('--model=')) {
      if (!arg.slice(8)) throw new Error('Missing value for --model');
      overrides.model = arg.slice(8);
    } else if (arg.startsWith('--effort=')) {
      if (!arg.slice(9)) throw new Error('Missing value for --effort');
      overrides.reasoningEffort = arg.slice(9);
    } else rest.push(arg);
  }

  return { overrides, rest };
}

async function internalRouter(session) {
  const key = process.env.CLAUDE_CODEX_SESSION_KEY;

  if (
    !session ||
    !/^[a-f0-9]{64}$/.test(key || '') ||
    !path.resolve(session).startsWith(state.runtime + path.sep)
  )
    throw new Error('Internal router requires a private session');
  /**
   * Ни учётные данные, ни локальный ключ сессии не печатаются и не попадают в метаданные.
   */
  const { createRouter } = require('./transport/server.ts');
  const app = await createRouter({ key });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const metadata = { pid: process.pid, base, startedAt: new Date().toISOString() };

  state.writeJson(path.join(session, 'health.json'), metadata);
  let stopping = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => {
      return process.exit(1);
    }, 2000);

    force.unref();

    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.resume();
  /**
   * Смерть родителя закрывает pipe — даже после SIGKILL.
   */
  process.stdin.once('end', stop);
  process.stdout.write(JSON.stringify(metadata) + '\n');
}

async function withRouter(overrides, action) {
  state.requireAuth();
  const active = state.activeSettings(overrides);

  state.ensureState();
  const env = { ...process.env, CLAUDE_CODEX_STATE_DIR: state.runtime };

  for (const [key, value] of Object.entries(overrides))
    env[key === 'model' ? 'CLAUDE_GPT_MODEL' : 'CLAUDE_GPT_EFFORT'] = value;
  const key = crypto.randomBytes(32).toString('hex');
  const session = fs.mkdtempSync(path.join(state.runtime, 'session-'));
  const [command, ...args] = selfCommand(['__router', session]);
  let router, exited, failure;
  const controller = new AbortController();

  const abort = () => {
    controller.abort();
    router?.kill('SIGTERM');
  };

  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);

  try {
    router = spawn(command, args, {
      env: { ...env, CLAUDE_CODEX_SESSION_KEY: key },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    exited = new Promise((resolve) => {
      return router.once('exit', resolve);
    });
    router.once('error', (error) => {
      failure = error;
    });
    const metadata = await new Promise((resolve, reject) => {
      let output = '';

      const cleanup = () => {
        clearTimeout(timer);
        router.stdout.removeListener('data', onData);
        router.removeListener('error', onError);
        router.removeListener('exit', onExit);
        controller.signal.removeEventListener('abort', onAbort);
      };

      const finish = (error, value) => {
        cleanup();

        if (error) {
          reject(error);

          return;
        }

        resolve(value);
      };

      const onAbort = () => {
        return finish(new Error('Session cancelled'));
      };

      const onError = (error) => {
        return finish(error);
      };

      const onExit = (code) => {
        return finish(new Error(`CCR exited during startup (${code})`));
      };

      const onData = (chunk) => {
        output += chunk.toString();
        if (output.length > 8192)
          return finish(new Error('Unexpected CCR startup output'));
        if (!output.includes('\n')) return;

        try {
          finish(null, JSON.parse(output.split('\n')[0]));
        } catch {
          finish(new Error('Invalid CCR startup response'));
        }
      };

      const timer = setTimeout(() => {
        return finish(new Error('CCR startup timed out'));
      }, 20000);

      router.stdout.on('data', onData);
      router.once('error', onError);
      router.once('exit', onExit);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });

    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(metadata.base))
      throw new Error('Invalid router address');
    if (controller.signal.aborted) throw new Error('Session cancelled');
    /**
     * Вычитываем pipe, хотя вывода роутера больше не ждём.
     */
    router.stdout.resume();

    const died = () => {
      return controller.abort(new Error('Router exited'));
    };

    router.once('exit', died);

    try {
      return await action({
        base: metadata.base,
        key,
        active,
        env,
        signal: controller.signal,
      });
    } finally {
      router.removeListener('exit', died);
    }
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);

    if (router && router.exitCode === null && router.signalCode === null && !failure) {
      router.kill('SIGTERM');
      await Promise.race([exited, sleep(2200)]);

      if (router.exitCode === null && router.signalCode === null) {
        router.kill('SIGKILL');
        await exited;
      }
    }

    fs.rmSync(session, { recursive: true, force: true });
  }
}

function spawnClient(command, args, { env, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Session cancelled'));
    const child = spawn(command, args, { env, stdio: 'inherit' });

    const terminate = () => {
      return child.kill('SIGTERM');
    };

    const interrupt = () => {
      return child.kill('SIGINT');
    };

    const force = () => {
      terminate();
      killTimer = setTimeout(() => {
        return child.kill('SIGKILL');
      }, 2000);
      killTimer.unref();
    };

    let killTimer;

    signal?.addEventListener('abort', force, { once: true });
    process.once('SIGTERM', terminate);
    process.once('SIGINT', interrupt);

    const cleanup = () => {
      clearTimeout(killTimer);
      process.removeListener('SIGTERM', terminate);
      process.removeListener('SIGINT', interrupt);
      signal?.removeEventListener('abort', force);
    };

    child.once('error', (error) => {
      cleanup();
      reject(
        new Error(
          error.code === 'ENOENT'
            ? 'Claude Code not found in PATH. Install Claude Code separately.'
            : error.message
        )
      );
    });
    child.once('exit', (code, sig) => {
      cleanup();
      /**
       * Код 0 — успех клиента, а не «кода нет»: `||` превратил бы его в код сигнала. null — процесс
       * убит сигналом.
       */
      resolve(code ?? (sig === 'SIGTERM' ? 143 : 130));
    });
  });
}

module.exports = { selfCommand, parseOverrides, internalRouter, withRouter, spawnClient };
