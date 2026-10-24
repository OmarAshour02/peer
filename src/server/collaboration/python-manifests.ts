// Dependencies declared in Python manifests, read without executing anything.
//
// Each reader returns the declared package names, or null when the file cannot be read with
// confidence (invalid TOML, a declaration that is not a literal, `file:` indirection). The caller
// treats null as "not declared here", so uncertainty leads Peer to ask, never to assume approval.
// Readers only ever add names they understood; what they skip makes Peer ask, never stay silent.
// Names are normalized like pip does (lowercase, runs of -_. become -).

export function normalizePypi(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** The package name of a PEP 508 requirement ("httpx[http2]>=0.27; python_version>'3.8'"), or null. */
export function requirementName(spec: string): string | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m ? normalizePypi(m[1]!) : null;
}

// ---------------------------------------------------------------------------
// TOML: a validating parser for the subset manifests use. Tables, arrays of tables, dotted keys,
// basic/literal/multi-line strings, arrays, inline tables, and booleans, numbers and date-times
// (validated, kept as raw text). Duplicate keys, redefined tables, extending inline tables or
// static arrays, unknown scalars and bad escapes are errors, so a malformed file declares nothing.

type TomlValue = string | TomlValue[] | TomlTable | { raw: string };
type TomlTable = { [key: string]: TomlValue };

class TomlError extends Error {}

export function parseToml(text: string): TomlTable | null {
  try {
    return new TomlParser(text).document();
  } catch {
    // Any failure, ours or not, means the file declares nothing Peer can rely on.
    return null;
  }
}

/** Calendar and clock ranges of a TOML date-time (the regexes only check the shape). */
function validDateTime(raw: string): boolean {
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    if (!days || d < 1 || d > days) return false;
  }
  const time = /(\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3]) > 60)) return false;
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(raw.slice(10));
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return false;
  return true;
}

/** Integers must fit in 64 bits. */
function validInteger(raw: string): boolean {
  const digits = raw.replace(/_/g, "");
  const n = /^[+-]?\d+$/.test(digits) ? BigInt(digits) : /^0[xob]/.test(digits) ? BigInt(digits) : null;
  return n === null || (n >= -(2n ** 63n) && n <= 2n ** 63n - 1n);
}

/** Characters TOML forbids in strings and comments: control characters other than tab. */
function forbidden(c: string, multiline: boolean): boolean {
  const code = c.charCodeAt(0);
  if (c === "\t" || (multiline && (c === "\n" || c === "\r"))) return false;
  return code <= 0x1f || code === 0x7f;
}

const SCALAR = [
  /^(true|false)$/,
  /^[+-]?(0|[1-9](_?\d)*)$/,
  /^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$|^0o[0-7](_?[0-7])*$|^0b[01](_?[01])*$/,
  /^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/,
  /^[+-]?(inf|nan)$/,
  // Offset/local date-times, dates and times (RFC 3339; the space form joins the next token).
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?$/,
  /^\d{2}:\d{2}:\d{2}(\.\d+)?$/,
];

class TomlParser {
  private i = 0;
  /** Tables created explicitly by a header, and tables/arrays that may not be extended later. */
  private readonly headers = new WeakSet<object>();
  private readonly frozen = new WeakSet<object>();
  /** Tables created implicitly by a dotted key; they may not be reopened with a header. */
  private readonly dotted = new WeakSet<object>();

  constructor(private readonly s: string) {}

  document(): TomlTable {
    const root: TomlTable = {};
    let table = root;
    for (;;) {
      this.skipBlank(true);
      if (this.i >= this.s.length) return root;
      if (this.s[this.i] === "[") {
        const array = this.s[this.i + 1] === "[";
        this.i += array ? 2 : 1;
        const path = this.keyPath();
        this.expect(array ? "]]" : "]");
        table = array ? this.appendTable(root, path) : this.headerTable(root, path);
      } else {
        this.keyValue(table);
      }
      this.skipSpaces();
      this.skipComment();
      if (this.i < this.s.length && this.s[this.i] !== "\n" && !this.s.startsWith("\r\n", this.i)) throw new TomlError("expected end of line");
    }
  }

