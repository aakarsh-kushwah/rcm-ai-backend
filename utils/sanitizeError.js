function sanitizeHeaders(headers = {}) {
  const next = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase();
    if (['cookie', 'set-cookie', 'authorization', 'x-api-key', 'x-auth-token', 'proxy-authorization'].includes(lower)) {
      next[key] = '[REDACTED]';
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

function redactSecrets(value) {
  if (typeof value === 'string') {
    return value
      .replace(/(password\s*[:=]\s*)([^\s&]+|"[^"]+")/gi, '$1[REDACTED]')
      .replace(/(Authorization\s*[:=]\s*)(Bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/(cookie\s*[:=]\s*)([^\r\n]+)/gi, '$1[REDACTED]')
      .replace(/(token\s*[:=]\s*)([^\s&]+|"[^"]+")/gi, '$1[REDACTED]');
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, nested] of Object.entries(value)) {
      const lower = String(key).toLowerCase();
      if (['password', 'passwd', 'secret', 'token', 'authorization', 'cookie', 'set-cookie', 'x-api-key', 'header', 'headers'].includes(lower)) {
        copy[key] = '[REDACTED]';
      } else {
        copy[key] = redactSecrets(nested);
      }
    }
    return copy;
  }

  return value;
}

function sanitizeError(err, fallbackMessage = 'Request failed') {
  if (!err) {
    return new Error(fallbackMessage);
  }

  const message = err.message || fallbackMessage;
  const sanitized = new Error(message);
  sanitized.name = err.name || 'Error';
  sanitized.code = err.code;
  sanitized.status = err.response && err.response.status ? err.response.status : err.status;
  sanitized.isAxiosError = Boolean(err.isAxiosError);

  if (err.response) {
    sanitized.response = {
      status: err.response.status,
      statusText: err.response.statusText,
      headers: sanitizeHeaders(err.response.headers),
      data: redactSecrets(err.response.data)
    };
  }

  if (err.config) {
    sanitized.config = {
      method: err.config.method,
      baseURL: err.config.baseURL,
      url: err.config.url,
      headers: sanitizeHeaders(err.config.headers),
      params: redactSecrets(err.config.params),
      data: undefined
    };
  }

  if (err.request) {
    sanitized.request = {
      method: err.request.method,
      url: err.request.responseURL || err.request.path || err.request._header || undefined
    };
  }

  sanitized.stack = err.stack ? redactSecrets(err.stack) : undefined;
  return sanitized;
}

module.exports = { sanitizeError, sanitizeHeaders, redactSecrets };
