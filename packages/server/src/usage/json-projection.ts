export type Fields = { readonly [key: string]: true | Fields };
type Frame = {
  readonly kind: "object" | "array";
  readonly fields: true | Fields | undefined;
  readonly value: Record<string, unknown> | unknown[] | undefined;
  readonly seen: Set<string>;
  phase: "key" | "colon" | "value" | "comma";
  key: string;
  count: number;
};

/** Incremental JSON validation/projection. Skipped string values are never materialized. */
export class JsonProjection {
  readonly #fields: Fields;
  readonly #frames: Frame[] = [];
  #mode: "string" | "literal" | undefined;
  #raw = "";
  #capture = false;
  #key = false;
  #escape = false;
  #unicode = 0;
  #done = false;
  #bad = false;
  #result: unknown;
  #selected = 0;

  constructor(fields: Fields) {
    this.#fields = fields;
  }
  #selection(): true | Fields | undefined {
    const parent = this.#frames.at(-1);
    if (parent === undefined) return this.#fields;
    return parent.fields === true
      ? true
      : parent.kind === "array"
        ? parent.fields
        : parent.fields !== undefined && Object.hasOwn(parent.fields, parent.key)
          ? parent.fields[parent.key]
          : undefined;
  }
  #complete(value: unknown): void {
    const parent = this.#frames.at(-1);
    if (parent === undefined) {
      this.#result = value;
      this.#done = true;
      return;
    }
    if (parent.phase !== "value") {
      this.#bad = true;
      return;
    }
    if (value !== undefined && parent.value !== undefined) {
      if (Array.isArray(parent.value)) parent.value.push(value);
      else parent.value[parent.key] = value;
    }
    parent.count++;
    parent.phase = "comma";
  }
  #endToken(): void {
    let value: unknown;
    try {
      value = JSON.parse(this.#raw);
    } catch {
      this.#bad = true;
    }
    if (this.#key) {
      const parent = this.#frames.at(-1)!;
      parent.key = typeof value === "string" ? value : "";
      if (typeof parent.fields === "object" && Object.hasOwn(parent.fields, parent.key)) {
        if (parent.seen.has(parent.key)) this.#bad = true;
        parent.seen.add(parent.key);
      }
      parent.phase = "colon";
    } else this.#complete(this.#capture ? value : undefined);
    this.#mode = undefined;
    this.#raw = "";
  }
  feed(text: string): void {
    for (let index = 0; index < text.length && !this.#bad; index++) {
      const c = text[index]!;
      if (this.#mode === "string") {
        if (this.#capture || this.#key) {
          this.#raw += c;
          if (this.#raw.length > 1024 || ++this.#selected > 16_384) {
            this.#bad = true;
            break;
          }
        }
        if (this.#unicode > 0) {
          if (!/[0-9a-fA-F]/.test(c)) this.#bad = true;
          this.#unicode--;
          continue;
        }
        if (this.#escape) {
          if (c === "u") this.#unicode = 4;
          else if (!'"\\/bfnrt'.includes(c)) this.#bad = true;
          this.#escape = false;
          continue;
        }
        if (c === "\\") {
          this.#escape = true;
          continue;
        }
        if (c.charCodeAt(0) < 32) {
          this.#bad = true;
          continue;
        }
        if (c === '"') {
          // Unselected strings still validated their escapes/control bytes above.
          if (!this.#capture && !this.#key) this.#raw = '""';
          this.#endToken();
        }
        continue;
      }
      if (this.#mode === "literal") {
        if (!/[ \t\r\n,}\]]/.test(c)) {
          this.#raw += c;
          if (this.#raw.length > 64) this.#bad = true;
          continue;
        }
        this.#endToken();
        index--;
        continue;
      }
      if (/[ \t\r\n]/.test(c)) continue;
      if (this.#done) {
        this.#bad = true;
        break;
      }
      const parent = this.#frames.at(-1);
      if (parent?.phase === "colon") {
        if (c !== ":") this.#bad = true;
        else parent.phase = "value";
        continue;
      }
      if (c === "}" || c === "]") {
        if (
          parent === undefined ||
          (c === "}") !== (parent.kind === "object") ||
          (parent.phase !== "comma" &&
            !(parent.count === 0 && parent.phase === (parent.kind === "object" ? "key" : "value")))
        ) {
          this.#bad = true;
          break;
        }
        this.#frames.pop();
        this.#complete(parent.value);
        continue;
      }
      if (parent?.phase === "comma") {
        if (c !== ",") this.#bad = true;
        else parent.phase = parent.kind === "object" ? "key" : "value";
        continue;
      }
      this.#key = parent?.phase === "key";
      if (this.#key && c !== '"') {
        this.#bad = true;
        break;
      }
      if (c === '"') {
        this.#mode = "string";
        this.#capture = this.#key || this.#selection() === true;
        this.#raw = this.#capture ? '"' : "";
        continue;
      }
      const selected = this.#selection();
      if (c === "{" || c === "[") {
        // Selected leaves are scalars. A malformed counter/model cannot allocate a subtree.
        if (selected === true) {
          this.#bad = true;
          break;
        }
        if (this.#frames.length >= 64) {
          this.#bad = true;
          break;
        }
        this.#frames.push({
          kind: c === "{" ? "object" : "array",
          fields: selected,
          value:
            selected === undefined
              ? undefined
              : c === "{"
                ? (Object.create(null) as Record<string, unknown>)
                : [],
          seen: new Set(),
          phase: c === "{" ? "key" : "value",
          key: "",
          count: 0,
        });
      } else {
        this.#mode = "literal";
        this.#capture = selected === true;
        this.#raw = c;
      }
    }
  }
  finish(): unknown {
    if (this.#mode === "literal") this.#endToken();
    return !this.#bad && this.#done && this.#mode === undefined && this.#frames.length === 0
      ? this.#result
      : undefined;
  }
}
