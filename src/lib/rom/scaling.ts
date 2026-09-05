/**
 * Evaluator for EcuFlash scaling expressions.
 *
 * Definitions carry conversions as little arithmetic strings — `x*10/32`,
 * `14.7*128/x`, `x*5/1024`. These come from a user-supplied file, so they are
 * parsed with a restricted recursive-descent grammar rather than handed to
 * `eval`. Supported: numbers, the variable `x`, `+ - * / ^`, parentheses, unary
 * minus, and the handful of functions EcuFlash definitions actually use.
 */

type Node = (x: number) => number;

const FUNCTIONS: Record<string, (v: number) => number> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  log: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
};

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): Node {
    const node = this.expr();
    this.ws();
    if (this.pos < this.src.length) {
      throw new Error(`unexpected "${this.src.slice(this.pos)}" in expression "${this.src}"`);
    }
    return node;
  }

  private ws() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private eat(ch: string): boolean {
    this.ws();
    if (this.src[this.pos] === ch) { this.pos++; return true; }
    return false;
  }

  private expr(): Node {
    let left = this.term();
    for (;;) {
      if (this.eat('+')) { const r = this.term(); const l = left; left = (x) => l(x) + r(x); }
      else if (this.eat('-')) { const r = this.term(); const l = left; left = (x) => l(x) - r(x); }
      else return left;
    }
  }

  private term(): Node {
    let left = this.power();
    for (;;) {
      if (this.eat('*')) { const r = this.power(); const l = left; left = (x) => l(x) * r(x); }
      else if (this.eat('/')) { const r = this.power(); const l = left; left = (x) => l(x) / r(x); }
      else return left;
    }
  }

  private power(): Node {
    const base = this.unary();
    if (this.eat('^')) {
      const exp = this.power(); // right-associative
      return (x) => Math.pow(base(x), exp(x));
    }
    return base;
  }

  private unary(): Node {
    this.ws();
    if (this.eat('-')) { const n = this.unary(); return (x) => -n(x); }
    if (this.eat('+')) return this.unary();
    return this.atom();
  }

  private atom(): Node {
    this.ws();
    if (this.eat('(')) {
      const n = this.expr();
      if (!this.eat(')')) throw new Error(`missing ")" in expression "${this.src}"`);
      return n;
    }

    const numMatch = /^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/.exec(this.src.slice(this.pos));
    if (numMatch) {
      this.pos += numMatch[0].length;
      const v = Number(numMatch[0]);
      return () => v;
    }

    const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (idMatch) {
      const id = idMatch[0];
      this.pos += id.length;
      if (id === 'x' || id === 'X') return (x) => x;
      const fn = FUNCTIONS[id.toLowerCase()];
      if (fn) {
        if (!this.eat('(')) throw new Error(`expected "(" after ${id} in "${this.src}"`);
        const arg = this.expr();
        if (!this.eat(')')) throw new Error(`missing ")" after ${id} in "${this.src}"`);
        return (x) => fn(arg(x));
      }
      throw new Error(`unknown identifier "${id}" in expression "${this.src}"`);
    }

    throw new Error(`could not parse expression "${this.src}" at offset ${this.pos}`);
  }
}

const cache = new Map<string, Node>();

/** Compile an EcuFlash scaling expression into a function of the raw value. */
export function compileExpr(expr: string): Node {
  const key = expr.trim();
  const hit = cache.get(key);
  if (hit) return hit;
  const fn = new Parser(key).parse();
  cache.set(key, fn);
  return fn;
}

/** Apply a `format` string like `%.2f` / `%.0f` to a display value. */
export function formatValue(value: number, format: string | undefined): string {
  if (!Number.isFinite(value)) return '';
  const m = format ? /%\.(\d+)f/.exec(format) : null;
  if (m) return value.toFixed(Number(m[1]));
  if (format && /%d/.test(format)) return String(Math.round(value));
  if (format && /%[0-9]*[xX]/.test(format)) {
    return Math.round(value).toString(16).toUpperCase().padStart(4, '0');
  }
  return String(Math.round(value * 1000) / 1000);
}

/** Decimal places implied by a `format` string, for grid editing. */
export function decimalsFor(format: string | undefined): number {
  const m = format ? /%\.(\d+)f/.exec(format) : null;
  return m ? Number(m[1]) : 0;
}
