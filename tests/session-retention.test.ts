import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, test } from "vitest";
import { SessionRetention, SESSION_RETENTION_MS } from "../src/acp/session-retention.js";

const roots: string[] = [];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-retention-"));
	roots.push(root);
	const dir = path.join(root, "conversations");
	fs.mkdirSync(dir);
	const brain = path.join(root, "brain");
	fs.mkdirSync(brain);
	let now = 1_800_000_000_000;
	const alive = new Set<number>();
	const store = (pid: number) => new SessionRetention({ conversationsDir: dir, pid, isAlive: (p) => alive.has(p), now: () => now });
	const create = (session: string) => {
		for (const suffix of [".db", ".db-wal", ".db-shm"]) fs.writeFileSync(path.join(dir, session + suffix), suffix);
		fs.mkdirSync(path.join(brain, session));
		fs.writeFileSync(path.join(brain, session, "important.log"), "keep");
	};
	return { root, dir, brain, alive, store, create, advance: (ms: number) => { now += ms; } };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("only registered, replaced and expired sessions are removed; brain is retained", () => {
	const f = fixture();
	const owner = f.store(101), collector = f.store(202);
	const retired = id(1), active = id(2), foreign = id(3);
	for (const sid of [retired, active, foreign]) f.create(sid);
	f.alive.add(101);
	owner.created(retired); owner.created(active); owner.retire(retired); owner.retire(foreign);
	f.advance(SESSION_RETENTION_MS - 1);
	assert.equal(collector.sweep(), 0);
	f.advance(1);
	assert.equal(collector.sweep(), 0, "live owner holds its session through native background work");
	f.alive.delete(101);
	assert.equal(collector.sweep(), 1);
	for (const suffix of [".db", ".db-wal", ".db-shm"]) assert.equal(fs.existsSync(path.join(f.dir, retired + suffix)), false);
	assert.equal(fs.readFileSync(path.join(f.brain, retired, "important.log"), "utf8"), "keep");
	assert.ok(fs.existsSync(path.join(f.dir, active + ".db")), "unreplaced owned session stays");
	assert.ok(fs.existsSync(path.join(f.dir, foreign + ".db")), "unowned session stays");
});

test("a new process lease prevents collection even after the creator dies", () => {
	const f = fixture(); const sid = id(4);
	f.create(sid); f.alive.add(101); f.alive.add(102);
	const creator = f.store(101), resumer = f.store(102);
	creator.created(sid); creator.retire(sid);
	f.advance(SESSION_RETENTION_MS + 1);
	assert.equal(resumer.acquire(sid), true);
	f.alive.delete(101);
	assert.equal(f.store(103).sweep(), 0);
	assert.ok(fs.existsSync(path.join(f.dir, sid + ".db")));
	f.alive.delete(102);
	assert.equal(f.store(103).sweep(), 0, "a resumed checkpoint is current again");
	resumer.retire(sid);
	f.advance(SESSION_RETENTION_MS);
	assert.equal(f.store(103).sweep(), 0, "shared checkpoints are retained without a complete reference graph");
});


test("a lease acquired before ownership registration marks the checkpoint shared", () => {
	const f = fixture(), sid = id(41), creator = f.store(101), resumer = f.store(102);
	f.create(sid);
	assert.equal(resumer.acquire(sid), true);
	creator.created(sid); creator.retire(sid);
	f.advance(SESSION_RETENTION_MS * 2);
	assert.equal(f.store(103).sweep(), 0);
	assert.ok(fs.existsSync(path.join(f.dir, sid + ".db")));
});

test("an orphaned ACP server remains protected after its Pi process exits", () => {
	const f = fixture(), sid = id(40), owner = f.store(101);
	f.create(sid); f.alive.add(101); f.alive.add(201);
	owner.created(sid, 201); owner.retire(sid);
	f.advance(SESSION_RETENTION_MS);
	f.alive.delete(101);
	assert.equal(f.store(102).sweep(), 0, "the ACP server can still access the database");
	f.alive.delete(201);
	assert.equal(f.store(102).sweep(), 1);
});
test("retirement cannot be accelerated by repeated notifications", () => {
	const f = fixture(), sid = id(5), owner = f.store(1);
	f.create(sid); owner.created(sid); owner.retire(sid);
	f.advance(SESSION_RETENTION_MS - 10); owner.retire(sid);
	assert.equal(f.store(2).sweep(), 0);
	f.advance(10);
	assert.equal(f.store(2).sweep(), 1);
});

