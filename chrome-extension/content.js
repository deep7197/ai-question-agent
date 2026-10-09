function detectProvider() {

    const hostname =
        window.location.hostname;


    if (
        hostname === "claude.ai"
    ) {
        return "claude";
    }


    if (
        hostname === "gemini.google.com"
    ) {
        return "gemini";
    }


    if (
        hostname === "chatgpt.com"
    ) {
        return "chatgpt";
    }


    if (
        hostname === "docs.google.com" &&
        window.location.pathname.startsWith(
            "/document/"
        )
    ) {
        return "google-docs";
    }


    return "unknown";
}


const providerName =
    detectProvider();


console.log(
    "================================"
);

console.log(
    "AI Question Agent"
);

console.log(
    "Provider:",
    providerName
);

console.log(
    "URL:",
    window.location.href
);

console.log(
    "================================"
);


if (
    window.AIQuestionProvider
) {

    console.log(
        "Provider initialized:",
        window.AIQuestionProvider.name
    );

} else {

    console.log(
        "No AI provider interface."
    );
}


/*
 * The background worker may inject this file if the normal
 * content script has not started yet. Register the listener
 * only once so a question is never sent twice.
 */

if (!window.__AI_QUESTION_AGENT_CONTENT__) {

window.__AI_QUESTION_AGENT_CONTENT__ = true;


chrome.runtime.onMessage.addListener(
    (
        message,
        sender,
        sendResponse
    ) => {

        console.log(
            "Message from extension:",
            message
        );


        /*
         * Google Docs - the Find bar, used to steer the caret to
         * the space under a question.
         */

        if (
            message.type === "docs_find_focus" ||
            message.type === "docs_find_state"
        ) {

            if (
                !window.DocsFinder
            ) {

                sendResponse({
                    success: false,
                    error:
                        "Docs find helper not initialized."
                });

                return true;
            }


            if (
                message.type === "docs_find_focus"
            ) {

                sendResponse({
                    success: true,
                    result:
                        window.DocsFinder.focusInput()
                });

                return true;
            }


            sendResponse({
                success: true,
                result:
                    window.DocsFinder.state(message.expected || "")
            });

            return true;
        }


        /*
         * Status
         */

        if (
            message.type ===
            "get_status"
        ) {

            const statusProvider =
                window.AIQuestionProvider ||
                null;

            if (
                !statusProvider
            ) {

                sendResponse({
                    provider:
                        providerName,
                    status: null
                });

                return true;
            }


            sendResponse({
                provider:
                    providerName,
                status:
                    statusProvider
                        .getStatus()
            });


            return true;
        }


        /*
         * Ask AI
         */

        if (
            message.type ===
            "ask"
        ) {

            if (
                !window.AIQuestionProvider
            ) {

                sendResponse({
                    success: false,
                    error:
                        "AI provider not initialized."
                });

                return true;
            }


            window.AIQuestionProvider
                .ask(
                    message.question,
                    message.options || {}
                )
                .then(answer => {

                    sendResponse({
                        success: true,
                        provider:
                            providerName,
                        answer:
                            answer
                    });

                })
                .catch(error => {

                    console.error(
                        "AI request failed:",
                        error
                    );

                    sendResponse({
                        success: false,
                        error:
                            error.message
                    });
                });


            return true;
        }


        sendResponse({
            success: false,
            error:
                "Unknown command."
        });


        return true;
    }
);
}
