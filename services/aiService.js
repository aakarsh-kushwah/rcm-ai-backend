const Groq = require('groq-sdk');
const { systemPrompt } = require('../utils/prompts'); // ✅ Step 1: Import the prompt

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

const getAIChatResponse = async (userMessage) => {
    try {
        const chatCompletion = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b", 
            messages: [
                {
                    role: "system",
                    content: systemPrompt, // ✅ Step 2: Use the imported variable here
                },
                {
                    role: "user",
                    content: userMessage,
                },
            ],
            temperature: 0.7,
            max_tokens: 1024,
            top_p: 1,
            stream: false,
        });

        return chatCompletion.choices[0]?.message?.content || "Sorry, I couldn't generate a response.";

    } catch (error) {
        console.error("Groq AI Service Error:", error);
        return "I'm sorry, I am having trouble connecting to the AI service right now. Please check your API key.";
    }
};

module.exports = { getAIChatResponse };