// server/stt_tts_helpers.js

const Groq = require("groq-sdk");
require("dotenv").config();

const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });

// -------------------------
// SPEECH TO TEXT
// -------------------------
async function speechToText(audioBuffer) {
  const response = await groqClient.audio.transcriptions.create({
    file: audioBuffer,
    model: "whisper-large-v3",
  });

  return response.text;
}

// -------------------------
// TEXT TO SPEECH STREAMING
// -------------------------
async function textToSpeech(text) {
  const speech = await groqClient.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text,
    format: "wav",
  });

  return speech.data; // Uint8Array audio stream
}

module.exports = {
  speechToText,
  textToSpeech,
};