test("reject unsafe IDs and file types without touching their targets", () => {
	const f = fixture(), sid = id(6), owner = f.store(1);
	const target = path.join(f.root, "valuable"); fs.writeFileSync(target, "untouched");
	f.create(sid);
	owner.created("../../valuable"); owner.retire("../../valuable");
	owner.created(sid); owner.retire(sid);
	fs.unlinkSync(path.join(f.dir, sid + ".db"));
	fs.symlinkSync(target, path.join(f.dir, sid + ".db"));
	f.advance(SESSION_RETENTION_MS);
	assert.equal(f.store(2).sweep(), 0);
	assert.equal(fs.readFileSync(target, "utf8"), "untouched");
	fs.unlinkSync(path.join(f.dir, sid + ".db"));
	fs.linkSync(target, path.join(f.dir, sid + ".db"));
	assert.equal(f.store(2).sweep(), 0, "hardlinked databases are not removed");
	assert.equal(fs.readFileSync(target, "utf8"), "untouched");
});

test("partial deletion is retried after unsafe sidecars are fixed", () => {
	const f = fixture(), sid = id(7), owner = f.store(1);
	f.create(sid);
	owner.created(sid); owner.retire(sid);
	fs.writeFileSync(path.join(f.dir, sid + ".db-wal"), "remaining WAL");
	fs.unlinkSync(path.join(f.dir, sid + ".db-shm"));
	fs.mkdirSync(path.join(f.dir, sid + ".db-shm"));
	f.advance(SESSION_RETENTION_MS);
	assert.equal(f.store(2).sweep(), 0);
	assert.ok(fs.existsSync(path.join(f.dir, sid + ".db-wal")));
	fs.rmdirSync(path.join(f.dir, sid + ".db-shm"));
	assert.equal(f.store(2).sweep(), 1);
	assert.equal(fs.existsSync(path.join(f.dir, sid + ".db-wal")), false);
});


test("interrupted unlink leaves a tombstone and retries without reopening a partial database", async () => {
	const f = fixture(), sid = id(71), owner = f.store(1);
	f.create(sid); owner.created(sid); owner.retire(sid);
	f.advance(SESSION_RETENTION_MS);
	const original = fs.unlinkSync;
	const { vi } = await import("vitest");
	const failure = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
		if (String(file) === path.join(f.dir, sid + ".db-wal")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		return original(file);
	});
	try {
		assert.equal(f.store(2).sweep(), 0);
		assert.equal(fs.existsSync(path.join(f.dir, sid + ".db")), false);
		assert.equal(f.store(3).acquire(sid), false, "partial database is not reopened");
	} finally { failure.mockRestore(); }
	assert.equal(f.store(2).sweep(), 1);
	assert.equal(fs.existsSync(path.join(f.dir, sid + ".db-wal")), false);
});

test("replacement database and recently modified files are not cleaned", () => {
	const f = fixture(), sid = id(72), owner = f.store(1);
	f.create(sid); owner.created(sid); owner.retire(sid);
	const original = path.join(f.dir, sid + ".db");
	fs.renameSync(original, original + ".old");
	fs.writeFileSync(original, "a different database");
	f.advance(SESSION_RETENTION_MS);
	assert.equal(f.store(2).sweep(), 0);
	assert.equal(fs.readFileSync(original, "utf8"), "a different database");
});

test("recently changed SQLite sidecars defer collection for another retention interval", () => {
	const f = fixture(), sid = id(73), owner = f.store(1);
	f.create(sid); owner.created(sid); owner.retire(sid);
	const changedAt = 1_800_000_005;
	fs.utimesSync(path.join(f.dir, sid + ".db-wal"), changedAt, changedAt);
	f.advance(SESSION_RETENTION_MS);
	assert.equal(f.store(2).sweep(), 0);
	f.advance(5000);
	assert.equal(f.store(2).sweep(), 1);
});
test("a locked or symlinked ledger fails closed", () => {
	const f = fixture(), sid = id(8), owner = f.store(1);
	const target = path.join(f.root, "unrelated"); fs.writeFileSync(target, "do not touch");
	fs.symlinkSync(target, path.join(f.root, ".realagy-session-ownership-v2.sqlite"));
	assert.equal(owner.acquire(sid), false);
	owner.created(sid); owner.retire(sid);
	assert.equal(owner.sweep(), 0);
	assert.equal(fs.readFileSync(target, "utf8"), "do not touch");
});

