/**
 * @file src/services/edgeTtsService.js
 * @description Advanced RCM Audio Engine with "Voice Controller".
 * FEATURES: 
 * 1. Multi-Mode Support (Leader, Soft, Whisper, Excited).
 * 2. Fine-grained control over Pitch, Rate, and Pauses.
 * 3. Human-like breathing simulation.
 * @version 6.0 (Voice Controller Edition)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const googleTTS = require('google-tts-api');
const { db } = require('../config/db'); 
require('dotenv').config();

// 🔧 CONFIGURATION
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; 

// 🎯 MAIN MALE VOICE (RCM Leader)
const AZURE_VOICE_NAME = "hi-IN-MadhurNeural"; 

const contentDir = path.join(__dirname, '../content');
if (!fs.existsSync(contentDir)) fs.mkdirSync(contentDir, { recursive: true });

function generateTextHash(text, style) {
    // Hash now includes style so 'whisper' audio is stored separately from 'shout' audio
    return crypto.createHash('sha256').update(`${text.trim()}-${style}`).digest('hex');
}

/**
 * 🎛️ VOICE CONTROLLER (The Magic Layer)
 * This function acts like the ElevenLabs settings slider.
 * @param {string} text - The text to speak
 * @param {string} style - 'professional' | 'polite' | 'whisper' | 'excited'
 */
const buildAdvancedSSML = (text, style = 'professional') => {
    // 1. Sanitize
    const safeText = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // 2. Define Styles (Preset Configurations)
    let ssmlConfig = {
        styleName: 'chat',      // Azure Style Name
        styleDegree: '1.0',     // Intensity (0.1 to 2.0)
        rate: '1.0',            // Speed
        pitch: '0%',            // Tone
        volume: '100%'          // Loudness
    };

    switch (style) {
        case 'polite': 
            // Bilkul soft aur humble (Customer Support/Greeting)
            ssmlConfig = { styleName: 'empathetic', styleDegree: '1.2', rate: '0.95', pitch: '-2%', volume: '90%' };
            break;
            
        case 'whisper': 
            // Secret share karne jesa (Soft/Private info)
            // Note: If 'whisper' style fails, we simulate it with low volume/pitch
            ssmlConfig = { styleName: 'calm', styleDegree: '1.5', rate: '0.9', pitch: '-10%', volume: '60%' };
            break;
            
        case 'excited': 
            // Motivator / Stage Speaker Mode
            ssmlConfig = { styleName: 'cheerful', styleDegree: '1.5', rate: '1.1', pitch: '+5%', volume: '110%' };
            break;

        case 'professional': 
        default:
            // Standard RCM Leader (Confident & Clear)
            ssmlConfig = { styleName: 'cheerful', styleDegree: '1.1', rate: '1.05', pitch: '-5%', volume: '100%' };
            break;
    }

    // 3. Construct SSML
    return `
    <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="hi-IN">
        <voice name="${AZURE_VOICE_NAME}">
            <mstts:express-as style="${ssmlConfig.styleName}" styledegree="${ssmlConfig.styleDegree}">
                <prosody rate="${ssmlConfig.rate}" pitch="${ssmlConfig.pitch}" volume="${ssmlConfig.volume}">
                    ${safeText}
                </prosody>
            </mstts:express-as>
        </voice>
    </speak>`;
};

/**
 * 🔷 AZURE ENGINE
 */
const synthesizeAzure = (text, styleMode) => {
    return new Promise((resolve, reject) => {
        try {
            if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
                return reject(new Error("Azure Config Missing"));
            }

            const speechConfig = sdk.SpeechConfig.fromSubscription(
                process.env.AZURE_SPEECH_KEY, 
                process.env.AZURE_SPEECH_REGION
            );

            // High Fidelity Studio Quality
            speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3;

            const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
            
            // 🔥 Generate Dynamic SSML based on requested style
            const ssml = buildAdvancedSSML(text, styleMode);

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

const synthesizeGoogle = async (text) => {
    try {
        const url = googleTTS.getAudioUrl(text.substring(0, 200), { lang: 'hi', slow: false, host: 'https://translate.google.com' });
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return response.data;
    } catch (e) { throw new Error("Google TTS Failed"); }
};

/**
 * 🚀 MAIN FUNCTION
 * @param {string} text - Text to speak
 * @param {string} styleMode - 'professional' (default) | 'polite' | 'whisper' | 'excited'
 */
const generateEdgeAudio = async (text, styleMode = 'professional') => {
    if (!text) return null;
    
    // RCM Text Cleanup
    const cleanText = text
        .replace(/[*#]/g, '')
        .replace(/RCM/g, "R.C.M.") 
        .replace(/Jai RCM/ig, "Jai R.C.M.")
        .trim(); 
        
    const textHash = generateTextHash(cleanText, styleMode);

    // 1. ⚡ CACHE CHECK
    try {
        const cachedEntry = await db.VoiceResponse.findOne({ where: { textHash } });
        if (cachedEntry && cachedEntry.audioUrl) {
            const fileName = path.basename(cachedEntry.audioUrl);
            if (fs.existsSync(path.join(contentDir, fileName))) {
                console.log(`⚡ [Cache Hit] Serving ${styleMode} audio.`);
                return cachedEntry.audioUrl;
            }
        }
    } catch (e) {}

    let audioBuffer = null;
    let voiceSource = 'AZURE_NEURAL'; 

    // 2. 🔷 LAYER 1: AZURE (With Style Control)
    try {
        console.log(`🎙️ Generating (${styleMode}) voice via Azure...`);
        audioBuffer = await synthesizeAzure(cleanText, styleMode);
        voiceSource = `AZURE_${styleMode.toUpperCase()}`;
    } catch (e) {
        console.warn("⚠️ Azure Failed, switching to fallback...", e.message);
    }

    // 3. 💎 LAYER 2: ELEVENLABS (Fallback)
    if (!audioBuffer && ELEVENLABS_API_KEY && cleanText.length < 250) {
        try {
            // Mapping styles to ElevenLabs settings
            let stability = 0.5;
            if (styleMode === 'excited') stability = 0.3; // More variance
            if (styleMode === 'whisper') stability = 0.8; // More stable

            const response = await axios({
                method: 'POST',
                url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
                data: { 
                    text: cleanText, 
                    model_id: "eleven_multilingual_v2",
                    voice_settings: { stability: stability, similarity_boost: 0.75 }
                },
                headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
                responseType: 'arraybuffer'
            });
            audioBuffer = response.data;
            voiceSource = 'ELEVENLABS';
        } catch (e) {}
    }

    // 4. 🟢 LAYER 3: GOOGLE (Fallback)
    if (!audioBuffer) {
        try { audioBuffer = await synthesizeGoogle(cleanText); voiceSource = 'GOOGLE_FREE'; } catch (e) { return null; }
    }

    // 5. 💾 SAVE
    try {
        const fileName = `speech-${textHash}.mp3`;
        const filePath = path.join(contentDir, fileName);
        fs.writeFileSync(filePath, audioBuffer);
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
        const publicUrl = `${baseUrl}/content/${fileName}`;
        db.VoiceResponse.create({ textHash, originalText: cleanText, audioUrl: publicUrl, voiceId: voiceSource }).catch(()=>{});
        return publicUrl;
    } catch (e) { return null; }
};

module.exports = { generateEdgeAudio };