export type Logger = {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
};

export function createLogger(scope: string): Logger {
    // journald adds timestamps, so keep lines short.
    const fmt = (level: string, msg: string) => `${level.padEnd(5)} ${scope}: ${msg}`;
    return {
        info: msg => console.log(fmt("INFO", msg)),
        warn: msg => console.warn(fmt("WARN", msg)),
        error: msg => console.error(fmt("ERROR", msg)),
    };
}
