/*
 * Proves the real background.js's cleanAnswer keeps a genuinely
 * list-shaped reply as a list instead of flattening it into one
 * run-on sentence - the same fix as tests/test_prompts.py, mirrored
 * here because the extension carries its own copy of this logic for
 * its own (currently unreached from the popup) run-a-workbook path.
 *
 *   node tests/test-answer-shape.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "chrome-extension");


function loadCleaner() {

    const context = {
        console: { log: () => {}, warn: () => {}, error: () => {} },
        URL,
        TextDecoder,
        TextEncoder,
        WebSocket: function () {},
        setTimeout: () => 0,
        clearTimeout: () => {},
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
                query: async () => [],
                create: async () => ({ id: 1 }),
                get: async () => ({ id: 1, status: "complete" }),
                update: async () => ({ id: 1 }),
                remove: async () => {},
                sendMessage: async () => ({ success: true }),
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

    vm.runInContext("this.cleanAnswer = cleanAnswer;", context);

    return context.cleanAnswer;
}


function main() {

    const clean = loadCleaner();

    const problems = [];

    const numberedReply =
        "Sure, here's the answer:\n\n" +
        "1. First point about the topic.\n" +
        "2. Second point about the topic.\n" +
        "3. Third point about the topic.";

    const cleanedNumbered = clean(numberedReply);

    if (!("\n" + cleanedNumbered).includes("\n1. First point")) {
        problems.push(
            "a numbered list was not kept as separate lines: " +
            JSON.stringify(cleanedNumbered)
        );
    }

    if ((cleanedNumbered.match(/\n/g) || []).length < 2) {
        problems.push(
            "a 3-item list collapsed onto fewer than 3 lines: " +
            JSON.stringify(cleanedNumbered)
        );
    }

    const bulletedReply = "- Apples\n- Oranges\n- Pears";

    const cleanedBullets = clean(bulletedReply);

    if ((cleanedBullets.match(/\n/g) || []).length < 2) {
        problems.push(
            "a 3-item bullet list collapsed: " +
            JSON.stringify(cleanedBullets)
        );
    }

    const wrappedProse =
        "This is a single explanation that a chat model has\n" +
        "wrapped across several lines even though it is really\n" +
        "just one flowing sentence about the topic.";

    const cleanedProse = clean(wrappedProse);

    if (cleanedProse.includes("\n")) {
        problems.push(
            "a wrapped prose paragraph was not rejoined into one " +
            "line: " + JSON.stringify(cleanedProse)
        );
    }

    if (!cleanedProse.includes("wrapped across several lines")) {
        problems.push(
            "wrapped prose lost words when rejoined: " +
            JSON.stringify(cleanedProse)
        );
    }

    const fillerThenAnswer =
        "Certainly, here's the answer:\n\nThe answer is 42.";

    const cleanedSingle = clean(fillerThenAnswer);

    if (cleanedSingle !== "The answer is 42.") {
        problems.push(
            "chat filler was not stripped from a short answer: " +
            JSON.stringify(cleanedSingle)
        );
    }

    if (problems.length) {
        console.log("FAILED:");
        problems.forEach(problem => console.log("  - " + problem));
        return 1;
    }

    console.log(
        "a list-shaped reply stays a list, and a wrapped prose reply " +
        "still becomes one flowing sentence"
    );
    return 0;
}


process.exit(main());
