import assert from "node:assert/strict";
import { test } from "vitest";
import { TextAccumulator } from "../src/acp/events.js";
import { displayPath, FileLinkRewriter, MAX_LINK_CHARS, parseFileUrl, plainFileLink } from "../src/file-links.js";

const CWD = "/work/proj";

function stream(chunks: string[], cwd = CWD): string {
	const rewriter = new FileLinkRewriter(cwd);
	return chunks.map((chunk) => rewriter.push(chunk)).join("") + rewriter.flush();
}

/** Every split of `text` into two chunks, and one chunk per character. */
function allSplits(text: string, cwd = CWD): string[] {
	const outs = [stream([text], cwd), stream([...text], cwd)];
	for (let i = 1; i < text.length; i++) outs.push(stream([text.slice(0, i), text.slice(i)], cwd));
	return outs;
}

test("file URLs decode to paths and line ranges", () => {
	assert.deepEqual(parseFileUrl("file:///work/proj/src/a.ts#L10-L20"), { path: "/work/proj/src/a.ts", lines: "10-20" });
	assert.deepEqual(parseFileUrl("file:///work/my%20dir/a.ts#L7"), { path: "/work/my dir/a.ts", lines: "7" });
	assert.deepEqual(parseFileUrl("file:///C:/Users/me/a.ts#L3C1-L5C2"), { path: "C:/Users/me/a.ts", lines: "3-5" });
	assert.deepEqual(parseFileUrl("file://localhost/etc/hosts"), { path: "/etc/hosts" });
	assert.deepEqual(parseFileUrl("file:///a.ts#L4-L4"), { path: "/a.ts", lines: "4" });
	assert.equal(parseFileUrl("https://example.com/a.ts"), undefined);
	assert.equal(parseFileUrl("file://server/share"), undefined);
});

test("paths inside the working directory become relative", () => {
	assert.equal(displayPath("/work/proj/src/a.ts", CWD), "src/a.ts");
	assert.equal(displayPath("/work/project2/a.ts", CWD), "/work/project2/a.ts");
	assert.equal(displayPath("C:/Users/Me/proj/a.ts", "c:\\users\\me\\proj"), "a.ts");
	assert.equal(displayPath("/work/proj", CWD), "/work/proj");
});

test("each label kind gets its plain form", () => {
	const url = "file:///work/proj/src/utils.py#L10-L20";
	assert.equal(plainFileLink("utils.py", url, CWD), "src/utils.py:10-20");
	assert.equal(plainFileLink("`utils.py`", url, CWD), "`src/utils.py:10-20`");
	assert.equal(plainFileLink("utils.py:10-20", url, CWD), "src/utils.py:10-20");
	assert.equal(plainFileLink("`ClassName`", url, CWD), "`ClassName`");
	assert.equal(plainFileLink("the helper", url, CWD), "the helper");
	assert.equal(plainFileLink("src/utils.py", url, CWD), "src/utils.py:10-20");
	assert.equal(plainFileLink("src/utils.py:10", url, CWD), "src/utils.py:10");
	assert.equal(plainFileLink("/work/proj/src/utils.py", url, CWD), "src/utils.py:10-20");
	assert.equal(plainFileLink("utils.py", "file:///elsewhere/utils.py", CWD), "/elsewhere/utils.py");
	assert.equal(plainFileLink("a.ts", "file:///C:/w/proj/a.ts#L2", "C:\\w\\proj"), "a.ts:2");
});

test("links are rewritten however the stream splits them", () => {
	const text = "See [utils.py](file:///work/proj/src/utils.py#L10-L20) and [`Foo`](file:///work/proj/src/foo.ts#L3).\n";
	const want = "See src/utils.py:10-20 and `Foo`.\n";
	for (const out of allSplits(text)) assert.equal(out, want);
});

test("non-file links, images, code, and bare URLs are left alone", () => {
	const cases = [
		"A [web link](https://example.com) here.",
		"An image ![shot](file:///work/proj/shot.png) here.",
		"Inline `[a.ts](file:///work/proj/a.ts)` code.",
		"```md\n[a.ts](file:///work/proj/a.ts)\n```\n",
		"~~~\n[a.ts](file:///work/proj/a.ts)\n~~~\n",
		"Log: file:///tmp/task-1.log done",
		"Checklist [x] done and [1] ref, [unclosed",
		"Escaped \\[a.ts](file:///work/proj/a.ts) link.",
	];
	for (const text of cases) for (const out of allSplits(text)) assert.equal(out, text, JSON.stringify(text));
});

test("links after a closed fence are rewritten again", () => {
	const text = "```ts\nconst a = 1;\n```\nSee [a.ts](file:///work/proj/a.ts).";
	for (const out of allSplits(text)) assert.equal(out, "```ts\nconst a = 1;\n```\nSee a.ts.");
});

test("a link with a title, and one with parentheses in its path", () => {
	assert.equal(stream(['[a.ts](file:///work/proj/a.ts "title")']), "a.ts");
	assert.equal(stream(["[b.ts](file:///work/proj/x(1)/b.ts#L2)"]), "x(1)/b.ts:2");
});

test("an overlong or unfinished candidate is released unchanged", () => {
	const long = `[${"x".repeat(MAX_LINK_CHARS)}`;
	const rewriter = new FileLinkRewriter(CWD);
	const out = rewriter.push(long);
	assert.equal(out, long, "nothing is held past the limit");
	const partial = new FileLinkRewriter(CWD);
	assert.equal(partial.push("Look at [a.ts](file:///work/pr"), "Look at ");
	assert.equal(partial.flush(), "[a.ts](file:///work/pr");
});

test("TextAccumulator rewrites links after the SYSTEM_MESSAGE filter and releases them at a boundary", () => {
	const acc = new TextAccumulator(CWD);
	const parts = [acc.append("Edit [a.ts](file:///work"), acc.append("/proj/src/a.ts#L1-L2) now"), acc.append(" [b")];
	assert.deepEqual(parts, ["Edit ", "src/a.ts:1-2 now", " "]);
	assert.equal(acc.boundary(), "[b");
	assert.equal(acc.append("] next"), "] next");
	assert.equal(acc.flush(), null);
	assert.equal(acc.text, "Edit src/a.ts:1-2 now [b] next");
});
