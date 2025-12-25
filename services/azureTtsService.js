const sdk = require("microsoft-cognitiveservices-speech-sdk");
require('dotenv').config();

// Azure Config check
if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
    console.warn("⚠️ Azure Speech Credentials Missing in .env");
}

const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY, 
    process.env.AZURE_SPEECH_REGION
);

// Voice Selection (Hindi + English Neural Voice)
// Options: 'hi-IN-SwaraNeural' (Female), 'hi-IN-MadhurNeural' (Male)
speechConfig.speechSynthesisVoiceName = "hi-IN-SwaraNeural"; 

/**
 * Converts text to audio using Azure Neural TTS
 * Returns: Base64 Data URI (playable directly in frontend <audio src="...">)
 */
const generateAzureAudio = async (text) => {
    return new Promise((resolve, reject) => {
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null); // Null = No playback on server

        synthesizer.speakTextAsync(
            text,
            (result) => {
                if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                    // Convert Buffer to Base64
                    const audioBuffer = Buffer.from(result.audioData);
                    const base64String = audioBuffer.toString('base64');
                    // Return as Data URI
                    resolve(`data:audio/mp3;base64,${base64String}`);
                } else {
                    console.error("❌ Azure Speech Failed:", result.errorDetails);
                    resolve(null); // Fail gracefully
                }
                synthesizer.close();
            },
            (error) => {
                console.error("❌ Azure Error:", error);
                resolve(null);
                synthesizer.close();
            }
        );
    });
};

module.exports = { generateAzureAudio };