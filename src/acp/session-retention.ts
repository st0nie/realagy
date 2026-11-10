// Ownership and cross-process leases for realagy-created ACP conversation databases.
// This ledger deliberately never infers ownership from agy's shared data directory.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LEDGER_NAME = ".realagy-session-ownership-v2.sqlite";
type Sqlite = typeof import("node:sqlite");

type Options = {
	conversationsDir: string;
	now?: () => number;
	pid?: number;
	owner?: string;
	isAlive?: (pid: number) => boolean;
	log?: (message: string, data?: unknown) => void;
};

/** Unknown or permission-denied PIDs count as alive: uncertainty must not delete data. */
function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function sqliteModule(): Sqlite {
	const warning = process.emitWarning;
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	try { return createRequire(import.meta.url)("node:sqlite") as Sqlite; }
	finally { process.emitWarning = warning; }
}

/** A process holds its leases until it exits, including after an ACP restart or
 * extension reload. This deliberately protects native background work and avoids
 * depending on asynchronous process teardown or PID reuse for correctness. */
export class SessionRetention {
	readonly #dir: string;
	readonly #ledger: string;
	readonly #owner: string;
	readonly #pid: number;
	readonly #now: () => number;
	readonly #alive: (pid: number) => boolean;
	readonly #log?: Options["log"];

	constructor(options: Options) {
		this.#dir = path.resolve(options.conversationsDir);
		this.#ledger = path.join(path.dirname(this.#dir), LEDGER_NAME);
		this.#owner = options.owner ?? randomUUID();
		this.#pid = options.pid ?? process.pid;
		this.#now = options.now ?? Date.now;
		this.#alive = options.isAlive ?? processAlive;
		this.#log = options.log;
	}

