/*
 * Google Docs - the Find bar.
 *
 * Google Docs paints the document onto a canvas, so an extension
 * cannot see where anything is on the page. The one handle it does
 * get is the Find bar, which is ordinary HTML: typing a question's
 * own line into it puts the cursor on that line, and from there the
 * arrow keys reach the space left for the answer.
 *
 * That only works if the search really did find one, single match.
 * This file's whole job is to make that checkable, so the writer
 * can refuse to type when anything is not as expected instead of
 * dropping an answer in the wrong place.
 *
 * It never types and never clicks Accept-style buttons itself: the
 * background worker does that through the debugger, because Docs
 * ignores input that did not come from a real keyboard.
 */

const FIND_INPUT =
    "input[aria-label*='Find' i], input[class*='docs-findinput' i]";

const COUNTER = /^\s*(\d+)\s+of\s+(\d+)\s*$/;


class DocsFinder {

    constructor() {
        this.name = "google-docs-find";
    }


    input() {

        const inputs = Array.from(
            document.querySelectorAll(FIND_INPUT)
        ).filter((el) => {

            const rect = el.getBoundingClientRect();

            return rect.width > 40 && rect.height > 8;
        });

        return inputs.length > 0 ? inputs[0] : null;
    }


    /*
     * "1 of 3" next to the search box. Docs only shows it once a
     * search has run, so its absence means "not searched yet".
     */
    counter() {

        const nodes = Array.from(document.querySelectorAll("*"));

        for (const node of nodes) {

            if (node.children.length !== 0) {
                continue;
            }

            const match = COUNTER.exec(node.innerText || "");

            if (match) {

                return {
                    at: Number(match[1]),
                    total: Number(match[2])
                };
            }
        }

        return null;
    }


    /*
     * Puts the caret in the search box, ready for the background
     * worker to type the line into it.
     */
    focusInput() {

        const input = this.input();

        if (!input) {
            return { ok: false, reason: "The Find bar is not open." };
        }

        input.focus();

        input.select();

        return {
            ok: document.activeElement === input,
            reason: document.activeElement === input
                ? ""
                : "The Find bar would not take the caret."
        };
    }


    /*
     * What the search box holds, and what it found. The writer only
     * carries on when the text went in whole and matched exactly
     * one place in the document.
     */
    state(expected) {

        const input = this.input();

        if (!input) {
            return { ok: false, reason: "The Find bar closed." };
        }

        const value = input.value || "";

        const counter = this.counter();

        if (expected && value.trim() !== String(expected).trim()) {

            return {
                ok: false,
                value: value,
                reason: "The question line did not go into the Find box."
            };
        }

        if (!counter) {

            return {
                ok: false,
                value: value,
                reason: "Google Docs has not finished searching."
            };
        }

        if (counter.total !== 1) {

            return {
                ok: false,
                value: value,
                total: counter.total,
                reason: counter.total === 0
                    ? "That question was not found in the document."
                    : "That question line appears " +
                      counter.total +
                      " times, so the answer could land on the wrong one."
            };
        }

        return { ok: true, value: value, total: 1 };
    }


    getStatus() {

        return {
            provider: this.name,
            available: true,
            findBarOpen: this.input() !== null
        };
    }
}


window.DocsFinder = new DocsFinder();
