// targets.match: a tiny, safe expression language over device descriptors.
//   ram_mb >= 4000 && os ~ 'android' || model == 'SM-X930'
// Operators: == != < <= > >= ~ (regex/contains, case-insensitive) && || ! ( )
// Identifiers resolve to descriptor fields (model, soc, ram_mb, os, app_ver)
// plus pools ("pools ~ 'ml-capable'") and capabilities
// ("capabilities ~ 'build:xcode'"). Never uses eval.

type Tok = { t: "num"; v: number } | { t: "str"; v: string } | { t: "id"; v: string } | { t: "op"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: "num", v: Number(src.slice(i, j)) }); i = j; continue;
    }
    if (c === "'" || c === '"') {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new Error("unterminated string");
      out.push({ t: "str", v: src.slice(i + 1, j) }); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("<>~!()".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`unexpected '${c}'`);
  }
  return out;
}

export type Descriptor = Record<string, unknown> & { pools?: string[]; capabilities?: string[] };

export function evalMatch(expr: string, d: Descriptor): boolean {
  const toks = lex(expr);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  // Both list fields are joined to a string so `~` can substring-match a single
  // entry ("capabilities ~ 'build:xcode'"); every other operator compares the
  // whole joined value, which is what == on a list should mean anyway.
  const value = (id: string): unknown =>
    id === "pools" ? (d.pools ?? []).join(",")
    : id === "capabilities" ? (d.capabilities ?? []).join(",")
    : d[id];

  function primary(): unknown {
    const t = next();
    if (!t) throw new Error("unexpected end");
    if (t.t === "num" || t.t === "str") return t.v;
    if (t.t === "id") return value(t.v);
    if (t.t === "op" && t.v === "(") { const v = orExpr(); const c = next(); if (!c || c.v !== ")") throw new Error("expected )"); return v; }
    if (t.t === "op" && t.v === "!") return !truthy(primary());
    throw new Error(`unexpected ${t.v}`);
  }
  function truthy(v: unknown): boolean { return v !== undefined && v !== null && v !== false && v !== 0 && v !== ""; }
  function cmp(): boolean {
    const l = primary();
    const t = peek();
    if (t && t.t === "op" && ["==", "!=", "<", "<=", ">", ">=", "~"].includes(t.v)) {
      next();
      const r = primary();
      switch (t.v) {
        case "==": return String(l) === String(r);
        case "!=": return String(l) !== String(r);
        case "<": return Number(l) < Number(r);
        case "<=": return Number(l) <= Number(r);
        case ">": return Number(l) > Number(r);
        case ">=": return Number(l) >= Number(r);
        case "~": {
          try { return new RegExp(String(r), "i").test(String(l ?? "")); }
          catch { return String(l ?? "").toLowerCase().includes(String(r).toLowerCase()); }
        }
      }
    }
    return truthy(l);
  }
  function andExpr(): boolean { let v = cmp(); while (peek()?.t === "op" && peek()?.v === "&&") { next(); v = cmp() && v; } return v; }
  function orExpr(): boolean { let v = andExpr(); while (peek()?.t === "op" && peek()?.v === "||") { next(); v = andExpr() || v; } return v; }
  const result = orExpr();
  if (p !== toks.length) throw new Error("trailing tokens");
  return result;
}

export function isValidMatch(expr: string): boolean {
  try { evalMatch(expr, {}); return true; } catch { return false; }
}
