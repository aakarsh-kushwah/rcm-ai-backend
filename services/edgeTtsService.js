/**
 * @file src/services/edgeTtsService.js
 * @description 🚀 RCM "SWARA" ENGINE (Female Professional Voice)
 * @tuning Voice: SwaraNeural | Tone: Polite, Soft & Confident
 */

const { db } = require('../config/db'); 
const crypto = require('crypto');
const googleTTS = require('google-tts-api');
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const { uploadAudioToCloudinary } = require('./cloudinaryService'); 
require('dotenv').config();

const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION;

// 🎛️ SWARA TUNING (Female Voice Settings)
const TUNING = {
    VOICE_NAME:    "hi-IN-SwaraNeural", // 👈 THE CHANGE
    SILENCE_BUFFER:"300ms",             // Soft Start
    
    // Female voice natural speed par hi achi lagti hai
    SPEED_FAST:    "+15%", // Josh
    SPEED_NORMAL:  "+10%", // Normal
    
    // Pitch ko '0Hz' rakhenge (Natural), ya thoda badhayenge softness ke liye
    PITCH_NATURAL: "+0Hz", 
};

// 🧹 SAFETY: XML Special Chars
function escapeXML(unsafe) {
    if (!unsafe) return "";
    return unsafe.replace(/[<>&'"]/g, c => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}

// 🧠 1. CONTEXT ENGINE (Swara ka Mood)
function analyzeSentiment(text) {
    if (!text) return { rate: TUNING.SPEED_NORMAL, pitch: "0Hz", style: "cheerful", degree: "1.0" };
    const lowerText = text.toLowerCase();

    // 1. Josh / Welcome (Cheerful & Bright)
    if (lowerText.match(/(swagat|badhai|shandar|zabardast|target|jeet|profit|crore|jai rcm|mission|bada|toofan)/)) {
        return { rate: TUNING.SPEED_FAST, pitch: "+2Hz", style: "cheerful", degree: "1.5" };
    }
    
    // 2. Empathy / Help (Very Soft & Polite)
    if (lowerText.match(/(maafi|sorry|samasya|dikkat|dukh|loss|haar|chinta|dhyan|samajh|galti|sochiye)/)) {
        return { rate: "+5%", pitch: "-2Hz", style: "empathetic", degree: "1.2" };
    }

    // 3. Default Professional (Confident but Sweet)
    // Swara ke liye "chat" style best nahi hai, "cheerful" kam degree par best hai
    return { rate: TUNING.SPEED_NORMAL, pitch: TUNING.PITCH_NATURAL, style: "cheerful", degree: "0.8" };
}

// 🗣️ 2. HINDI PHONETICS (Swara ke liye optimized)
function optimizeTextForHumanSpeech(text) {
    if (!text) return "";
    
    let script = escapeXML(text);

    // Filler Emotion (Swara ke 'Hmm' aur 'Achha' soft hone chahiye)
    script = script.replace(/हम्म/g, `<prosody pitch="-2Hz" rate="-10%" volume="-20%">हम्म...</prosody>`);
    script = script.replace(/Hmm/gi, `<prosody pitch="-2Hz" rate="-10%" volume="-20%">हम्म...</prosody>`);
    
    script = script.replace(/अच्छा/g, `<prosody pitch="+1Hz" rate="-5%">अच्छा...</prosody>`);
    script = script.replace(/Achha/gi, `<prosody pitch="+1Hz" rate="-5%">अच्छा...</prosody>`);

    script = script.replace(/जी/g, `<prosody pitch="+2Hz" rate="-5%" volume="-10%">जी</prosody>`);
    script = script.replace(/Ji/gi, `<prosody pitch="+2Hz" rate="-5%" volume="-10%">जी</prosody>`);

    // Dictionary (English words ko Hindi accent dena)
    const dictionary = {
        "RCM": "आर सी एम",
        "Business": "बिज़नेस",
        "Product": "प्रॉडक्ट",
        "System": "सिस्टम",
        "Plan": "प्लान",
        "Target": "टारगेट",
        "Meeting": "मीटिंग",
        "Leader": "लीडर",
        "Team": "टीम",
        "Direct Seller": "डायरेक्ट सेलर",
        "Royalty": "रॉयल्टी",
        "Upline": "अपलाइन",
        "Downline": "डाउनलाइन",
        "Nutricharge": "न्यूट्रीचार्ज",
        "Gamma": "गामा",
        "Oryzanol": "ओरिज़ानॉल"
    };

    Object.keys(dictionary).forEach(key => {
        const regex = new RegExp(key, "gi");
        script = script.replace(regex, dictionary[key]);
    });

    // Random Breathing (Natural Pauses)
    script = script.replace(/(\||\.)/g, () => {
        const pause = ["300ms", "400ms"][Math.floor(Math.random() * 2)];
        return `.<break time="${pause}"/>`;
    }); 
    script = script.replace(/(,)/g, `,<break time="150ms"/>`);   

    return script;
}

// 🎨 3. SSML BUILDER
function createCinematicSSML(text) {
    let mood = analyzeSentiment(text);
    const actingScript = optimizeTextForHumanSpeech(text);

    if (!mood || !mood.style) mood = { rate: "+10%", pitch: "0Hz", style: "cheerful", degree: "1.0" };

    // Single Line Return (No Spaces)
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="hi-IN"><voice name="${TUNING.VOICE_NAME}"><break time="${TUNING.SILENCE_BUFFER}"/><mstts:express-as style="${mood.style}" styledegree="${mood.degree}"><prosody rate="${mood.rate}" pitch="${mood.pitch}">${actingScript}</prosody></mstts:express-as></voice></speak>`;
}

const synthesizeWithAzureToBuffer = (text) => {
    return new Promise((resolve, reject) => {
        if (!AZURE_KEY || !AZURE_REGION) return reject("Azure Credentials Missing");

        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = TUNING.VOICE_NAME; 
        
        // 24kHz (Best Balance for Female Voice)
        speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3;

        const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null); 
        
        try {
            const ssml = createCinematicSSML(text);
            synthesizer.speakSsmlAsync(
                ssml,
                result => {
                    synthesizer.close();
                    if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                        resolve(Buffer.from(result.audioData));
                    } else {
                        console.error("Azure SSML Error:", result.errorDetails);
                        reject(result.errorDetails);
                    }
                },
                err => { synthesizer.close(); reject(err); }
            );
        } catch (error) { synthesizer.close(); reject(error); }
    });
};

const generateEdgeAudio = async (text) => {
    if (!text) return null;
    const cleanText = text.replace(/[*#]/g, '').trim(); 
    const textHash = generateTextHash(cleanText);

    try {
        const cachedEntry = await db.VoiceResponse.findOne({ where: { textHash } });
        if (cachedEntry && cachedEntry.audioUrl) return cachedEntry.audioUrl;
    } catch (e) {}

    let audioBuffer = null;
    let voiceSource = 'AZURE_SWARA_FEMALE';

    try { audioBuffer = await synthesizeWithAzureToBuffer(cleanText); } catch (e) { 
        console.warn("Azure Failed, switching to Google:", e); 
    }

    if (!audioBuffer) {
        try {
            const url = googleTTS.getAudioUrl(cleanText.substring(0, 200), { lang: 'hi', slow: false });
            const axios = require('axios');
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            audioBuffer = Buffer.from(response.data);
            voiceSource = 'GOOGLE_FREE';
        } catch (err) {}
    }

    if (audioBuffer) {
        const cloudUrl = await uploadAudioToCloudinary(audioBuffer, textHash);
        if (cloudUrl) {
            await db.VoiceResponse.create({ textHash, originalText: cleanText, audioUrl: cloudUrl, voiceType: voiceSource }).catch(()=>{});
            return cloudUrl;
        }
    }
    return null;
};

function generateTextHash(text) {
    return crypto.createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

module.exports = { generateEdgeAudio };