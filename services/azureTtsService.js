/**
 * @file src/services/edgeTtsService.js
 * @description RCM AI Audio Engine: High-Fidelity Neural TTS.
 * FEATURES:
 * 1. SSML Injection (Breathing, Pauses, Intonation).
 * 2. Hinglish Optimized (Indian Business Accent).
 * 3. Fail-Safe Layering (Cache -> ElevenLabs -> Azure -> Google).
 * @version 4.0 (God Mode)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const googleTTS = require('google-tts-api');
const { db } = require('../config/db'); 
require('dotenv').config();

// 🔧 CONFIG
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// Voice ID for ElevenLabs (backup)
const ELEVEN_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; 

// 🎯 AZURE VOICE CONFIG (The Secret Sauce)
// Best Options for RCM:
// 1. 'en-IN-NeerjaNeural' -> Very Professional Female, Great English/Hindi Mix.
// 2. 'hi-IN-MadhurNeural' -> Deep, Confident Male (Leader style).
// 3. 'hi-IN-SwaraNeural' -> Soft, Polite Female.
const AZURE_VOICE_NAME = "en-IN-NeerjaNeural"; 

// 📂 Ensure Content Directory
const contentDir = path.join(__dirname, '../content');
if (!fs.existsSync(contentDir)) fs.mkdirSync(contentDir, { recursive: true });

function generateTextHash(text) {
    return crypto.createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

/**
 * 🎨 SSML BUILDER (The Heart of Human-Like Voice)
 * This makes the voice sound alive, not robotic.
 */
const buildSSML = (text, voiceName) => {
    // Escaping special characters for XML safety
    const safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    return `
    <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-IN">
        <voice name="${voiceName}">
            <mstts:express-as style="empathetic" styledegree="1.1">
                <prosody rate="1.05" pitch="-2%">
                    ${safeText}
                </prosody>
            </mstts:express-as>
        </voice>
    </speak>`;
};

/**
 * 🔷 AZURE SPEECH GENERATOR (SSML ENHANCED)
 */
const synthesizeAzure = (text) => {
    return new Promise((resolve, reject) => {
        try {
            if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
                return reject(new Error("Azure Config Missing"));
            }

            const speechConfig = sdk.SpeechConfig.fromSubscription(
                process.env.AZURE_SPEECH_KEY, 
                process.env.AZURE_SPEECH_REGION
            );

            // Set High Fidelity Output
            speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3;

            const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
            const ssml = buildSSML(text, AZURE_VOICE_NAME);

            // Using speakSsmlAsync instead of speakTextAsync for emotion
            synthesizer.speakSsmlAsync(
                ssml,
                (result) => {
                    if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                        resolve(Buffer.from(result.audioData));
                    } else {
                        const details = sdk.CancellationDetails.fromResult(result);
                        console.error(`❌ Azure Error: ${details.errorDetails}`);
                        reject(new Error("Azure Synthesis Failed"));
                    }
                    synthesizer.close();
                },
                (err) => {
                    synthesizer.close();
                    reject(err);
                }
            );
        } catch (e) {
            reject(e);
        }
    });
};

/**
 * 🟢 GOOGLE FREE TTS (Fallback Layer)
 */
const synthesizeGoogle = async (text) => {
    try {
        const url = googleTTS.getAudioUrl(text.substring(0, 200), {
            lang: 'hi', // Hindi accent fallback
            slow: false,
            host: 'https://translate.google.com',
        });
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return response.data;
    } catch (e) {
        throw new Error("Google TTS Failed");
    }
};

/**
 * 🚀 MAIN GENERATOR FUNCTION
 */
const generateEdgeAudio = async (text) => {
    if (!text) return null;
    
    // Cleanup text for better pronunciation
    const cleanText = text
        .replace(/[*#]/g, '')
        .replace(/RCM/g, "R.C.M.") // Pronounce acronym correctly
        .trim(); 
        
    const textHash = generateTextHash(cleanText);

    // 1. ⚡ CACHE CHECK (Speed Optimization)
    try {
        const cachedEntry = await db.VoiceResponse.findOne({ where: { textHash } });
        if (cachedEntry && cachedEntry.audioUrl) {
            const fileName = path.basename(cachedEntry.audioUrl);
            if (fs.existsSync(path.join(contentDir, fileName))) {
                console.log("⚡ [Cache Hit] Serving saved audio.");
                return cachedEntry.audioUrl;
            }
        }
    } catch (e) {}

    let audioBuffer = null;
    let voiceSource = 'AZURE_NEURAL'; // We prefer Azure now

    // 2. 🔷 LAYER 1: AZURE NEURAL (Primary - Professional RCM Voice)
    try {
        console.log("🎙️ Generating RCM Voice via Azure...");
        audioBuffer = await synthesizeAzure(cleanText);
        voiceSource = 'AZURE_NEURAL';
    } catch (e) {
        console.warn("⚠️ Azure Failed, switching to fallback...", e.message);
    }

    // 3. 💎 LAYER 2: ELEVENLABS (Expensive Fallback)
    // Only use if Azure fails AND text is short
    if (!audioBuffer && ELEVENLABS_API_KEY && cleanText.length < 200) {
        try {
            console.log("💎 Using ElevenLabs Fallback...");
            const response = await axios({
                method: 'POST',
                url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
                data: { 
                    text: cleanText, 
                    model_id: "eleven_multilingual_v2",
                    voice_settings: { stability: 0.5, similarity_boost: 0.75 }
                },
                headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
                responseType: 'arraybuffer'
            });
            audioBuffer = response.data;
            voiceSource = 'ELEVENLABS';
        } catch (e) {
            console.warn("⚠️ ElevenLabs Skipped.");
        }
    }

    // 4. 🟢 LAYER 3: GOOGLE FREE (Ultimate Backup)
    if (!audioBuffer) {
        console.log("🔄 Fallback to Google Free TTS...");
        try {
            audioBuffer = await synthesizeGoogle(cleanText);
            voiceSource = 'GOOGLE_FREE';
        } catch (e) {
            console.error("❌ All Voice Engines Failed.");
            return null;
        }
    }

    // 5. 💾 SAVE & RETURN
    try {
        const fileName = `speech-${textHash}.mp3`;
        const filePath = path.join(contentDir, fileName);
        fs.writeFileSync(filePath, audioBuffer);

        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
        const publicUrl = `${baseUrl}/content/${fileName}`;

        // Save to DB for future cache
        db.VoiceResponse.create({
            textHash, originalText: cleanText, audioUrl: publicUrl, voiceId: voiceSource
        }).catch(()=>{});

        return publicUrl;
    } catch (e) {
        console.error("File Write Error:", e);
        return null;
    }
};

module.exports = { generateEdgeAudio };