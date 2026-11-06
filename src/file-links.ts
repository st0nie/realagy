// Streaming rewrite of `[label](file://...)` Markdown links into plain paths.
//
// agy's default system prompt requires clickable file:// links for every
// file and code symbol ([utils.py](file:///abs/utils.py#L10-L20)). pi's TUI
// renders a link whose text differs from its URL as `text (url)` on
// terminals without OSC 8 hyperlinks, and the basename-only label hides the
// directory. realagy's agent profile asks for plain paths instead; this
// rewrite catches the links a model still writes (strong habit, or resumed
// sessions whose history is full of them):
//   - label is a code symbol (not the target's name):  [`Foo`](file:///w/a.ts#L3) -> `Foo`
//   - label already holds a path:  [src/a.ts](file:///w/src/a.ts#L1-L2) -> src/a.ts:1-2
//   - label is the bare file name: [a.ts](file:///w/src/a.ts#L1-L2) -> src/a.ts:1-2
//     (relative to the working directory when inside it, else absolute)
// Backticks around the label are kept. Image links, links inside inline
// code or fenced code blocks, and bare file:// URLs are left alone. A link
// split across chunks is held until it completes (MAX_LINK_CHARS at most).

/** Longest `[label](url)` held while waiting for its end. */
export const MAX_LINK_CHARS = 2048;
const MAX_LABEL_CHARS = 512;

type Scan = { kind: "more" } | { kind: "no" } | { kind: "link"; end: number; text: string };

/** Line range from a `#L10-L20` / `#L10` / `#L10C2-L20C5` fragment. */
function lineRange(fragment: string): string | undefined {
	const m = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(fragment);
	if (!m) return undefined;
	return m[2] && m[2] !== m[1] ? `${m[1]}-${m[2]}` : m[1];
}

function decode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

const slashes = (p: string) => p.replace(/\\/g, "/");
const isWindowsPath = (p: string) => /^[A-Za-z]:\//.test(p);