  private keyValue(table: TomlTable) {
    const path = this.keyPath();
    this.skipSpaces();
    this.expect("=");
    this.skipSpaces();
    const value = this.value();
    const parent = this.walk(table, path.slice(0, -1), true);
    const key = path.at(-1)!;
    if (Object.hasOwn(parent, key)) throw new TomlError(`duplicate key ${key}`);
    parent[key] = value;
  }

  /** Descend into (creating) sub-tables. Inline tables and static arrays cannot be extended. */
  private walk(root: TomlTable, path: string[], viaDottedKey: boolean): TomlTable {
    let t = root;
    for (const key of path) {
      let next: TomlValue | undefined = t[key];
      if (Array.isArray(next)) {
        if (this.frozen.has(next)) throw new TomlError("cannot extend a static array");
        next = next.at(-1);
      }
      if (next === undefined) {
        next = {};
        t[key] = next;
        if (viaDottedKey) this.dotted.add(next);
      }
      if (typeof next !== "object" || Array.isArray(next) || "raw" in next || this.frozen.has(next)) throw new TomlError(`${key} is not an extensible table`);
      if (viaDottedKey && this.headers.has(next) && t !== root) throw new TomlError("cannot add to a table with a dotted key from outside it");
      t = next as TomlTable;
    }
    return t;
  }

  private headerTable(root: TomlTable, path: string[]): TomlTable {
    const parent = this.walk(root, path.slice(0, -1), false);
    const key = path.at(-1)!;
    let t = parent[key];
    if (t === undefined) {
      t = {};
      parent[key] = t;
    } else if (typeof t !== "object" || Array.isArray(t) || "raw" in t || this.frozen.has(t) || this.headers.has(t) || this.dotted.has(t)) {
      throw new TomlError(`table ${path.join(".")} defined twice`);
    }
    this.headers.add(t);
    return t as TomlTable;
  }

  private appendTable(root: TomlTable, path: string[]): TomlTable {
    const parent = this.walk(root, path.slice(0, -1), false);
    const key = path.at(-1)!;
    const list = parent[key] ?? (parent[key] = []);
    if (!Array.isArray(list) || this.frozen.has(list)) throw new TomlError(`${key} is not an array of tables`);
    const t: TomlTable = {};
    list.push(t);
    this.headers.add(t);
    return t;
  }

