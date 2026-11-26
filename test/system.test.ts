import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { SYSTEM_OPS, SYSTEM_TOPICS, systemCommand, systemInfo } from "../src/system.ts";

const exec = {
    sh: async () => 0,
    test: async (c: string) => /pacman -Si 'btop'|pacman -Qq 'btop'|systemctl --user cat 'syncthing.service'|pgrep .* -x 'firefox'/.test(c),
    capture: async (c: string) => (c.startsWith("id -un") ? "me\n" : c.startsWith("ps -o user=") ? (c.includes(" 4242") ? "me\n" : "root\n") : "ok"),
};
const ctx = { exec };

test("arguments are validated and quoted", async () => {
    assert.match(await systemCommand("service.restart", "syncthing", ctx), /systemctl --user restart 'syncthing.service'/);
    await assert.rejects(systemCommand("service.stop", "sshd", ctx), /no user service/);
    await assert.rejects(systemCommand("service.stop", "x; reboot", ctx), /isn't a unit name/);
    assert.equal(await systemCommand("process.end", "4242", ctx), "kill -TERM 4242");
    await assert.rejects(systemCommand("process.end", "1", ctx), /PID or process name/);
    await assert.rejects(systemCommand("process.end", "4343", ctx), /belongs to root/);
    await assert.rejects(systemCommand("process.end", "Hyprland", ctx), /depends on it/);
    assert.match(await systemCommand("process.end", "firefox", ctx), /pkill -TERM -u 'me' -x 'firefox'/);
    assert.match(await systemCommand("package.install", "btop", ctx), /xdg-terminal-exec .* -e bash -c .*sudo pacman -S/);
    await assert.rejects(systemCommand("package.install", "Bad Name!", ctx), /package name/);
    await assert.rejects(systemCommand("package.remove", "notinstalled", ctx), /isn't installed/);
    assert.match(await systemCommand("open", "https://archlinux.org/news/", ctx), /xdg-open 'https:\/\/archlinux.org\/news\/'/);
    await assert.rejects(systemCommand("open", "/etc/passwd", ctx), /home directory/);
    assert.match(await systemCommand("open", homedir(), ctx), /xdg-open/);
    assert.match(await systemCommand("clipboard", "it's here", ctx), /printf %s 'it'\\''s here' \| wl-copy/);
    await assert.rejects(systemCommand("updates.install", "now", ctx), /takes no argument/);
});

test("topics validate their arguments", async () => {
    await assert.rejects(systemInfo("package.info", "$(id)", ctx), /package name/);
    await assert.rejects(systemInfo("disk.usage", "/etc", ctx), /home directory/);
    await assert.rejects(systemInfo("nope", undefined, ctx), /unknown topic/);
    assert.equal(typeof (await systemInfo("package.info", "btop", ctx)), "string");
});

test("every topic and operation documents itself", () => {
    for (const [id, t] of [...Object.entries(SYSTEM_TOPICS), ...Object.entries(SYSTEM_OPS)]) assert.ok(t.description.length > 10, id);
});
