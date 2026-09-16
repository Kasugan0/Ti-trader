import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withFileLockSync, writeJsonFileDurable } from "@nikopack/ti-trading-engine";

/** Private application data, not a filesystem tool exposed to the model. */
export class PrivateStore<T> {
	readonly path: string;
	private readonly initial: () => T;
	private readonly validate: (value: unknown) => asserts value is T;
	private readonly maxBytes: number;

	constructor(path: string, initial: () => T, validate: (value: unknown) => asserts value is T, maxBytes: number) {
		this.path = resolve(path);
		this.initial = initial;
		this.validate = validate;
		this.maxBytes = maxBytes;
	}

	private guard(): void {
		for (let path = this.path; ; path = dirname(path)) {
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (stat?.isSymbolicLink()) throw new Error("Private state cannot use symbolic links");
			if (path !== this.path && stat && !stat.isDirectory()) throw new Error("Invalid private state directory");
			if (dirname(path) === path) break;
		}
	}

	read(): T {
		this.guard();
		let fd: number;
		try {
			fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return this.initial();
			throw error;
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > this.maxBytes) throw new Error("Private state exceeds its storage limit");
			const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
			this.validate(value);
			return value;
		} finally {
			closeSync(fd);
		}
	}

	transact<R>(operation: (state: T) => R): R {
		this.guard();
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		return withFileLockSync(
			`${this.path}.lock`,
			() => {
				const state = this.read();
				const result = operation(state);
				if (result instanceof Promise) throw new Error("Private store transactions must be synchronous");
				this.validate(state);
				if (Buffer.byteLength(JSON.stringify(state), "utf8") > this.maxBytes)
					throw new Error("Private state capacity reached; export evidence and review retention limits");
				writeJsonFileDurable(this.path, state, 0o600);
				return result;
			},
			{ staleMs: Number.POSITIVE_INFINITY, reclaimDeadOwner: true },
		);
	}

	export(name: string, data: unknown, maxBytes = this.maxBytes): string {
		if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw new Error("Invalid export identifier");
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.maxBytes * 4)
			throw new Error("Invalid private export capacity");
		const path = join(dirname(this.path), "exports", `${name}.json`);
		const target = new PrivateStore<unknown>(
			path,
			() => undefined,
			(_value): asserts _value is unknown => {},
			maxBytes,
		);
		target.guard();
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		withFileLockSync(
			`${path}.lock`,
			() => {
				target.guard();
				if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("Export already exists");
				if (Buffer.byteLength(JSON.stringify(data), "utf8") > maxBytes)
					throw new Error("Export exceeds storage limit");
				writeJsonFileDurable(path, data, 0o600);
			},
			{ staleMs: Number.POSITIVE_INFINITY, reclaimDeadOwner: true },
		);
		return path;
	}
}
