/**
 * @file rcm-ai-backend/utils/textSanitizer.js
 * @description Advanced text sanitization for Text-to-Speech (TTS) optimization.
 */

/**
 * Sanitizes text for TTS by removing markdown, emojis, and unwanted symbols.
 * @param {string} text - Raw AI response text.
 * @returns {string} - Clean, professional text for audio synthesis.
 */
const sanitizeForTTS = (text) => {
    if (!text) return "";

    let clean = text;

    // 1. Remove Markdown Code Blocks (```code```)
    clean = clean.replace(/```[\s\S]*?```/g, "");

    // 2. Remove Inline Code (`code`)
    clean = clean.replace(/`.*?`/g, "");

    // 3. Remove Bold/Italic/Strikethrough Markdown (*, #, **, __, ~~)
    clean = clean.replace(/[*#_~]/g, "");

    // 4. Remove Emojis
    // Source: https://stackoverflow.com/questions/43242440/javascript-regular-expression-for-unicode-emoji
    clean = clean.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, "");

    // 5. Remove URL links ([text](url)) - Keep only the text
    clean = clean.replace(/\[(.*?)\]\(.*?\)/g, "$1");

    // 6. Remove HTML Tags
    clean = clean.replace(/<.*?>/g, "");

    // 7. Cleanup extra spaces and newlines
    clean = clean.replace(/\s+/g, " ").trim();

    // 8. Hindi Specific Tweaks (Optional but recommended for natural flow)
    clean = clean
        .replace(/RCM/gi, "आर सी एम")
        .replace(/PV/gi, "पी वी")
        .replace(/BV/gi, "बी वी")
        .replace(/DP/gi, "डी पी")
        .replace(/MRP/gi, "एम आर पी");

    return clean;
};

module.exports = { sanitizeForTTS };
