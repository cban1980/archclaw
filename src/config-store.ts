import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Document, parseDocument } from "yaml";
import { type AppConfig, type Config, type SceneConfig, normalize, parseConfig, refsOf, appOfRef } from "./config.ts";

const KEEP_HISTORY = 30;

/**
 * The live config, plus the edits Claude can make to it. Every edit is validated before
 * it is written, keeps the file's comments, and saves the previous version so it can be
 * undone (`history/` in the state directory). Edits apply immediately; no restart.
 */
export class ConfigStore {
    readonly path: string;
    readonly historyDir: string;
    #config: Config;

    constructor(path: string, stateDir: string) {
        this.path = path;
        this.historyDir = join(stateDir, "config-history");
        this.#config = this.#read().config;
    }

    get config(): Config {
        return this.#config;
    }

    /** Re-reads the file (e.g. after a hand edit). Keeps the old config if the file is invalid. */
    reload(): Config {
        this.#config = this.#read().config;
        return this.#config;
    }

    #read() {
        const text = readFileSync(this.path, "utf8");
        const doc = parseDocument(text);
        if (doc.errors.length) throw new Error(`cannot parse ${this.path}: ${doc.errors[0]!.message}`);
        return { text, doc, config: parseConfig(doc.toJS(), `config ${this.path}`) };
    }

    #edit(summary: string, change: (doc: Document, config: Config) => void): Config {
        const { text, doc, config } = this.#read();
        change(doc, config);
        const next = parseConfig(doc.toJS(), "change");
        mkdirSync(this.historyDir, { recursive: true, mode: 0o700 });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(this.historyDir, `${stamp}.yaml`), `# before: ${summary.replace(/\n/g, " ")}\n${text}`, { mode: 0o600 });
        this.#prune();
        this.#write(doc.toString());
        this.#config = next;
        return next;
    }

    #write(text: string) {
        mkdirSync(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        writeFileSync(tmp, text, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.path);
    }

    #prune() {
        const files = this.#historyFiles();
        for (const f of files.slice(0, Math.max(0, files.length - KEEP_HISTORY))) rmSync(join(this.historyDir, f), { force: true });
    }

    #historyFiles(): string[] {
        return existsSync(this.historyDir) ? readdirSync(this.historyDir).filter(f => f.endsWith(".yaml")).sort() : [];
    }

    /** Earlier versions, newest first, with what each change was. */
    history(): Array<{ id: string; before: string }> {
        return this.#historyFiles()
            .reverse()
            .map(f => ({ id: f.replace(/\.yaml$/, ""), before: readFileSync(join(this.historyDir, f), "utf8").split("\n", 1)[0]!.replace(/^# before: /, "") }));
    }

    /** Restores the version from before the latest change. */
    undo(): string {
        const last = this.#historyFiles().at(-1);
        if (!last) throw new Error("nothing to undo");
        const file = join(this.historyDir, last);
        const text = readFileSync(file, "utf8").replace(/^# before: .*\n/, "");
        const summary = readFileSync(file, "utf8").split("\n", 1)[0]!.replace(/^# before: /, "");
        this.#config = parseConfig(parseDocument(text).toJS(), "previous config");
        this.#write(text);
        rmSync(file);
        return summary;
    }

    saveApp(key: string, app: AppConfig): Config {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error("app keys are lower-case letters, digits and dashes, e.g. work-pc");
        return this.#edit(`save app ${key}`, doc => {
            const clean = Object.fromEntries(Object.entries(app).filter(([, v]) => v !== undefined));
            doc.setIn(["apps", key], doc.createNode(clean));
        });
    }

    deleteApp(key: string): Config {
        return this.#edit(`delete app ${key}`, (doc, config) => {
            if (!config.apps[key]) throw new Error(`no app "${key}"`);
            const users = config.scenes.filter(s => refsOf(s).some(r => appOfRef(r) === key)).map(s => s.name);
            if (users.length) throw new Error(`app "${key}" is used by scene(s) ${users.join(", ")}; change those first`);
            if (config.spotify.app === key && config.spotify.clientId) throw new Error(`app "${key}" is the Spotify app (spotify.app)`);
            doc.deleteIn(["apps", key]);
        });
    }

    /** Adds a scene, or replaces the one with the same name. */
    saveScene(scene: SceneConfig): Config {
        return this.#edit(`save scene ${scene.name}`, (doc, config) => {
            const clean = Object.fromEntries(
                Object.entries(scene).filter(([k, v]) => v !== undefined && !(k === "aliases" && Array.isArray(v) && !v.length)),
            );
            const i = config.scenes.findIndex(s => normalize(s.name) === normalize(scene.name));
            if (i >= 0) doc.setIn(["scenes", i], doc.createNode(clean));
            else if (doc.hasIn(["scenes"])) doc.addIn(["scenes"], doc.createNode(clean));
            else doc.setIn(["scenes"], doc.createNode([clean]));
        });
    }

    deleteScene(name: string): Config {
        return this.#edit(`delete scene ${name}`, (doc, config) => {
            const i = config.scenes.findIndex(s => normalize(s.name) === normalize(name));
            if (i < 0) throw new Error(`no scene "${name}"`);
            doc.deleteIn(["scenes", i]);
        });
    }

    /** Names a monitor ("left" → HDMI-A-1), or removes the name when `monitor` is undefined. */
    setScreen(name: string, monitor: string | undefined): Config {
        return this.#edit(`${monitor ? "set" : "remove"} screen ${name}`, doc => {
            if (monitor) doc.setIn(["screens", name], monitor);
            else doc.deleteIn(["screens", name]);
        });
    }

    setNotes(notes: string): Config {
        return this.#edit("update notes", doc => {
            doc.setIn(["notes"], notes);
        });
    }
}
