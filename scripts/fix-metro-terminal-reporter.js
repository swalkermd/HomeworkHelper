/**
 * Expo CLI 0.18.x reaches into many Metro internals under `<package>/src/*`,
 * 0.83+ exposes them only via `<package>/private/*`. Hook Node's resolver (via
 * `node -r`) and rewrite those imports transparently so no packages need to be
 * patched manually.
 */
const path = require('path');
const Module = require('module');

const DEBUG_PATCH = process.env.DEBUG_METRO_PRIVATE_PATCH === '1';
const VIRTUAL_ENV_ALIAS = path.resolve(__dirname, 'expo-virtual-env.js');
const METRO_RUNTIME_DIR = path.dirname(require.resolve('metro-runtime/package.json'));
const METRO_RUNTIME_REQUIRE_ALIAS = path.resolve(METRO_RUNTIME_DIR, 'src/polyfills/require.js');
const METRO_PACKAGES = [
  'metro',
  'metro-cache',
  'metro-cache-key',
  'metro-config',
  'metro-core',
  'metro-file-map',
  'metro-resolver',
  'metro-source-map',
  'metro-symbolicate',
  'metro-transform-plugins',
  'metro-transform-worker',
  'metro-babel-transformer',
  'metro-babel-register',
];

const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
let patchedTerminalCompat = false;

Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
  const rewritten = rewriteMetroRequest(request);
  return originalResolveFilename.call(this, rewritten, parent, isMain, options);
};

Module._load = function patchedLoad(request, parent, isMain) {
  const rewritten = rewriteMetroRequest(request);
  const exports = originalLoad.call(this, rewritten, parent, isMain);
  const normalized = ensureDefaultInterop(rewritten, exports);
  patchMetroTerminalCompat(rewritten, normalized);
  return coerceTailwindVersion(request, normalized);
};

function rewriteMetroRequest(request) {
  if (request === 'expo/virtual/env' || request === 'expo/virtual/env.js') {
    return VIRTUAL_ENV_ALIAS;
  }
  if (request === 'metro-runtime/src/polyfills/require.js.js') {
    return METRO_RUNTIME_REQUIRE_ALIAS;
  }
  if (request === 'metro-runtime/src/polyfills/require.js') {
    return METRO_RUNTIME_REQUIRE_ALIAS;
  }
  if (request === 'metro-runtime/src/polyfills/require') {
    return METRO_RUNTIME_REQUIRE_ALIAS;
  }
  if (
    request.endsWith('.js.js') &&
    (request.startsWith('metro-runtime/src/') || request.includes('metro-runtime\\src\\'))
  ) {
    return request.slice(0, -3);
  }
  for (const pkg of METRO_PACKAGES) {
    const srcPrefix = `${pkg}/src/`;
    if (request === `${pkg}/src` || request === `${pkg}/src/index`) {
      const target = `${pkg}/private/index`;
      logRewrite(request, target);
      return target;
    }
    if (request.startsWith(srcPrefix)) {
      const target = `${pkg}/private/${request.slice(srcPrefix.length)}`;
      logRewrite(request, target);
      return target;
    }
  }
  return request;
}

function logRewrite(from, to) {
  if (DEBUG_PATCH && from !== to) {
    console.log(`[metro-patch] remapped ${from} -> ${to}`);
  }
}

function ensureDefaultInterop(request, exports) {
  if (!exports || typeof exports !== 'object' || exports.default != null) {
    return exports;
  }

  if (METRO_PACKAGES.some((pkg) => request.startsWith(pkg))) {
    Object.defineProperty(exports, 'default', {
      value: exports,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return exports;
}

function coerceTailwindVersion(request, exports) {
  if (
    request === 'tailwindcss/package.json' &&
    exports &&
    typeof exports === 'object'
  ) {
    exports.version = `3.9.99-patched`;
  }
  return exports;
}

function patchMetroTerminalCompat(request, exports) {
  if (patchedTerminalCompat) {
    return;
  }
  if (!request.includes('metro-core')) {
    return;
  }
  const Terminal =
    exports && (exports.Terminal || exports.default || exports);
  if (typeof Terminal !== 'function' || typeof Terminal.prototype?.log !== 'function') {
    return;
  }
  patchedTerminalCompat = true;
  const originalLog = Terminal.prototype.log;

  Object.defineProperty(Terminal.prototype, '_logLines', {
    configurable: true,
    get() {
      if (!Object.prototype.hasOwnProperty.call(this, '__compatLogBuffer')) {
        Object.defineProperty(this, '__compatLogBuffer', {
          configurable: true,
          enumerable: false,
          writable: true,
          value: [],
        });
      }
      return this.__compatLogBuffer;
    },
    set(value) {
      Object.defineProperty(this, '__compatLogBuffer', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: Array.isArray(value) ? value : [],
      });
    },
  });

  if (typeof Terminal.prototype._scheduleUpdate !== 'function') {
    Terminal.prototype._scheduleUpdate = function compatScheduleUpdate() {
      const buffer = this.__compatLogBuffer;
      if (!buffer || buffer.length === 0) {
        return;
      }
      const items = buffer.splice(0);
      for (const line of items) {
        originalLog.call(this, line);
      }
    };
  }
}
