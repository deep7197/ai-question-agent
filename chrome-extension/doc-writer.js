/*
 * Writes answers into the Google Doc, one question at a time.
 *
 * The Doc is opened once at the start and stays open for the whole
 * run. After each answer comes back it is appended straight away,
 * so if anything goes wrong later the answers already written are
 * safely in the document.
 *
 * Google Docs ignores ordinary scripted typing - the editor only
 * accepts real input events. The one way an extension can produce
 * those is the Chrome debugger API, which injects input at the
 * browser level. While this runs Chrome shows a yellow bar saying
 * the extension is debugging the tab. That bar is expected and
 * disappears when the run finishes.
 */


const DEBUGGER_VERSION = "1.3";

const KEY_END = 35;

const KEY_ENTER = 13;

const KEY_ESCAPE = 27;

const KEY_RIGHT = 39;

const KEY_DOWN = 40;

const KEY_BACKSPACE = 8;

const KEY_F = 70;

const MOD_CTRL = 2;

/*
 * Typed into the answer space first, on its own. If it turns up
 * anywhere other than the space the question left for it, the
 * writer deletes it again and nothing else is typed - so a wrong
 * turn costs six characters that are removed straight away,
 * instead of an answer landing in the middle of the document.
 */
const PROBE = "\u00abAIQA\u00bb";

/* A spot inside the page body, clear of the toolbar and ruler. */
const CARET_POINT = { x: 500, y: 400 };


function pause(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}


/*
 * Keeps an answer's paragraph breaks, and drops the empty lines
 * between them - in a document each paragraph is its own line.
 */
function splitParagraphs(text) {

    const paragraphs = String(text || "")
        .split(/\n\s*\n+/)
        .map(part => part
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .join(" ")
            .trim())
        .filter(part => part.length > 0);

    return paragraphs.length > 0 ? paragraphs : [""];
}


class DocWriter {

    constructor(docUrl) {

        this.docUrl = docUrl;

        this.tabId = null;

        this.attached = false;
    }


    send(method, params) {

        return chrome.debugger.sendCommand(
            { tabId: this.tabId },
            method,
            params || {}
        );
    }


    async pressKey(code, key, modifiers, text) {

        const base = {
            windowsVirtualKeyCode: code,
            nativeVirtualKeyCode: code,
            key: key,
            modifiers: modifiers || 0
        };

        await this.send(
            "Input.dispatchKeyEvent",
            Object.assign({}, base, {
                type: text ? "keyDown" : "rawKeyDown",
                text: text || ""
            })
        );

        await this.send(
            "Input.dispatchKeyEvent",
            Object.assign({}, base, { type: "keyUp" })
        );
    }


    async click(point) {

        for (const type of ["mousePressed", "mouseReleased"]) {

            await this.send("Input.dispatchMouseEvent", {
                type: type,
                x: point.x,
                y: point.y,
                button: "left",
                clickCount: 1
            });
        }

        await pause(250);
    }


    /*
     * Brings the Doc forward and puts the caret at the very end,
     * ready for the next answer.
     */
    async focusEndOfDocument() {

        /*
         * Fail clearly if the user closed the Doc tab mid-run, rather
         * than throwing an opaque error deep inside a debugger call.
         */
        try {

            await chrome.tabs.get(this.tabId);

        } catch (error) {

            throw new Error("The Google Doc tab was closed.");
        }

        await chrome.tabs.update(this.tabId, { active: true });

        await pause(400);

        await this.click(CARET_POINT);

        await this.pressKey(KEY_END, "End", MOD_CTRL);

        await pause(400);
    }


    /*
     * Inserting text can fail transiently if the Doc briefly loses
     * focus (a tab switch, the editor still settling). One retry -
     * after re-clicking into the body - clears almost all of these.
     */
    async insertTextRetry(text) {

        for (let attempt = 0; attempt < 2; attempt++) {

            try {

                await this.send("Input.insertText", { text: text });

                return;

            } catch (error) {

                if (attempt === 1) {
                    throw error;
                }

                await pause(300);

                await this.click(CARET_POINT);
            }
        }
    }


    async typeLines(lines) {

        for (const line of lines) {

            if (line) {

                await this.insertTextRetry(line);
            }

            await this.pressKey(KEY_ENTER, "Enter", 0, "\r");

            await pause(60);
        }
    }


    /*
     * Opens the Doc and connects to it. Throws if the connection
     * cannot be made - the caller then carries on without writing.
     */
    async open() {

        const tab = await chrome.tabs.create({
            url: this.docUrl,
            active: true
        });

        this.tabId = tab.id;

        for (let i = 0; i < 60; i++) {

            const current = await chrome.tabs.get(this.tabId);

            if (current.status === "complete") {
                break;
            }

            await pause(500);
        }

        /* Give the editor time to finish painting. */
        await pause(3000);

        await this.attachDebugger();

        this.attached = true;
    }


    /*
     * Attaches the debugger, recovering from the common case where a
     * previous run (or a crashed one) left it still attached to the
     * tab. Without this, "Another debugger is already attached"
     * would abort writing for the whole run.
     */
    async attachDebugger() {

        try {

            await chrome.debugger.attach(
                { tabId: this.tabId },
                DEBUGGER_VERSION
            );

            return;

        } catch (error) {

            if (!/already attached/i.test(error.message || "")) {
                throw error;
            }
        }

        /* Left attached from before - detach and try once more. */
        try {

            await chrome.debugger.detach({ tabId: this.tabId });

        } catch (error) {
            /* Nothing to detach. Carry on. */
        }

        await pause(500);

        await chrome.debugger.attach(
            { tabId: this.tabId },
            DEBUGGER_VERSION
        );
    }


