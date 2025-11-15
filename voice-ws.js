// server/voice-ws.js

const WebSocket = require("ws");
const { speechToText, textToSpeech } = require("./stt_tts_helpers");

function createVoiceServer(server) {
  const wss = new WebSocket.Server({ server, path: "/voice" });

  wss.on("connection", (ws) => {
    console.log("🔗 Voice WebSocket Connected");

    ws.on("message", async (audioData) => {
      try {
        const userText = await speechToText(audioData);
        console.log("🎤 User:", userText);

        // AI Response
        const aiReply = await getAIResponse(userText);
        console.log("🤖 AI:", aiReply);

        // Convert AI text to audio
        const audioStream = await textToSpeech(aiReply);

        ws.send(audioStream);
      } catch (err) {
        console.log("❌ Error:", err);
        ws.send("error");
      }
    });
  });

  return wss;
}

async function getAIResponse(text) {
  return `RCM Home Meeting Start — ${text}`; // Customize later
}

module.exports = createVoiceServer;