	/** Run one atomic operation. On any error, conservatively skip cleanup/reuse. */
	#transaction<T>(action: (db: import("node:sqlite").DatabaseSync) => T): T | undefined {
		let db: import("node:sqlite").DatabaseSync | undefined;
		try {
			const dir = fs.lstatSync(this.#dir);
			if (!dir.isDirectory() || dir.isSymbolicLink()) return undefined;
			for (const suffix of ["", "-wal", "-shm"]) {
				try {
					const file = fs.lstatSync(this.#ledger + suffix);
					if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) return undefined;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			db = new (sqliteModule().DatabaseSync)(this.#ledger);
			fs.chmodSync(this.#ledger, 0o600);
			db.exec("PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, retired_at INTEGER, dev TEXT NOT NULL, ino TEXT NOT NULL, creator TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, deleting INTEGER NOT NULL DEFAULT 0, wal_identity TEXT, shm_identity TEXT); CREATE TABLE IF NOT EXISTS leases (id TEXT NOT NULL, owner TEXT NOT NULL, pid INTEGER NOT NULL, server_pid INTEGER, PRIMARY KEY(id, owner)); BEGIN IMMEDIATE;");
			const result = action(db);
			db.exec("COMMIT");
			return result;
		} catch (error) {
			try { db?.exec("ROLLBACK"); } catch { /* no transaction or rollback failed */ }
			this.#log?.("session-retention-error", { message: error instanceof Error ? error.message : String(error) });
			return undefined;
		} finally { try { db?.close(); } catch { /* best effort */ } }
	}

	/** Register only IDs returned by session/new. Never overwrite an existing record. */
	created(id: string, serverPid?: number): void {
		if (!SESSION_ID.test(id)) return;
		try {
			const stat = fs.lstatSync(path.join(this.#dir, `${id}.db`), { bigint: true });
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return;
			this.#transaction((db) => {
				db.prepare("INSERT OR IGNORE INTO sessions (id, retired_at, dev, ino, creator, shared) VALUES (?, NULL, ?, ?, ?, EXISTS (SELECT 1 FROM leases WHERE id = ? AND owner NOT LIKE ?))")
					.run(id, String(stat.dev), String(stat.ino), this.#owner, id, `${this.#owner}:%`);
				this.#lease(db, id, serverPid);
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#log?.("session-ownership-error", { sessionId: id });
		}
	}

	/** Acquire before checking or reopening a checkpoint, serialized with cleanup.
	 * Unknown IDs are not adopted, but still get a lease so a concurrent owner
	 * registration cannot race their use. Failure means caller must not reopen. */
	acquire(id: string, serverPid?: number): boolean {
		if (!SESSION_ID.test(id)) return false;
		return this.#transaction((db) => {
			const entry = db.prepare("SELECT deleting FROM sessions WHERE id = ?").get(id) as { deleting: number } | undefined;
			if (entry?.deleting) return false;
			this.#lease(db, id, serverPid);
			// A second runtime may have persisted this checkpoint independently.
			// Without a complete cross-session reference graph it can never be
			// proven unreferenced, even after that process exits: retain it.
			db.prepare("UPDATE sessions SET retired_at = NULL, shared = CASE WHEN creator <> ? THEN 1 ELSE shared END WHERE id = ?").run(this.#owner, id);
			return true;
		}) === true;
	}

	#lease(db: import("node:sqlite").DatabaseSync, id: string, serverPid?: number): void {
		const child = typeof serverPid === "number" && Number.isSafeInteger(serverPid) && serverPid > 0 ? serverPid : null;
		db.prepare("INSERT OR REPLACE INTO leases (id, owner, pid, server_pid) VALUES (?, ?, ?, ?)")
			.run(id, `${this.#owner}:${child ?? 0}`, this.#pid, child);
	}

	/** Only a known-owned session can be retired, after its replacement succeeds. */
	retire(id: string): void {
		if (!SESSION_ID.test(id)) return;
		this.#transaction((db) => {
			db.prepare("UPDATE sessions SET retired_at = COALESCE(retired_at, ?) WHERE id = ? AND shared = 0").run(this.#now(), id);
		});
	}

	/** Mark eligible sessions for deletion in a committed transaction before
	 * unlinking anything. Interrupted deletion remains a tombstone, so resume
	 * cannot reopen a partially deleted SQLite database. */
	sweep(): number {
		const cutoff = this.#now() - SESSION_RETENTION_MS;
		const marked = this.#transaction((db) => {
			const leases = db.prepare("SELECT id, owner, pid, server_pid FROM leases").all() as Array<{ id: string; owner: string; pid: number; server_pid: number | null }>;
			for (const lease of leases) {
				const parentDead = Number.isSafeInteger(lease.pid) && lease.pid > 0 && !this.#alive(lease.pid);
				const serverDead = lease.server_pid === null || (Number.isSafeInteger(lease.server_pid) && lease.server_pid > 0 && !this.#alive(lease.server_pid));
				if (parentDead && serverDead) db.prepare("DELETE FROM leases WHERE id = ? AND owner = ? AND pid = ?").run(lease.id, lease.owner, lease.pid);
			}
			const candidates = db.prepare("SELECT id, dev, ino, deleting FROM sessions WHERE retired_at IS NOT NULL AND retired_at <= ? AND NOT EXISTS (SELECT 1 FROM leases WHERE leases.id = sessions.id)").all(cutoff) as Array<{ id: string; dev: string; ino: string; deleting: number }>;
			const ready: string[] = [];
			for (const candidate of candidates) {
				if (!SESSION_ID.test(candidate.id)) continue;
				if (!candidate.deleting) {
					try {
						const main = this.#identity(candidate.id, ".db", cutoff);
						if (main !== `${candidate.dev}:${candidate.ino}`) continue;
						const wal = this.#identity(candidate.id, ".db-wal", cutoff);
						const shm = this.#identity(candidate.id, ".db-shm", cutoff);
						db.prepare("UPDATE sessions SET deleting = 1, wal_identity = ?, shm_identity = ? WHERE id = ?").run(wal, shm, candidate.id);
					} catch { continue; }
				}
				ready.push(candidate.id);
			}
			return ready;
		});
		if (!marked) return 0;
		let removed = 0;
		for (const id of marked) {
			const success = this.#transaction((db) => {
				const row = db.prepare("SELECT dev, ino, wal_identity, shm_identity FROM sessions WHERE id = ? AND deleting = 1 AND NOT EXISTS (SELECT 1 FROM leases WHERE leases.id = sessions.id)").get(id) as { dev: string; ino: string; wal_identity: string | null; shm_identity: string | null } | undefined;
				if (!row || !this.#removeDatabase(id, [`${row.dev}:${row.ino}`, row.wal_identity, row.shm_identity], cutoff)) return false;
				db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
				return true;
			});
			if (success) removed++;
		}
		return removed;
	}

	/** Return a stable file identity, or null for a missing file. */
	#identity(id: string, suffix: string, cutoff: number): string | null {
		try {
			const stat = fs.lstatSync(path.join(this.#dir, id + suffix), { bigint: true });
			if (!stat.isFile() || stat.nlink !== 1n || stat.mtimeMs > BigInt(Math.floor(cutoff))) throw new Error("unsafe or recently modified session file");
			return `${stat.dev}:${stat.ino}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	#removeDatabase(id: string, expected: Array<string | null>, cutoff: number): boolean {
		const suffixes = [".db", ".db-wal", ".db-shm"];
		try {
			for (const [i, suffix] of suffixes.entries()) {
				const actual = this.#identity(id, suffix, cutoff);
				// Missing entries are safe to retry; newly appeared or replaced files are not.
				if (actual !== null && actual !== expected[i]) return false;
			}
			// Main DB first: a crash after this point makes resume fall back to replay.
			for (const suffix of suffixes) {
				try { fs.unlinkSync(path.join(this.#dir, id + suffix)); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			}
			this.#log?.("session-database-removed", { sessionId: id });
			return true;
		} catch (error) {
			this.#log?.("session-database-remove-failed", { sessionId: id, message: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}
}