    /*
     * Steers the caret to the space the document leaves under a
     * question, checking at every step, and writes the answer
     * there.
     *
     * Throws if anything cannot be confirmed. The caller then falls
     * back to collecting the answer at the end of the document,
     * where it is safe and visible.
     */
    async writeInPlace(item, target, confirm) {

        await this.focusDocument();

        /* 1. Open the Find bar and put the question's line in it. */

        await this.pressKey(KEY_F, "f", MOD_CTRL);

        await pause(700);

        const focused = await this.askDoc({
            type: "docs_find_focus"
        });

        if (!focused || !focused.result || !focused.result.ok) {

            throw new Error(
                (focused && focused.result && focused.result.reason) ||
                "The Find bar did not open."
            );
        }

        await this.insertTextRetry(target.anchor);

        /* 2. Refuse to move unless it found exactly one place. */

        const state = await this.waitForMatch(target.anchor);

        /* 3. Close the search, leaving the caret on the match. */

        await this.pressKey(KEY_ESCAPE, "Escape", 0);

        await pause(400);

        /* Collapse the selection to the end of the line found. */
        await this.pressKey(KEY_RIGHT, "ArrowRight", 0);

        for (let step = 0; step < target.downs; step++) {

            await this.pressKey(KEY_DOWN, "ArrowDown", 0);

            await pause(80);
        }

        /* 4. Prove where the caret ended up before typing. */

        await this.insertTextRetry(PROBE);

        await pause(900);

        const landed = await confirm(target, PROBE);

        for (let i = 0; i < PROBE.length; i++) {

            await this.pressKey(KEY_BACKSPACE, "Backspace", 0);
        }

        await pause(300);

        if (!landed) {

            throw new Error(
                "The answer space for " +
                item.number +
                " could not be reached."
            );
        }

        /* 5. Only now, the answer itself. */

        const answer = item.error
            ? "[Not answered: " + item.error + "]"
            : item.answer;

        const paragraphs = splitParagraphs(answer);

        for (let i = 0; i < paragraphs.length; i++) {

            if (i > 0) {
                await this.pressKey(KEY_ENTER, "Enter", 0, "\r");
                await pause(80);
            }

            await this.insertTextRetry(paragraphs[i]);
        }

        await pause(200);

        return state;
    }


    /*
     * Google Docs searches as you type, so the count arrives a
     * moment after the text does.
     */
    async waitForMatch(anchor) {

        let last = "Google Docs did not answer.";

        for (let attempt = 0; attempt < 12; attempt++) {

            await pause(400);

            const reply = await this.askDoc({
                type: "docs_find_state",
                expected: anchor
            });

            const state = reply && reply.result;

            if (state && state.ok) {
                return state;
            }

            if (state && state.reason) {
                last = state.reason;
            }
        }

        throw new Error(last);
    }


    askDoc(message) {

        return chrome.tabs.sendMessage(this.tabId, message);
    }


    /* Brings the Doc forward and puts the caret in the body. */
    async focusDocument() {

        try {

            await chrome.tabs.get(this.tabId);

        } catch (error) {

            throw new Error("The Google Doc tab was closed.");
        }

        await chrome.tabs.update(this.tabId, { active: true });

        await pause(400);

        await this.click(CARET_POINT);
    }


    async writeHeading(provider) {

        await this.focusEndOfDocument();

        await this.typeLines([
            "",
            "AI Answers",
            "Answered with " +
                provider +
                " on " +
                new Date().toLocaleString(),
            ""
        ]);
    }


    /*
     * Appends a single question's answer.
     */
    async writeAnswer(item) {

        await this.focusEndOfDocument();

        /*
         * "Answer to X" is the marker the Apps Script helper looks
         * for when putting each answer under its question. X is the
         * question's own label - "3", "2(a)", "Task 1" - so it
         * cannot clash with the document's own headings.
         */

        const lines = ["Answer to " + item.number];

        /*
         * A grid answer is written as "[grid]" and then one line per
         * row - "row label :: first cell :: second cell" - which is
         * what the Apps Script reads back when it fills the table.
         */
        if (item.grid && item.grid.length) {

            lines.push("[grid]");

            item.grid.forEach((row) => {

                lines.push(
                    [row.row]
                        .concat(row.cells || [])
                        .map(part => String(part).replace(/\s+/g, " ").trim())
                        .join(" :: ")
                );
            });

            lines.push("");

            await this.typeLines(lines);

            return;
        }

        const answer = item.error
            ? "[Not answered: " + item.error + "]"
            : item.answer;

        /*
         * Keep the answer's paragraph breaks: each paragraph becomes
         * a line, with a blank line between paragraphs. An empty
         * string in the list is an Enter with no text, which is what
         * produces that blank line in the Doc.
         */
        const paragraphs = answer
            .split(/\n\s*\n+/)
            .map(para => para
                .split("\n")
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .join(" ")
                .trim())
            .filter(para => para.length > 0);

        paragraphs.forEach((para, index) => {

            lines.push(para);

            if (index < paragraphs.length - 1) {
                lines.push("");
            }
        });

        lines.push("");

        await this.typeLines(lines);
    }


    async close() {

        if (!this.attached) {
            return;
        }

        try {

            await chrome.debugger.detach({ tabId: this.tabId });

        } catch (error) {

            console.warn(
                "[Agent] Detach failed:",
                error.message
            );
        }

        this.attached = false;
    }
}
