/*
 * Gemini (gemini.google.com)
 *
 * Replies are rendered inside <model-response> elements. While one
 * is being written Gemini shows a Stop button in the composer.
 */

class GeminiProvider extends window.BaseProvider {

    constructor() {
        super("gemini");
    }


    isAvailable() {

        return window.location.hostname === "gemini.google.com";
    }


    answerSelector() {

        return "model-response, .model-response-text";
    }


    isGenerating() {

        const stop = document.querySelector(
            'button[aria-label*="Stop" i], ' +
            ".stop-icon, " +
            "[data-test-id=\"stop-button\"]"
        );

        if (this.isVisible(stop)) {
            return true;
        }

        /* Gemini marks the container while a reply streams in. */
        return !!document.querySelector(
            ".response-container.streaming, [data-is-streaming='true']"
        );
    }
}


window.AIQuestionProvider = new GeminiProvider();
