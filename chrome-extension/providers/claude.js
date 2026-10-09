/*
 * Claude (claude.ai)
 *
 * Verified against the live site: every assistant reply carries a
 * data-is-streaming attribute, which is "true" while the reply is
 * still being written and "false" once it is finished.
 */

class ClaudeProvider extends window.BaseProvider {

    constructor() {
        super("claude");
    }


    isAvailable() {

        return window.location.hostname === "claude.ai";
    }


    answerSelector() {

        return "[data-is-streaming]";
    }


    isGenerating() {

        return !!document.querySelector(
            '[data-is-streaming="true"]'
        );
    }


    cleanTurnText(text) {

        /* The reply carries a spoken-label prefix for screen readers. */
        return text.replace(/^Claude responded:\s*/i, "");
    }
}


window.AIQuestionProvider = new ClaudeProvider();