  private keyPath(): string[] {
    const path: string[] = [];
    for (;;) {
      this.skipSpaces();
      const c = this.s[this.i];
      if (c === '"' || c === "'") {
        if (this.s.startsWith(c.repeat(3), this.i)) throw new TomlError("multi-line string as a key");
        path.push(this.string());
      } else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i));
        if (!m) throw new TomlError("expected a key");
        path.push(m[0]);
        this.i += m[0].length;
      }
      this.skipSpaces();
      if (this.s[this.i] !== ".") return path;
      this.i++;
    }
  }

  private value(): TomlValue {
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.string();
    if (c === "[") return this.array();
    if (c === "{") return this.inlineTable();
    let m = /^[^\s,\]}#]+/.exec(this.s.slice(this.i));
    if (!m) throw new TomlError("expected a value");
    // "1979-05-27 07:32:00": a date-time may use a space between date and time.
    const spaced = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[^\s,\]}#]*/.exec(this.s.slice(this.i));
    if (spaced) m = spaced;
    if (!SCALAR.some((re) => re.test(m![0])) || !validDateTime(m[0]) || !validInteger(m[0])) throw new TomlError(`not a TOML value: ${m[0]}`);
    this.i += m[0].length;
    return { raw: m[0] };
  }

  private array(): TomlValue[] {
    this.expect("[");
    const items: TomlValue[] = [];
    this.frozen.add(items);
    for (;;) {
      this.skipBlank(true);
      if (this.s[this.i] === "]") {
        this.i++;
        return items;
      }
      items.push(this.value());
      this.skipBlank(true);
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") throw new TomlError("expected , or ]");
    }
  }

  private inlineTable(): TomlTable {
    this.expect("{");
    const t: TomlTable = {};
    this.skipSpaces();
    if (this.s[this.i] === "}") {
      this.i++;
      this.frozen.add(t);
      return t;
    }
    for (;;) {
      this.keyValue(t);
      this.skipSpaces();
      if (this.s[this.i] === "}") {
        this.i++;
        // Inline tables are complete: nothing may add to them, at any depth.
        this.freeze(t);
        return t;
      }
      this.expect(",");
      this.skipSpaces();
    }
  }

  private freeze(v: TomlValue) {
    if (typeof v !== "object" || "raw" in v) return;
    this.frozen.add(v);
    for (const child of Array.isArray(v) ? v : Object.values(v)) this.freeze(child);
  }

  private string(): string {
    const q = this.s[this.i]!;
    const triple = this.s.startsWith(q.repeat(3), this.i);
    const end = triple ? q.repeat(3) : q;
    this.i += end.length;
    if (triple && this.s[this.i] === "\n") this.i++;
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) throw new TomlError("unterminated string");
      if (this.s.startsWith(end, this.i)) {
        if (!triple) {
          this.i++;
          return out;
        }
        // A multi-line string may end with up to two quotes of content before its delimiter ("""a"""").
        let run = 0;
        while (this.s[this.i + run] === q) run++;
        if (run > 5) throw new TomlError("too many quotes");
        out += q.repeat(run - 3);
        this.i += run;
        return out;
      }
      const c = this.s[this.i]!;
      if (!triple && (c === "\n" || c === "\r")) throw new TomlError("newline in string");
      if (forbidden(c, triple) || (c === "\r" && this.s[this.i + 1] !== "\n")) throw new TomlError("control character in string");
      if (q === '"' && c === "\\") {
        const e = this.s[this.i + 1] ?? "";
        const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
        if (e in simple) {
          out += simple[e];
          this.i += 2;
        } else if (e === "u" || e === "U") {
          const len = e === "u" ? 4 : 8;
          const hex = this.s.slice(this.i + 2, this.i + 2 + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) throw new TomlError("bad unicode escape");
          const cp = parseInt(hex, 16);
          // Unicode scalar values only: no surrogates, nothing past U+10FFFF.
          if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new TomlError("bad unicode escape");
          out += String.fromCodePoint(cp);
          this.i += 2 + len;
        } else if (triple && /^[ \t]*\r?\n/.test(this.s.slice(this.i + 1))) {
          // Line-ending backslash: trim the newline and following whitespace.
          this.i++;
          while (/\s/.test(this.s[this.i] ?? "")) this.i++;
        } else {
          throw new TomlError(`bad escape \\${e}`);
        }
        continue;
      }
      out += c;
      this.i++;
    }
  }

  private expect(token: string) {
    if (!this.s.startsWith(token, this.i)) throw new TomlError(`expected ${token}`);
    this.i += token.length;
  }

  private skipSpaces() {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }

  private skipComment() {
    if (this.s[this.i] !== "#") return;
    while (this.i < this.s.length && this.s[this.i] !== "\n" && !this.s.startsWith("\r\n", this.i)) {
      if (forbidden(this.s[this.i]!, false)) throw new TomlError("control character in comment");
      this.i++;
    }
  }

  /** Spaces, comments and (with `newlines`) line breaks. */
  private skipBlank(newlines: boolean) {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      const c = this.s[this.i];
      if (newlines && (c === "\n" || c === "\r")) this.i++;
      else return;
    }
  }
}

function table(v: TomlValue | undefined): TomlTable | null {
  return v && typeof v === "object" && !Array.isArray(v) && !("raw" in v) ? (v as TomlTable) : null;
}

/** Requirement strings of an array (non-string entries, like dependency-group includes, are skipped). */
function requirementArray(v: TomlValue | undefined, into: Set<string>) {
  if (!Array.isArray(v)) return;
  for (const item of v) {
    const name = typeof item === "string" ? requirementName(item) : null;
    if (name) into.add(name);
  }
}

/** Package keys of a dependency table (Poetry, Pipfile). */
function dependencyTable(v: TomlValue | undefined, into: Set<string>) {
  for (const key of Object.keys(table(v) ?? {})) if (key.toLowerCase() !== "python") into.add(normalizePypi(key));
}

