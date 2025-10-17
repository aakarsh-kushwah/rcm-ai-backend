const Groq = require('groq-sdk');
// Initialize Groq client (should be done once)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); 
const MODEL = "openai/gpt-oss-120b"; // A good performing model

/**
 * Sends messages to the Groq API and retrieves the response.
 * @param {Array<Object>} messages - Array of message objects [{role: "system", content: "..."}]
 */
async function getAIChatResponse(messages) {
    if (!messages || messages.length === 0 || !messages.some(m => m.role === 'user')) {
        return "Error: No valid user message found.";
    }

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: messages, // Messages array containing the system prompt and user query
            model: MODEL,
            temperature: 0.5,
        });

        // Extract the reply text
        return chatCompletion.choices[0]?.message?.content || "Sorry, I couldn't generate a response.";

    } catch (error) {
        console.error("Groq AI Service Error:", error);
        // Re-throw the error so chatController can handle the HTTP status
        throw error; 
    }
}

module.exports = { getAIChatResponse };
