/*
 * Proves the automatic part of the flow: if the user already has a
 * tab open for the AI, the extension's real background.js code
 * reuses it instead of opening a duplicate - and only opens a new tab
 * when nothing matches. Runs the shipping background.js, not a
 * rewritten stand-in.
 *
 *   node tests/test-tab-reuse.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "chrome-extension");


function startBackground(existingTabs) {

    const created = [];

    const context = {
        console: { log: () => {}, warn: () => {}, error: () => {} },
        URL,
        TextDecoder,
        TextEncoder,
        WebSocket: function () {},
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
        clearTimeout,
        setInterval: () => 0,
        clearInterval: () => {},
        Date,
        fetch: async () => ({ ok: true, text: async () => "" }),
        chrome: {
            runtime: {
                getContexts: async () => [],
                sendMessage: async () => ({ success: true }),
                onMessage: { addListener: () => {} },
                onInstalled: { addListener: () => {} },
                onStartup: { addListener: () => {} },
                getPlatformInfo: (cb) => cb && cb({}),
            },
            offscreen: {
                createDocument: async () => {},
                closeDocument: async () => {},
            },
            downloads: { download: async () => {} },
            storage: {
                local: {
                    get: (keys, cb) => cb && cb({}),
                    set: () => {},
                    remove: () => {},
                },
                onChanged: { addListener: () => {} },
            },
            tabs: {
                query: async () => existingTabs,
                create: async (options) => {
                    const tab = { id: 900 + created.length, url: options.url };
                    created.push(tab);
                    return tab;
                },
                get: async (id) => ({ id, status: "complete" }),
                update: async (id) => ({ id }),
                remove: async () => {},
                sendMessage: async (tabId, message) => {

                    if (message.type === "get_status") {
                        return {
                            status: { inputFound: true, editorFound: true }
                        };
                    }

                    return { success: true };
                },
                onRemoved: { addListener: () => {} },
                onUpdated: { addListener: () => {} },
            },
            scripting: { executeScript: async () => {} },
            debugger: {
                attach: async () => {},
                detach: async () => {},
                sendCommand: async () => {},
                onDetach: { addListener: () => {} },
            },
            action: { onClicked: { addListener: () => {} } },
            alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
        },
    };

    context.self = context;

    context.importScripts = (...files) => {
        files.forEach((file) => {
            vm.runInContext(
                fs.readFileSync(path.join(root, file), "utf8"),
                context,
                { filename: file }
            );
        });
    };

    vm.createContext(context);

    vm.runInContext(
        fs.readFileSync(path.join(root, "background.js"), "utf8"),
        context,
        { filename: "background.js" }
    );

    vm.runInContext("this.helperTabFor = helperTabFor;", context);

    return { background: context, created };
}


async function main() {

    const problems = [];

    /* An AI tab is already open. */
    const already = [
        { id: 55, url: "https://claude.ai/chat/an-existing-conversation" },
    ];

    const reuse = startBackground(already);

    const claudeTab = await reuse.background.helperTabFor("claude");

    if (claudeTab !== 55) {
        problems.push(
            "an already-open Claude tab was not reused (got " +
            claudeTab + ")"
        );
    }

    if (reuse.created.length !== 0) {
        problems.push(
            "a new tab was opened even though a matching one was " +
            "already open: " + JSON.stringify(reuse.created)
        );
    }

    /* Nothing open yet - it must fall back to opening a tab. */
    const fresh = startBackground([]);

    const newClaudeTab = await fresh.background.helperTabFor("claude");

    if (fresh.created.length !== 1) {
        problems.push(
            "no tab was opened when none was already open"
        );
    } else if (newClaudeTab !== fresh.created[0].id) {
        problems.push("the newly opened tab was not the one returned");
    }

    if (problems.length) {
        console.log("FAILED:");
        problems.forEach(problem => console.log("  - " + problem));
        return 1;
    }

    console.log(
        "reused an already-open AI tab, and opened a fresh tab only " +
        "when nothing was already open"
    );
    return 0;
}


main().then(code => process.exit(code)).catch((error) => {
    console.error("CRASHED:", error.message);
    console.error(String(error.stack).split("\n").slice(1, 5).join("\n"));
    process.exit(1);
});
