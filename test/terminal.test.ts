import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sshHosts, terminalAction } from "../src/terminal.ts";

const ran: string[] = [];
const exec = {
    sh: async (c: string) => (ran.push(c), 0),
    test: async (c: string) => /command -v (btop|nvim)\b/.test(c),
    capture: async () => "[]",
};
const ctx = { exec, log: { info() {}, warn() {}, error() {} }, cancelPending: () => 0 };

test("ssh hosts come from ~/.ssh/config, without wildcards", () => {
    const p = join(mkdtempSync(join(tmpdir(), "archclaw-")), "config");
    writeFileSync(p, "Host *\n  ForwardAgent no\nHost home.example.net work\n  User me\nhost pi\n");
    assert.deepEqual(sshHosts(p), ["home.example.net", "work", "pi"]);
});

test("only installed built-ins or the owner's programs run, with a fixed command line", async () => {
    ran.length = 0;
    await (await terminalAction({ program: "btop" }, exec, {})).run(ctx);
    assert.match(ran.at(-1)!, /xdg-terminal-exec --app-id=org\.omarchy\.archclaw-btop -e btop /);

    await (await terminalAction({ program: "Logs" }, exec, { logs: "journalctl -f" })).run(ctx);
    assert.match(ran.at(-1)!, /-e journalctl -f /);

    await assert.rejects(terminalAction({ program: "poweroff" }, exec, {}), /isn't allowed/);
    await assert.rejects(terminalAction({ program: "htop" }, exec, {}), /isn't allowed or installed/); // not installed here
    await assert.rejects(terminalAction({ program: "btop; rm -rf ~" }, exec, {}), /isn't allowed/);
});

test("directories must exist inside home; ssh hosts must be known", async () => {
    ran.length = 0;
    await (await terminalAction({ dir: "~" }, exec, {})).run(ctx);
    assert.ok(ran.at(-1)!.includes(`--dir='${homedir()}'`));
    await assert.rejects(terminalAction({ dir: "/etc" }, exec, {}), /inside your home/);
    await assert.rejects(terminalAction({ ssh: "evil.example; id" }, exec, {}), /isn't a host/);
    await assert.rejects(terminalAction({ program: "btop", ssh: "x" }, exec, {}), /not both/);
});

test("free-form commands: visible, as the user, never sudo, quoted through the environment", async () => {
    const { commandAction } = await import("../src/terminal.ts");
    ran.length = 0;
    await commandAction({ command: `echo "it's $HOME"; ls`, mode: "allow" }).run(ctx);
    const launch = ran.find(c => c.includes("xdg-terminal-exec"))!;
    assert.match(launch, /env ARCHCLAW_CMD='echo "it'\\''s \$HOME"; ls' /);
    assert.match(launch, /bash -lc "\$ARCHCLAW_CMD"/);
    assert.ok(!launch.includes("Press Enter"), "allow runs directly");
    ran.length = 0;
    await commandAction({ command: "ls", mode: "confirm" }).run(ctx);
    assert.ok(ran.some(c => c.includes("Press Enter")), "confirm waits");
    for (const bad of ["sudo rm -rf /", "ls; sudo reboot", "echo $(doas id)", "pkexec x"]) {
        assert.throws(() => commandAction({ command: bad, mode: "allow" }), /sudo/, bad);
    }
    assert.throws(() => commandAction({ command: "ls", dir: "/etc", mode: "allow" }), /inside your home/);
});
