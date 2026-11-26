import { spawn } from "node:child_process";
import type { Logger } from "./log.ts";

export type Executor = {
    /** Runs a shell command line. Resolves with the exit code. */
    sh(command: string): Promise<number>;
    /** Runs a read-only check quietly (also in dry-run). Resolves true on exit 0. */
    test(command: string): Promise<boolean>;
    /** Runs a read-only command quietly (also in dry-run) and returns its stdout. */
    capture(command: string): Promise<string>;
};

export function createExecutor(log: Logger, opts: { dryRun?: boolean; timeoutMs?: number } = {}): Executor {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return {
        test(command) {
            return new Promise(resolve => {
                const child = spawn("sh", ["-c", command], { stdio: "ignore" });
                const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
                child.on("error", () => (clearTimeout(timer), resolve(false)));
                child.on("exit", code => (clearTimeout(timer), resolve(code === 0)));
            });
        },
        capture(command) {
            return new Promise(resolve => {
                const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "ignore"] });
                let out = "";
                child.stdout.on("data", d => (out += d));
                const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
                child.on("error", () => (clearTimeout(timer), resolve("")));
                child.on("exit", () => (clearTimeout(timer), resolve(out)));
            });
        },
        sh(command) {
            if (opts.dryRun) {
                log.info(`[dry-run] would run: ${command}`);
                return Promise.resolve(0);
            }
            log.info(`run: ${command}`);
            return new Promise(resolve => {
                const child = spawn("sh", ["-c", command], { stdio: ["ignore", "inherit", "inherit"] });
                const timer = setTimeout(() => {
                    log.warn(`timed out after ${timeoutMs} ms: ${command}`);
                    child.kill("SIGTERM");
                }, timeoutMs);
                child.on("error", err => {
                    clearTimeout(timer);
                    log.error(`failed to start: ${err.message}`);
                    resolve(127);
                });
                child.on("exit", code => {
                    clearTimeout(timer);
                    if (code) log.warn(`exit ${code}: ${command}`);
                    resolve(code ?? 1);
                });
            });
        },
    };
}