/** pyproject.toml: PEP 621 (dependencies, optional-dependencies), PEP 735 groups, build requires, Poetry, uv, PDM. */
export function pyprojectDependencies(text: string): Set<string> | null {
  const doc = parseToml(text);
  if (!doc) return null;
  const names = new Set<string>();
  const project = table(doc.project);
  requirementArray(project?.dependencies, names);
  for (const group of Object.values(table(project?.["optional-dependencies"]) ?? {})) requirementArray(group, names);
  for (const group of Object.values(table(doc["dependency-groups"]) ?? {})) requirementArray(group, names);
  requirementArray(table(doc["build-system"])?.requires, names);
  const tool = table(doc.tool);
  const poetry = table(tool?.poetry);
  dependencyTable(poetry?.dependencies, names);
  dependencyTable(poetry?.["dev-dependencies"], names);
  for (const group of Object.values(table(poetry?.group) ?? {})) dependencyTable(table(group)?.dependencies, names);
  requirementArray(table(tool?.uv)?.["dev-dependencies"], names);
  for (const group of Object.values(table(table(tool?.pdm)?.["dev-dependencies"]) ?? {})) requirementArray(group, names);
  return names;
}

/** Pipfile: [packages] and [dev-packages]. */
export function pipfileDependencies(text: string): Set<string> | null {
  const doc = parseToml(text);
  if (!doc) return null;
  const names = new Set<string>();
  dependencyTable(doc.packages, names);
  dependencyTable(doc["dev-packages"], names);
  return names;
}

// ---------------------------------------------------------------------------
// setup.cfg (INI)

