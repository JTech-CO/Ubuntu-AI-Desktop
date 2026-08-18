/**
 * js/core/bus.js — application-wide synchronous event bus.
 *
 * ARCHITECTURE §2. Handlers are invoked synchronously in registration order.
 * A throwing handler is caught and logged so one bad listener can never break
 * the emitter or starve the remaining listeners.
 */

/** @type {Map<string, Set<Function>>} */
const registry = new Map();

/** Canonical event names (ARCHITECTURE §2). Exported for discoverability only. */
export const EVENTS = Object.freeze([
  'fs:change',
  'fs:trash',
  'win:open',
  'win:close',
  'win:focus',
  'win:minimize',
  'win:restore',
  'win:maximize',
  'win:unmaximize',
  'proc:spawn',
  'proc:exit',
  'settings:change',
  'net:online',
  'net:offline',
  'ai:request',
  'ai:response',
  'ai:error',
  'session:poweroff',
  'session:restart',
  'session:lock',
]);

function bucket(event) {
  let set = registry.get(event);
  if (!set) {
    set = new Set();
    registry.set(event, set);
  }
  return set;
}

export const bus = {
  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {(payload: any, event: string) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    if (typeof event !== 'string' || event === '') {
      throw new TypeError('bus.on: event must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('bus.on: handler must be a function');
    }
    bucket(event).add(handler);
    return () => bus.off(event, handler);
  },

  /**
   * Subscribe to the next occurrence only.
   * @param {string} event
   * @param {(payload: any, event: string) => void} handler
   * @returns {() => void} unsubscribe
   */
  once(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('bus.once: handler must be a function');
    }
    const wrapper = (payload, name) => {
      bus.off(event, wrapper);
      handler(payload, name);
    };
    wrapper.origin = handler;
    bucket(event).add(wrapper);
    return () => bus.off(event, wrapper);
  },

  /**
   * Remove a handler. Accepts either the original function or the wrapper
   * returned internally by `once`.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const set = registry.get(event);
    if (!set) return;
    if (!set.delete(handler)) {
      for (const fn of set) {
        if (fn.origin === handler) {
          set.delete(fn);
          break;
        }
      }
    }
    if (set.size === 0) registry.delete(event);
  },

  /**
   * Fire an event. Handlers run synchronously over a snapshot of the set, so
   * a handler may safely subscribe or unsubscribe during dispatch.
   * @param {string} event
   * @param {any} [payload]
   */
  emit(event, payload) {
    const set = registry.get(event);
    if (!set || set.size === 0) return;
    const snapshot = Array.from(set);
    for (const fn of snapshot) {
      try {
        fn(payload, event);
      } catch (err) {
        console.error(`[bus] handler for "${event}" threw:`, err);
      }
    }
  },

  /**
   * Number of live handlers for an event (or for every event when omitted).
   * @param {string} [event]
   * @returns {number}
   */
  count(event) {
    if (event === undefined) {
      let total = 0;
      for (const set of registry.values()) total += set.size;
      return total;
    }
    const set = registry.get(event);
    return set ? set.size : 0;
  },

  /** Drop every subscription. Used by tests / hard resets. */
  clear() {
    registry.clear();
  },
};
