// js/love/lua.js
//
// Small helpers for the handful of places where Lua and JavaScript
// behave differently enough that a direct translation would silently
// change the game's behavior. Imported as `lua` by the ported modules.

// Lua's % is a floored modulo: the result takes the sign of the
// divisor, so -1 % 360 is 359. JavaScript's % keeps the sign of the
// dividend (-1 % 360 is -1). Angles and grid wrap-arounds rely on the
// Lua behavior, so every ported `a % b` goes through this.
export function mod(a, b) {
  const r = a % b;
  return (r !== 0 && (r < 0) !== (b < 0)) ? r + b : r;
}

// math.random(), math.random(n), math.random(lo, hi) — same three forms
// as Lua's: a float in [0, 1), an integer in [1, n], an integer in
// [lo, hi].
export function random(lo, hi) {
  const r = Math.random();
  if (lo === undefined) return r;
  if (hi === undefined) return Math.floor(r * lo) + 1;
  return Math.floor(r * (hi - lo + 1)) + lo;
}

// Lua's tostring() for numbers: integers print without a decimal
// point, everything else with up to 14 significant digits.
export function tostring(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    if (v === Infinity) return 'inf';
    if (v === -Infinity) return '-inf';
    if (Number.isNaN(v)) return 'nan';
    return String(Number(v.toPrecision(14)));
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

// string.format — the printf subset the game uses: %d %i %u %f %g %e
// %x %X %o %s %q %c %%, with flags, width and precision.
export function format(fmt, ...args) {
  let argIndex = 0;
  return fmt.replace(/%([-+ #0]*)(\d+)?(?:\.(\d+))?([diufFgGeExXoscq%])/g,
    (match, flags, width, precision, conv) => {
      if (conv === '%') return '%';
      let arg = args[argIndex++];
      let s;
      switch (conv) {
        case 'd': case 'i': case 'u': {
          const n = Math.trunc(Number(arg));
          s = String(Math.abs(n));
          if (precision !== undefined) s = s.padStart(Number(precision), '0');
          if (n < 0) s = '-' + s;
          else if (flags.includes('+')) s = '+' + s;
          else if (flags.includes(' ')) s = ' ' + s;
          break;
        }
        case 'f': case 'F': {
          const n = Number(arg);
          s = n.toFixed(precision === undefined ? 6 : Number(precision));
          if (n >= 0 && flags.includes('+')) s = '+' + s;
          else if (n >= 0 && flags.includes(' ')) s = ' ' + s;
          break;
        }
        case 'e': case 'E': {
          const n = Number(arg);
          s = n.toExponential(precision === undefined ? 6 : Number(precision));
          s = s.replace(/e([+-])(\d)$/, 'e$10$2');
          if (conv === 'E') s = s.toUpperCase();
          break;
        }
        case 'g': case 'G': {
          const n = Number(arg);
          const p = precision === undefined ? 6 : Math.max(1, Number(precision));
          s = String(Number(n.toPrecision(p)));
          if (conv === 'G') s = s.toUpperCase();
          break;
        }
        case 'x': s = (Math.trunc(Number(arg)) >>> 0).toString(16); break;
        case 'X': s = (Math.trunc(Number(arg)) >>> 0).toString(16).toUpperCase(); break;
        case 'o': s = (Math.trunc(Number(arg)) >>> 0).toString(8); break;
        case 'c': s = String.fromCharCode(Number(arg)); break;
        case 'q': s = JSON.stringify(String(arg)); break;
        case 's': default:
          s = tostring(arg);
          if (precision !== undefined) s = s.slice(0, Number(precision));
          break;
      }
      if (width !== undefined && s.length < Number(width)) {
        const w = Number(width);
        if (flags.includes('-')) s = s.padEnd(w, ' ');
        else if (flags.includes('0') && /[diufFeEgGxXo]/.test(conv)) {
          const sign = /^[+\- ]/.test(s) ? s[0] : '';
          s = sign + s.slice(sign.length).padStart(w - sign.length, '0');
        } else s = s.padStart(w, ' ');
      }
      return s;
    });
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

const lua = { mod, random, tostring, format, clamp };
export default lua;
