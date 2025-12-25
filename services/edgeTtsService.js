/**
 * @file src/services/edgeTtsService.js
 * @description Hybrid Voice Engine: ElevenLabs (Quality) -> Google TTS (Reliability).
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { db } = require('../config/db'); 
const crypto = require('crypto');
const googleTTS = require('google-tts-api'); // ✅ 100% Working Backup
require('dotenv').config();

// 🔧 CONFIG
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel

// 📂 Ensure Content Directory
const contentDir = path.join(__dirname, '../content');
if (!fs.existsSync(contentDir)) fs.mkdirSync(contentDir, { recursive: true });

function generateTextHash(text) {
    return crypto.createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

/**
 * 🚀 MAIN FUNCTION
 */
const generateEdgeAudio = async (text) => {
    if (!text) return null;
    const cleanText = text.replace(/[*#]/g, '').trim(); 
    const textHash = generateTextHash(cleanText);

    // 1. ⚡ CACHE CHECK (Sabse Pehle DB)
    const cachedEntry = await db.VoiceResponse.findOne({ where: { textHash } });
    if (cachedEntry && cachedEntry.audioUrl) {
        console.log("⚡ [Cache Hit] Serving saved audio.");
        return cachedEntry.audioUrl;
    }

    let audioBuffer = null;
    let voiceSource = 'ELEVENLABS';

    // 2. 💎 LAYER 1: ELEVENLABS (Premium)
    try {
        if (ELEVENLABS_API_KEY) {
            const response = await axios({
                method: 'POST',
                url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
                data: { 
                    text: cleanText.substring(0, 500), 
                    model_id: "eleven_multilingual_v2", 
                    voice_settings: { stability: 0.5, similarity_boost: 0.8 } 
                },
                headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
                responseType: 'arraybuffer'
            });
            audioBuffer = response.data;
        }
    } catch (e) {
        console.warn("⚠️ ElevenLabs Skipped (Quota/Key issue).");
    }

    // 3. 🛡️ LAYER 2: GOOGLE TTS (Ultimate Backup)
    if (!audioBuffer) {
        console.log("🔄 Fallback: Switching to Google TTS...");
        try {
            const safeText = cleanText.substring(0, 200); // Google Limit
            const url = googleTTS.getAudioUrl(safeText, {
                lang: 'hi',
                slow: false,
                host: 'https://translate.google.com',
            });
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            audioBuffer = response.data;
            voiceSource = 'GOOGLE_FREE';
        } catch (err) {
            console.error("❌ Google TTS Fail:", err.message);
        }
    }

    // 4. ❌ TOTAL FAILURE
    if (!audioBuffer) return null;

    // 5. 💾 SAVE FILE
    try {
        const fileName = `speech-${textHash}.mp3`;
        const filePath = path.join(contentDir, fileName);
        fs.writeFileSync(filePath, audioBuffer);

        const publicUrl = `${process.env.BASE_URL || 'http://localhost:10000'}/content/${fileName}`;
        
        // Save to DB
        db.VoiceResponse.create({
            textHash, originalText: cleanText, audioUrl: publicUrl, voiceId: voiceSource
        }).catch(()=>{});

        return publicUrl;
    } catch (e) {
        return null;
    }
};

module.exports = { generateEdgeAudio };