/*
 * A whole workbook run through the extension's own background
 * worker, with Chrome stood in for: tabs, the offscreen document,
 * downloads and the AI all answer the way the real ones would.
 *
 * This is the path the popup takes when you choose a Word file, so
 * a mistake anywhere in it - a function that does not exist, a
 * message nobody answers - shows up here rather than as a popup
 * that does nothing.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "chrome-extension");

const asked = [];
const written = [];
const downloads = [];

let saved = false;

/* --- the questions the offscreen document would report ---------- */

const QUESTIONS = [
    {
        number: "1",
        text: "Explain what a risk assessment is.",
        context: "",
        answer_type: "prose",
        word_min: 50,
        word_max: 100,
        grid: null,
        where: "box",
    },
    {
        number: "2",
        text: "Is a SWMS required for work at heights?",
        context: "",
        answer_type: "yesno",
        word_min: null,
        word_max: null,
        grid: null,
        where: "line",
    },
    {
        number: "3",
        text: "Explain the following materials.",
        context: "",
        answer_type: "grid",
        word_min: null,
        word_max: null,
        grid: {
            headers: ["Properties", "Uses"],
            rows: ["1. Cement", "2. Concrete", "3. Steel"],
            table: 4,
        },
        where: "table",
    },
];


function stubChrome() {

    return {
        runtime: {
            getContexts: async () => [],
            sendMessage: async (message) => {

                if (message && message.target === "offscreen") {

                    if (message.type === "docx_open") {
                        return {
                            success: true,
                            result: {
                                blocks: 100,
                                questions: QUESTIONS,
                            },
                        };
                    }

                    if (message.type === "docx_answer") {
                        written.push({
                            at: message.at, text: message.text
                        });
                        return { success: true, where: "box" };
                    }

                    if (message.type === "docx_grid") {
                        written.push({
                            at: message.at, rows: message.rows
                        });
                        return { success: true, cells: message.rows.length * 2 };
                    }

                    if (message.type === "docx_save") {
                        saved = true;
                        return { success: true, file: "QUJD" };
                    }
                }

                return { success: true };
            },
            onMessage: { addListener: () => {} },
            onInstalled: { addListener: () => {} },
            onStartup: { addListener: () => {} },
            onConnect: { addListener: () => {} },
            getPlatformInfo: (cb) => cb && cb({}),
        },
        offscreen: {
            createDocument: async () => {},
            closeDocument: async () => {},
        },
        downloads: {
            download: async (options) => {
                downloads.push(options);
            },
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
            create: async () => ({ id: 101 }),
            get: async () => ({ id: 101, status: "complete" }),
            update: async () => ({ id: 101 }),
            remove: async () => {},
            sendMessage: async (tabId, message) => {

                if (message.type === "get_status") {
                    return {
                        status: { inputFound: true, editorFound: true }
                    };
                }

                if (message.type === "ask") {

                    asked.push(message.question);

                    if (/one line per item/i.test(message.question)) {

                        const items = message.question
                            .split("Items:")[1]
                            .split("\n\n")[0]
                            .trim()
                            .split("\n");

                        return {
                            success: true,
                            answer: items.map(
                                item => item + " | Properties: hard | "
                                    + "Uses: building"
                            ).join("\n"),
                        };
                    }

                    if (/Yes or No/i.test(message.question)) {
                        return { success: true, answer: "Yes" };
                    }

                    return {
                        success: true,
                        answer: "A risk assessment identifies hazards "
                            + "and rates them before work starts.",
                    };
                }

                return { success: false, error: "unexpected" };
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
    };
}


async function main() {

    const context = {
        console,
        chrome: stubChrome(),
        fetch: async () => ({ ok: true, text: async () => "" }),
        URL,
        TextDecoder,
        TextEncoder,
        WebSocket: function () {},
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: () => {},
        Date,
    };

    context.self = context;
    context.globalThis = context;

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

    const job = await context.runWorkbook({
        file: "QUJD",
        fileName: "workbook.docx",
        provider: "claude",
    });

    const problems = [];

    console.log("status : %s", job.status);
    console.log("step   : %s", job.step);
    console.log("asked  : %d question(s)", asked.length);
    console.log("written: %d", written.length);
    console.log("saved  : %s, downloads: %d", saved, downloads.length);

    job.results.forEach((result) => {
        console.log("  [%s] %s", result.number,
            result.error ? "ERROR " + result.error
                         : result.answer.slice(0, 50).replace(/\n/g, " / "));
    });

    if (job.status !== "done") {
        problems.push("the run did not finish: " + (job.error || job.step));
    }

    if (job.results.filter(r => r.error).length) {
        problems.push("some questions errored");
    }

    if (written.length !== 3) {
        problems.push("expected 3 writes, got " + written.length);
    }

    if (!saved || downloads.length !== 1) {
        problems.push("the answered file was not downloaded");
    }

    if (!/answered\.docx$/.test(downloads[0] && downloads[0].filename)) {
        problems.push("the download has the wrong name: "
            + (downloads[0] && downloads[0].filename));
    }

    if (problems.length) {
        console.log("\nFAILED:");
        problems.forEach(p => console.log("  - " + p));
        return 1;
    }

    console.log("\nthe extension can answer a workbook end to end");
    return 0;
}


main().then(code => process.exit(code)).catch((error) => {
    console.error("CRASHED:", error.message);
    console.error(String(error.stack).split("\n").slice(1, 4).join("\n"));
    process.exit(1);
});
