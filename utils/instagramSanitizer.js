/**
 * Instagram URL and Username Sanitizer Utility
 * 
 * Bulletproof normalization and extraction of Instagram usernames from
 * various input formats (usernames, profile URLs, post/reel URLs, query params).
 */

/**
 * Clean, normalize, and validate an Instagram username or URL.
 * 
 * @param {string} input - The input string (username, profile URL, post/reel URL)
 * @returns {string|null} - Sanitized lowercase username string or null if invalid
 */
function cleanInstagramUsername(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }

  let cleaned = input.trim();
  if (!cleaned) {
    return null;
  }

  try {
    // Check if input is a URL or contains domain/protocol/www
    if (
      cleaned.includes('instagram.com') ||
      cleaned.includes('instagr.am') ||
      cleaned.startsWith('http://') ||
      cleaned.startsWith('https://') ||
      cleaned.startsWith('www.')
    ) {
      if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
        cleaned = 'https://' + cleaned;
      }

      const parsedUrl = new URL(cleaned);
      const pathname = parsedUrl.pathname;
      const segments = pathname.split('/').filter(Boolean);

      if (segments.length === 0) {
        return null;
      }

      const reserved = [
        'p',
        'reel',
        'reels',
        'tv',
        'explore',
        'accounts',
        'direct',
        'sharer',
        'graphql',
        'stories'
      ];

      if (segments[0] === 'stories') {
        // e.g. /stories/username/12345
        cleaned = segments[1] || '';
      } else if (reserved.includes(segments[0])) {
        // Post/reel/explore URL without username in path (e.g. /reel/ABC123xyz/)
        return null;
      } else {
        // Standard profile URL or /username/reel/...
        cleaned = segments[0];
      }
    }
  } catch (err) {
    // Fallback if URL parsing throws an error on malformed input strings
  }

  // Remove leading '@' if present
  if (cleaned.startsWith('@')) {
    cleaned = cleaned.substring(1);
  }

  // Strip query parameters, hash fragments, or path segments if any remain
  const queryIndex = cleaned.indexOf('?');
  if (queryIndex !== -1) {
    cleaned = cleaned.substring(0, queryIndex);
  }
  const hashIndex = cleaned.indexOf('#');
  if (hashIndex !== -1) {
    cleaned = cleaned.substring(0, hashIndex);
  }

  cleaned = cleaned.split('/')[0];
  cleaned = cleaned.trim().toLowerCase();

  // Validate Instagram username rules:
  // - Only letters, numbers, periods, and underscores
  // - Length: 1 to 30 characters
  const usernameRegex = /^[a-z0-9._]{1,30}$/;
  if (!usernameRegex.test(cleaned)) {
    return null;
  }

  // Cannot start or end with a period
  if (cleaned.startsWith('.') || cleaned.endsWith('.')) {
    return null;
  }

  return cleaned;
}

module.exports = { cleanInstagramUsername };