/** Decoded local path and line range of a file:// URL, or undefined. */
export function parseFileUrl(url: string): { path: string; lines?: string } | undefined {
	if (!/^file:\/\//i.test(url)) return undefined;
	let rest = url.slice("file://".length);
	const hash = rest.indexOf("#");
	const fragment = hash >= 0 ? rest.slice(hash + 1) : "";
	if (hash >= 0) rest = rest.slice(0, hash);
	const query = rest.indexOf("?");
	if (query >= 0) rest = rest.slice(0, query);
	// file://localhost/p and file:///p; a bare drive (file://C:/p) too.
	if (/^localhost\//i.test(rest)) rest = rest.slice("localhost".length);
	let p = slashes(decode(rest));
	if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
	if (!p.startsWith("/") && !isWindowsPath(p)) return undefined;
	const lines = lineRange(decode(fragment));
	return lines ? { path: p, lines } : { path: p };
}

/** `p` relative to `cwd` when inside it (forward slashes), else `p`. */
export function displayPath(p: string, cwd: string | undefined): string {
	if (!cwd) return p;
	const base = slashes(cwd).replace(/\/+$/, "");
	const fold = isWindowsPath(p) || isWindowsPath(base);
	const a = fold ? p.toLowerCase() : p;
	const b = fold ? base.toLowerCase() : base;
	if (b && a.startsWith(`${b}/`) && p.length > base.length + 1) return p.slice(base.length + 1);
	return p;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Plain text for one `[label](url)` file link. */
export function plainFileLink(label: string, url: string, cwd?: string): string | undefined {
	const target = parseFileUrl(url);
	if (!target) return undefined;
	const ticked = /^(`+)([^`].*?)\1$/s.exec(label);
	const inner = ticked ? ticked[2] : label;
	const wrap = (text: string) => (ticked ? `${ticked[1]}${text}${ticked[1]}` : text);
	const suffix = (text: string) => (target.lines && !/:\d+(?:-\d+)?$/.test(text) ? `${text}:${target.lines}` : text);
	const name = basename(target.path);
	const bare = inner.replace(/(?:#L\d+.*|:\d+(?:-\d+)?)$/i, "");
	if (name && bare.toLowerCase() === name.toLowerCase()) return wrap(suffix(displayPath(target.path, cwd)));
	// A label that is itself a path is kept, the target's own path made
	// relative like a bare name.
	if (!/\s/.test(inner) && /[/\\]/.test(inner)) {
		const written = slashes(bare.length > 0 ? bare : inner);
		const same = isWindowsPath(written) ? written.toLowerCase() === target.path.toLowerCase() : written === target.path;
		return wrap(suffix(same ? displayPath(target.path, cwd) : slashes(inner)));
	}
	// A code symbol or free text: the label alone.
	return label;
}

/** Try to read `[label](file://...)` starting at `s[i] === "["`. */
function scanLink(s: string, i: number, cwd: string | undefined): Scan {
	let j = i + 1;
	let depth = 0;
	for (; ; j++) {
		if (j >= s.length) return j - i > MAX_LABEL_CHARS ? { kind: "no" } : { kind: "more" };
		const c = s[j];
		if (c === "\n" || j - i > MAX_LABEL_CHARS) return { kind: "no" };
		if (c === "\\") {
			j++;
			continue;
		}
		if (c === "[") depth++;
		else if (c === "]") {
			if (depth === 0) break;
			depth--;
		}
	}
	const label = s.slice(i + 1, j);
	if (label.length === 0) return { kind: "no" };
	if (j + 1 >= s.length) return { kind: "more" };
	if (s[j + 1] !== "(") return { kind: "no" };
	const urlStart = j + 2;
	const scheme = "file://";
	const head = s.slice(urlStart, urlStart + scheme.length);
	if (head.toLowerCase() !== scheme.slice(0, head.length)) return { kind: "no" };
	if (head.length < scheme.length) return { kind: "more" };
	// URL up to whitespace or the unbalanced ")"; then an optional title.
	let k = urlStart;
	let parens = 0;
	for (; ; k++) {
		if (k >= s.length) return k - i > MAX_LINK_CHARS ? { kind: "no" } : { kind: "more" };
		const c = s[k];
		if (c === "\n" || k - i > MAX_LINK_CHARS) return { kind: "no" };
		if (c === "(") parens++;
		else if (c === ")") {
			if (parens === 0) break;
			parens--;
		} else if (c === " " || c === "\t") break;
	}
	const url = s.slice(urlStart, k);
	if (s[k] !== ")") {
		const close = s.indexOf(")", k);
		const nl = s.indexOf("\n", k);
		if (close < 0) return nl >= 0 || s.length - i > MAX_LINK_CHARS ? { kind: "no" } : { kind: "more" };
		if (nl >= 0 && nl < close) return { kind: "no" };
		if (!/^\s+(?:"[^"]*"|'[^']*')?\s*$/.test(s.slice(k, close))) return { kind: "no" };
		k = close;
	}
	const text = plainFileLink(label, url, cwd);
	return text === undefined ? { kind: "no" } : { kind: "link", end: k + 1, text };
}

/** Stateful streaming rewriter. push() returns what may be emitted now;
 *  flush() releases anything held at the end of the stream. */
export class FileLinkRewriter {
	#cwd: string | undefined;
	#buffer = "";
	#lineStart = true;
	/** Opening fence (``` or ~~~ run) while inside a fenced code block. */
	#fence: string | undefined;
	/** Rest of a fence line (info string or closing line) passes verbatim. */
	#skipLine = false;
	/** Backtick run length of the open inline code span, 0 outside. */
	#ticks = 0;
	#prev = "";

	constructor(cwd?: string) {
		this.#cwd = cwd;
	}

	push(chunk: string): string {
		if (!chunk) return "";
		this.#buffer += chunk;
		return this.#scan(false);
	}

	flush(): string {
		return this.#scan(true);
	}

	#scan(final: boolean): string {
		const s = this.#buffer;
		let out = "";
		let i = 0;
		const take = (end: number) => {
			if (end <= i) return;
			const text = s.slice(i, end);
			out += text;
			this.#prev = text[text.length - 1] ?? this.#prev;
			i = end;
		};
		while (i < s.length) {
			if (this.#skipLine) {
				const nl = s.indexOf("\n", i);
				if (nl < 0) {
					take(s.length);
					break;
				}
				take(nl + 1);
				this.#skipLine = false;
				this.#lineStart = true;
				continue;
			}
			if (this.#lineStart) {
				const nl = s.indexOf("\n", i);
				const line = s.slice(i, nl < 0 ? s.length : nl);
				// Undecided: the line so far could still open or close a fence.
				if (!final && nl < 0 && /^ {0,3}(?:`*|~*)$/.test(line)) break;
				this.#lineStart = false;
				const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
				if (this.#fence !== undefined) {
					const fence = this.#fence;
					if (m && m[1][0] === fence[0] && m[1].length >= fence.length && m[2].trim() === "") this.#fence = undefined;
					this.#skipLine = true;
					continue;
				}
				// A backtick fence's info string has no backticks (CommonMark).
				if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
					this.#fence = m[1];
					this.#ticks = 0;
					this.#skipLine = true;
					continue;
				}
			}
			// Plain text up to the next character that matters.
			const next = s.slice(i).search(/[\n`[]/);
			if (next < 0) {
				take(s.length);
				break;
			}
			take(i + next);
			const c = s[i];
			if (c === "\n") {
				take(i + 1);
				this.#lineStart = true;
				this.#ticks = 0;
				continue;
			}
			if (c === "`") {
				let r = i;
				while (r < s.length && s[r] === "`") r++;
				if (r === s.length && !final) break;
				const run = r - i;
				if (this.#ticks === 0) this.#ticks = run;
				else if (run === this.#ticks) this.#ticks = 0;
				take(r);
				continue;
			}
			// "["
			if (this.#ticks > 0 || this.#prev === "!" || this.#prev === "\\") {
				take(i + 1);
				continue;
			}
			const link = scanLink(s, i, this.#cwd);
			if (link.kind === "more" && !final) break;
			if (link.kind === "link") {
				out += link.text;
				this.#prev = link.text[link.text.length - 1] ?? this.#prev;
				i = link.end;
				continue;
			}
			take(i + 1);
		}
		this.#buffer = s.slice(i);
		if (final && this.#buffer) {
			out += this.#buffer;
			this.#buffer = "";
		}
		return out;
	}
}
