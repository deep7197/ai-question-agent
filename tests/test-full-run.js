/*
 * The extension answering a real workbook, all of its own code
 * running: the popup's file, the background worker, the offscreen
 * document, the zip reader, the question finder and the writer.
 *
 * Only the AI's own tab is stood in for - it replies with marked
 * placeholder text. Everything else is exactly what runs in Chrome.
 *
 *   node tests/test-full-run.js "<workbook.docx>"
 *
 * The answered file is written to your temp folder, and can be
 * opened in Word to see where everything landed.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const { DOMParser } = require("linkedom");

const root = path.join(__dirname, "..", "chrome-extension");


class XMLSerializer {
    serializeToString(node) {
        return node.toString();
    }
}


/* ---------------------------------------------------------------
 * The offscreen page, with a real DOM behind it
 * --------------------------------------------------------------- */

function startOffscreen() {

    let listener = null;

    const context = {
        console,
        DOMParser,
        XMLSerializer,
        TextDecoder,
        TextEncoder,
        Blob,
        Response,
        DecompressionStream,
        atob: (text) => Buffer.from(text, "base64").toString("binary"),
        btoa: (text) => Buffer.from(text, "binary").toString("base64"),
        URL,
        chrome: {
            runtime: {
                onMessage: {
                    addListener: (fn) => { listener = fn; }
                }
            }
        },
    };

    vm.createContext(context);

    ["docx-zip.js", "docx.js", "doc-reader.js", "offscreen.js"].forEach(
        (file) => {
            vm.runInContext(
                fs.readFileSync(path.join(root, file), "utf8"),
                context,
                { filename: file }
            );
        }
    );

    return (message) => new Promise((resolve) => {
        listener(message, null, resolve);
    });
}


/* ---------------------------------------------------------------
 * The background worker, with Chrome stood in for
 * --------------------------------------------------------------- */

function startBackground(offscreen, answers, downloads) {

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
                sendMessage: async (message) => {

                    if (message && message.target === "offscreen") {
                        return await offscreen(message);
                    }

                    return { success: true };
                },
                onMessage: { addListener: () => {} },
                onInstalled: { addListener: () => {} },
                onStartup: { addListener: () => {} },
                getPlatformInfo: (cb) => cb && cb({}),
            },
            offscreen: {
                createDocument: async () => {},
                closeDocument: async () => {},
            },
            downloads: {
                download: async (options) => { downloads.push(options); },
            },
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
                create: async () => ({ id: 7 }),
                get: async () => ({ id: 7, status: "complete" }),
                update: async () => ({ id: 7 }),
                remove: async () => {},
                sendMessage: async (tabId, message) => answers(message),
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

    vm.runInContext("this.runWorkbook = runWorkbook;", context);

    return context;
}


function pretendToBeTheAI(message) {

    if (message.type === "get_status") {
        return { status: { inputFound: true, editorFound: true } };
    }

    if (message.type !== "ask") {
        return { success: false, error: "unexpected request" };
    }

    const question = message.question;

    if (/one line per item/i.test(question)) {

        const items = question
            .split("Items:")[1]
            .split("\n\n")[0]
            .trim()
            .split("\n");

        const headers = (question.match(/covering every column: (.+)\./) ||
            [, ""])[1].split(",").map(part => part.trim());

        return {
            success: true,
            answer: items.map(item => (
                item + " | " + headers.map(
                    head => head + ": [TEST " + head + " of " +
                        item.replace(/^[0-9.\s]+/, "") + "]"
                ).join(" | ")
            )).join("\n"),
        };
    }

    if (/Yes or No/i.test(question)) {
        return { success: true, answer: "Yes" };
    }

    const number = (question.match(/Question ([^.\n]+)\./) || [, "?"])[1];

    return {
        success: true,
        answer: "[TEST answer for question " + number + "]",
    };
}


async function main() {

    const file = process.argv[2];

    if (!file || !fs.existsSync(file)) {
        console.log("no workbook given - skipping");
        return 0;
    }

    const bytes = fs.readFileSync(file);

    const downloads = [];

    const offscreen = startOffscreen();

    const background = startBackground(
        offscreen, pretendToBeTheAI, downloads
    );

    console.log("running the extension over %s\n",
        path.basename(file));

    const job = await background.runWorkbook({
        file: bytes.toString("base64"),
        fileName: path.basename(file),
        provider: "claude",
    });

    console.log("status  : %s", job.status);
    console.log("step    : %s", job.step);
    console.log("answered: %d of %d",
        job.results.filter(one => !one.error).length, job.total);

    job.results.filter(one => one.error).forEach((one) => {
        console.log("  not answered: %s - %s", one.number, one.error);
    });

    const problems = [];

    if (job.status !== "done") {
        problems.push("the run did not finish: " + (job.error || job.step));
    }

    if (downloads.length !== 1) {
        problems.push("nothing was downloaded");
    }

    /* The download is the finished file: write it out and re-open. */

    if (downloads.length) {

        const base64 = downloads[0].url.split(",")[1];

        const out = path.join(
            os.tmpdir(), downloads[0].filename.replace(/[\\/:]/g, "_")
        );

        fs.writeFileSync(out, Buffer.from(base64, "base64"));

        console.log("\nsaved   : %s", out);

        const reopened = await offscreen({
            target: "offscreen",
            type: "docx_open",
            file: base64,
        });

        if (!reopened.success) {
            problems.push("the answered file will not re-open: "
                + reopened.error);
        } else {
            console.log("re-opened cleanly: %d blocks, %d questions",
                reopened.result.blocks, reopened.result.questions.length);
        }
    }

    if (problems.length) {
        console.log("\nFAILED:");
        problems.forEach(problem => console.log("  - " + problem));
        return 1;
    }

    console.log("\nthe extension answered the workbook end to end");
    return 0;
}


main().then(code => process.exit(code)).catch((error) => {
    console.error("CRASHED:", error.message);
    console.error(String(error.stack).split("\n").slice(1, 5).join("\n"));
    process.exit(1);
});