test("a lease held by a real live process survives another process's sweep", () => {
	const f = fixture(), sid = id(9);
	const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	assert.equal(child.status, 0);
	const exitedPid = Number(child.stdout);
	f.create(sid);
	const deadOwner = new SessionRetention({ conversationsDir: f.dir, pid: exitedPid, now: () => 1_800_000_000_000 });
	deadOwner.created(sid); deadOwner.retire(sid);
	const current = new SessionRetention({ conversationsDir: f.dir, now: () => 1_800_000_000_000 + SESSION_RETENTION_MS });
	assert.equal(current.acquire(sid), true);
	assert.equal(current.sweep(), 0);
	assert.ok(fs.existsSync(path.join(f.dir, sid + ".db")));
});


test("SQLite serializes cleanup against another process holding the ledger lock", async () => {
	const f = fixture(), sid = id(10), owner = f.store(1);
	f.create(sid); owner.created(sid); owner.retire(sid);
	f.advance(SESSION_RETENTION_MS);
	const ledger = path.join(f.root, ".realagy-session-ownership-v2.sqlite");
	const script = 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);db.exec("BEGIN IMMEDIATE");console.log("LOCKED");process.stdin.once("data",()=>{db.exec("ROLLBACK");db.close();process.exit(0)});';
	const child = spawn(process.execPath, ["-e", script, ledger], { stdio: ["pipe", "pipe", "pipe"] });
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	try {
		const ready = await new Promise<string>((resolve, reject) => {
			child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`lock holder exited before ready: ${code}`)));
		});
		assert.match(ready, /LOCKED/);
		assert.equal(f.store(2).sweep(), 0, "a busy ledger never deletes");
		assert.equal(f.store(2).acquire(sid), false, "resume fails closed instead of racing cleanup");
		assert.ok(fs.existsSync(path.join(f.dir, sid + ".db")));
	} finally {
		child.stdin.end("release\n");
		assert.equal(await exited, 0);
	}
	assert.equal(f.store(2).sweep(), 1);
});


test("a checkpoint resumed by another live process is protected after both processes exit", async () => {
	const f = fixture(), sid = id(11);
	f.create(sid);
	const base = 1_800_000_000_000;
	const creator = new SessionRetention({ conversationsDir: f.dir, pid: 2147483646, now: () => base });
	creator.created(sid); creator.retire(sid);
	const module = path.resolve("src/acp/session-retention.ts");
	const source = `import {SessionRetention} from ${JSON.stringify(module)}; const s=new SessionRetention({conversationsDir:${JSON.stringify(f.dir)}}); console.log(s.acquire(${JSON.stringify(sid)}) ? 'ACQUIRED' : 'FAILED'); process.stdin.once('data',()=>process.exit(0));`;
	const child = spawn("bun", ["-e", source], { stdio: ["pipe", "pipe", "pipe"] });
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	try {
		const ready = await new Promise<string>((resolve, reject) => {
			child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`lease holder exited before ready: ${code}`)));
		});
		assert.match(ready, /ACQUIRED/);
		creator.retire(sid);
		const collector = new SessionRetention({ conversationsDir: f.dir, now: () => base + SESSION_RETENTION_MS * 2 });
		assert.equal(collector.sweep(), 0);
	} finally {
		child.stdin.end("release\n");
		assert.equal(await exited, 0);
	}
	creator.retire(sid);
	const collector = new SessionRetention({ conversationsDir: f.dir, now: () => base + SESSION_RETENTION_MS * 3 });
	assert.equal(collector.sweep(), 0, "another Pi session may still persist the checkpoint");
	assert.ok(fs.existsSync(path.join(f.dir, sid + ".db")));
});
