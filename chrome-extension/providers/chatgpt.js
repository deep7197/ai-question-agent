/*
 * ChatGPT (chatgpt.com)
 *
 * Verified against the live site: assistant replies are marked with
 * data-message-author-role="assistant", and a Stop button is shown
 * while a reply is being written.
 */

class ChatGPTProvider extends window.BaseProvider {

    constructor() {
        super("chatgpt");
    }


    isAvailable() {

        return window.location.hostname === "chatgpt.com";
    }


    answerSelector() {

        return '[data-message-author-role="assistant"]';
    }


    isGenerating() {

        const stop = document.querySelector(
            '[data-testid="stop-button"], ' +
            'button[aria-label*="Stop" i]'
        );

        return this.isVisible(stop);
    }
}


window.AIQuestionProvider = new ChatGPTProvider();
