/*
 * Shared behaviour for the Claude, ChatGPT and Gemini providers.
 *
 * The important part is waitForAnswer(). Reading "the last bit of
 * text on the page" does not work: every one of these sites ends
 * with a fixed disclaimer ("ChatGPT can make mistakes...") which
 * never changes, so that text looks like a finished answer the
 * instant the question is sent.
 *
 * Instead each provider says which elements are real assistant
 * replies, and whether one is still being written. An answer is
 * only accepted once:
 *
 *   1. a NEW reply has appeared since the question was sent, and
 *   2. the site has stopped generating, and
 *   3. the text has stopped changing.
 */

class BaseProvider {

    constructor(name) {
        this.name = name;
    }


    /* ---- to be provided by each site ---- */

    answerSelector() {
        throw new Error("answerSelector not implemented.");
    }

    isGenerating() {
        return false;
    }

    cleanTurnText(text) {
        return text;
    }


    /* ---- shared helpers ---- */

    isAvailable() {
        return true;
    }


    isVisible(element) {

        if (!element) {
            return false;
        }

        const style = window.getComputedStyle(element);

        if (
            style.display === "none" ||
            style.visibility === "hidden"
        ) {
            return false;
        }

        const rect = element.getBoundingClientRect();

        return rect.width > 0 && rect.height > 0;
    }


    getInputElement() {

        const elements = [
            ...document.querySelectorAll("textarea"),
            ...document.querySelectorAll('[contenteditable="true"]')
        ];

        return elements.find(
            element => this.isVisible(element)
        ) || null;
    }


    getSendButton() {

        const buttons = Array.from(
            document.querySelectorAll("button")
        ).filter(button => this.isVisible(button));

        const matches = buttons.filter((button) => {

            const label =
                (button.getAttribute("aria-label") || "") + " " +
                (button.getAttribute("title") || "") + " " +
                (button.getAttribute("data-testid") || "") + " " +
                (button.innerText || "");

            const value = label.toLowerCase();

            return (
                (
                    value.includes("send") ||
                    value.includes("submit")
                ) &&
                !value.includes("feedback")
            );
        });

        return matches[matches.length - 1] || null;
    }


    getAnswerTurns() {

        return Array.from(
            document.querySelectorAll(this.answerSelector())
        ).filter(element => this.isVisible(element));
    }


    getLatestAnswerText() {

        const turns = this.getAnswerTurns();

        if (turns.length === 0) {
            return "";
        }

        const last = turns[turns.length - 1];

        const text = (last.innerText || "").trim();

        return this.cleanTurnText(text).trim();
    }


    async sendQuestion(question) {

        const input = this.getInputElement();

        if (!input) {
            throw new Error(
                this.name + " message box not found."
            );
        }

        input.focus();

        if (input instanceof HTMLTextAreaElement) {

            const descriptor = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                "value"
            );

            if (descriptor && descriptor.set) {
                descriptor.set.call(input, question);
            } else {
                input.value = question;
            }

            input.dispatchEvent(
                new InputEvent("input", {
                    bubbles: true,
                    inputType: "insertText",
                    data: question
                })
            );

            return;
        }

        /*
         * Rich text editors: clear anything there, then insert the
         * question the way a real keystroke would, so the editor's
         * own model updates and the Send button switches on.
         */

        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);

        const inserted =
            document.execCommand("insertText", false, question);

        if (!inserted || !(input.innerText || "").trim()) {

            input.textContent = question;

            input.dispatchEvent(
                new InputEvent("input", {
                    bubbles: true,
                    inputType: "insertText",
                    data: question
                })
            );
        }
    }


    async clickSend() {

        for (let i = 0; i < 20; i++) {

            const button = this.getSendButton();

            if (button && !button.disabled) {
                button.click();
                return;
            }

            await this.pause(250);
        }

        throw new Error(
            this.name + " Send button never became available."
        );
    }


    pause(ms) {

        return new Promise(
            resolve => setTimeout(resolve, ms)
        );
    }


    /*
     * Waits for a genuinely new, finished reply.
     */
    async waitForAnswer(options = {}) {

        const timeout = options.timeout ?? 180000;

        const stableTime = options.stableTime ?? 3500;

        const interval = options.checkInterval ?? 400;

        const baseline = options.baseline ?? 0;

        const started = Date.now();

        let previous = "";

        let lastChange = Date.now();

        let sawNewTurn = false;

        /*
         * The longest reply seen since the question went out. A
         * streaming answer can briefly look finished - the stop
         * button disappears, the text pauses between paragraphs -
         * and reading at that moment catches only part of it. What
         * was seen at its longest is kept, so a pause costs a
         * little waiting rather than most of the answer.
         */
        let best = "";

        while (Date.now() - started < timeout) {

            await this.pause(interval);

            const turns = this.getAnswerTurns();

            if (turns.length > baseline) {
                sawNewTurn = true;
            }

            if (!sawNewTurn) {
                /* The reply has not started yet. Keep waiting. */
                continue;
            }

            if (this.isGenerating()) {
                /* Still being written. */
                lastChange = Date.now();
                continue;
            }

            const current = this.getLatestAnswerText();

            if (!current) {
                continue;
            }

            if (current.length > best.length) {
                best = current;
            }

            if (current !== previous) {
                previous = current;
                lastChange = Date.now();
                continue;
            }

            if (Date.now() - lastChange >= stableTime) {
                return best;
            }
        }

        if (sawNewTurn && best) {

            /* Ran out of time but something was written - keep it. */
            return best;
        }

        throw new Error(
            this.name + " did not answer in time."
        );
    }


    async ask(question, options = {}) {

        /*
         * Count the replies already on screen, so the new one can
         * be told apart from them.
         */
        const baseline = this.getAnswerTurns().length;

        await this.sendQuestion(question);

        await this.pause(200);

        await this.clickSend();

        return await this.waitForAnswer(
            Object.assign({}, options, { baseline: baseline })
        );
    }


    getStatus() {

        return {
            provider: this.name,
            available: this.isAvailable(),
            inputFound: this.getInputElement() !== null,
            answerTurns: this.getAnswerTurns().length,
            generating: this.isGenerating()
        };
    }
}


window.BaseProvider = BaseProvider;