/** setup.cfg: [options] install_requires and [options.extras_require] values. `file:` indirection is not followed. */
export function setupCfgDependencies(text: string): Set<string> | null {
  const names = new Set<string>();
  let section = "";
  let key: string | null = null;
  let uncertain = false;
  const take = (key: string | null, value: string) => {
    const wanted = (section === "options" && key === "install_requires") || section === "options.extras_require";
    const v = value.trim();
    if (!wanted || !v) return;
    if (v.startsWith("file:")) uncertain = true;
    else {
      const name = requirementName(v);
      if (name) names.add(name);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line) || !line.trim()) continue;
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1]!.trim().toLowerCase();
      key = null;
      continue;
    }
    if (/^\s/.test(line) && key !== null) {
      take(key, line.replace(/\s[#;].*$/, ""));
      continue;
    }
    const kv = /^([^=:]+)[=:](.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1]!.trim().toLowerCase();
    take(key, kv[2]!.replace(/\s[#;].*$/, ""));
  }
  return uncertain && names.size === 0 ? null : names;
}

// ---------------------------------------------------------------------------
// setup.py (tokenized, never executed)

type PyToken = { kind: "name" | "string" | "op"; text: string };
/** A logical line: its tokens and the indentation of its first token. */
type PyLine = { indent: number; tokens: PyToken[] };

/**
 * Python logical lines (brackets and backslashes join physical lines), without comments. Plain
 * string literals are decoded and adjacent ones joined, as Python does ("httpx" "-sse" is one
 * string). f-strings and bytes are not literals Peer trusts: they become an opaque token.
 */
function pyLines(src: string): PyLine[] | null {
  const lines: PyLine[] = [];
  let tokens: PyToken[] = [];
  let indent = 0;
  let depth = 0;
  let atLineStart = true;
  let column = 0;
  const push = (t: PyToken) => {
    if (tokens.length === 0) indent = column;
    const last = tokens.at(-1);
    if (t.kind === "string" && last?.kind === "string") last.text += t.text;
    else tokens.push(t);
  };
  const endLine = () => {
    if (tokens.length > 0) lines.push({ indent, tokens });
    tokens = [];
    atLineStart = true;
    column = 0;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      i++;
      if (depth === 0) endLine();
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      if (atLineStart && depth === 0 && tokens.length === 0) column += c === "\t" ? 8 - (column % 8) : 1;
      i++;
      continue;
    }
    atLineStart = false;
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      i += 2;
      continue;
    }
    const str = /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(src.slice(i));
    if (str) {
      const prefix = str[1]!.toLowerCase();
      const quote = str[2]!;
      let j = i + str[0].length;
      let value = "";
      for (;;) {
        if (j >= src.length) return null;
        if (src.startsWith(quote, j)) {
          j += quote.length;
          break;
        }
        if (quote.length === 1 && src[j] === "\n") return null;
        if (src[j] === "\\" && !prefix.includes("r")) {
          value += src[j + 1] ?? "";
          j += 2;
          continue;
        }
        value += src[j];
        j++;
      }
      const opaque = prefix.includes("f") || prefix.includes("b");
      push(opaque ? { kind: "op", text: "<expr>" } : { kind: "string", text: value });
      i = j;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9][0-9A-Za-z_.]*/.exec(src.slice(i));
    if (word) {
      push({ kind: /^[0-9]/.test(word[0]) ? "op" : "name", text: word[0] });
      i += word[0].length;
      continue;
    }
    const op = /^(\*\*=?|\/\/=?|==|!=|<=|>=|:=|->|[-+*/%@&|^]=|<<=?|>>=?|\S)/.exec(src.slice(i))!;
    if ("([{".includes(op[0])) depth++;
    if (")]}".includes(op[0])) depth = Math.max(0, depth - 1);
    push({ kind: "op", text: op[0] });
    i += op[0].length;
  }
  endLine();
  return depth === 0 ? lines : null;
}

type PyLiteral = string[] | { values: string[] };

/**
 * A literal list/tuple of strings, or a dict whose values are such lists (keys are extras group
 * names, never packages), starting at tokens[i]. Returns where it ends, so the caller can check
 * that the literal is the whole expression.
 */
function literalAt(tokens: PyToken[], i: number): { value: PyLiteral; end: number } | null {
  const open = tokens[i]?.text;
  if (open === "[" || open === "(") {
    const close = open === "[" ? "]" : ")";
    const items: string[] = [];
    let j = i + 1;
    for (;;) {
      const t = tokens[j];
      if (t?.text === close) return { value: items, end: j + 1 };
      if (t?.kind !== "string") return null;
      items.push(t.text);
      j++;
      if (tokens[j]?.text === ",") j++;
      else if (tokens[j]?.text !== close) return null;
    }
  }
  if (open === "{") {
    const values: string[] = [];
    let j = i + 1;
    for (;;) {
      const t = tokens[j];
      if (t?.text === "}") return { value: { values }, end: j + 1 };
      if (t?.kind !== "string" || tokens[j + 1]?.text !== ":") return null;
      const inner = literalAt(tokens, j + 2);
      if (!inner || !Array.isArray(inner.value)) return null;
      values.push(...inner.value);
      j = inner.end;
      if (tokens[j]?.text === ",") j++;
      else if (tokens[j]?.text !== "}") return null;
    }
  }
  return null;
}

const DECLARATION_KEYWORDS = new Set(["install_requires", "extras_require"]);
const MUTATORS = new Set(["append", "extend", "insert", "update", "setdefault", "pop", "remove", "clear", "__setitem__", "__iadd__"]);

/**
 * setup.py: the `install_requires` and `extras_require` arguments of `setup(...)` calls made at
 * module level (or under a top-level `if __name__ == "__main__":`). A value counts when it is a
 * complete literal list/tuple of strings, a dict of them, or a name bound exactly once, at module
 * level, to such a literal and never changed afterwards. Calls inside functions or classes, and
 * values Peer cannot read with confidence (calls, comprehensions, concatenation, conditionals),
 * declare nothing. Returns null when nothing could be understood but something was not.
 */
export function setupPyDependencies(text: string): Set<string> | null {
  const lines = pyLines(text);
  if (!lines) return null;

  // Lines that run when setup.py runs as a script: module level, and the body of a top-level
  // `if __name__ == "__main__":`. Function and class bodies only run if called; they are skipped.
  const runs: PyLine[] = [];
  /** Indentation of the current main guard's direct statements; deeper lines are nested blocks. */
  let guardBody: number | null = null;
  let inMainGuard = false;
  for (const line of lines) {
    if (line.indent === 0) {
      inMainGuard = isMainGuard(line.tokens);
      guardBody = null;
      runs.push(line);
    } else if (inMainGuard) {
      guardBody ??= line.indent;
      if (line.indent === guardBody) runs.push(line);
    }
  }

  // Every place a name is (re)bound or changed, anywhere in the file. A name used as a
  // declaration value is trusted only if it is bound exactly once, at module level, to a complete
  // literal, and never touched otherwise.
  const touched = new Map<string, number>();
  const touch = (name: string) => touched.set(name, (touched.get(name) ?? 0) + 1);
  const bindings = new Map<string, PyLiteral | null>();
  for (const line of lines) {
    const tk = line.tokens;
    // Assignment targets: names at bracket depth 0 before the first `=` or augmented assignment.
    let depth = 0;
    const targets: string[] = [];
    for (let k = 0; k < tk.length; k++) {
      const t = tk[k]!;
      if (t.kind === "op" && "([{".includes(t.text)) depth++;
      else if (t.kind === "op" && ")]}".includes(t.text)) depth--;
      else if (depth === 0 && t.kind === "op" && (t.text === "=" || (t.text.endsWith("=") && !["==", "!=", "<=", ">="].includes(t.text) && t.text !== ":="))) {
        for (const name of targets) touch(name);
        break;
      } else if (depth === 0 && t.kind === "name" && tk[k - 1]?.text !== ".") targets.push(t.text);
    }
    for (let k = 0; k < tk.length; k++) {
      const t = tk[k]!;
      if (t.kind !== "name") continue;
      const prev = tk[k - 1]?.text;
      if (["for", "as", "def", "class", "import", "global", "nonlocal", "del"].includes(prev ?? "") || tk[k + 1]?.text === ":=") touch(t.text);
      if (tk[k + 1]?.text === "." && MUTATORS.has(tk[k + 2]?.text ?? "")) touch(t.text);
    }
    if (line.indent === 0 && tk[0]?.kind === "name" && tk[1]?.text === "=") {
      const lit = literalAt(tk, 2);
      bindings.set(tk[0].text, lit && lit.end === tk.length ? lit.value : null);
    }
  }
  const bound = (name: string): PyLiteral | null => (touched.get(name) === 1 ? bindings.get(name) ?? null : null);

  const names = new Set<string>();
  let uncertain = false;
  for (const line of runs) {
    const tk = line.tokens;
    // The call must be the whole statement (`setup(...)` or `setuptools.setup(...)`), so that it
    // certainly runs: not inside `x if cond else y`, a lambda, or a boolean expression.
    const k = tk[0]?.text === "setup" && tk[1]?.text === "(" ? 0 : tk[0]?.kind === "name" && tk[1]?.text === "." && tk[2]?.text === "setup" && tk[3]?.text === "(" ? 2 : -1;
    if (k === -1 || closingParen(tk, k + 1) !== tk.length - 1) continue;
    // Direct arguments of this call: depth 1 relative to its parenthesis.
    let depth = 0;
    for (let j = k + 1; j < tk.length; j++) {
      const t = tk[j]!;
      if ("([{".includes(t.text) && t.kind === "op") depth++;
      else if (")]}".includes(t.text) && t.kind === "op") {
        depth--;
        if (depth === 0) break;
      }
      if (depth !== 1 || t.kind !== "name" || !DECLARATION_KEYWORDS.has(t.text) || tk[j + 1]?.text !== "=" || !",(".includes(tk[j - 1]!.text)) continue;
      const start = j + 2;
      let value: PyLiteral | null = null;
      const lit = literalAt(tk, start);
      if (lit && ",)".includes(tk[lit.end]?.text ?? "")) value = lit.value;
      else if (tk[start]?.kind === "name" && ",)".includes(tk[start + 1]?.text ?? "")) value = bound(tk[start]!.text);
      if (!value) {
        uncertain = true;
        continue;
      }
      for (const spec of Array.isArray(value) ? value : value.values) {
        const name = requirementName(spec);
        if (name) names.add(name);
      }
    }
  }
  return uncertain && names.size === 0 ? null : names;
}

/** Exactly `if __name__ == "__main__":` (either operand order). */
function isMainGuard(tk: PyToken[]): boolean {
  if (tk.length !== 5 || tk[0]!.text !== "if" || tk[2]!.text !== "==" || tk[4]!.text !== ":") return false;
  const [a, b] = [tk[1]!, tk[3]!];
  const name = (t: PyToken) => t.kind === "name" && t.text === "__name__";
  const main = (t: PyToken) => t.kind === "string" && t.text === "__main__";
  return (name(a) && main(b)) || (main(a) && name(b));
}

/** Index of the bracket closing the one at tokens[open], or -1. */
function closingParen(tk: PyToken[], open: number): number {
  let depth = 0;
  for (let j = open; j < tk.length; j++) {
    const t = tk[j]!;
    if (t.kind !== "op") continue;
    if ("([{".includes(t.text)) depth++;
    else if (")]}".includes(t.text) && --depth === 0) return j;
  }
  return -1;
}
