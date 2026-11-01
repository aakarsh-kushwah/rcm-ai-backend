'use strict';

function parseQuery(input = '') {
  const text = String(input || '').trim();
  if (!text) {
    return {
      minPv: null,
      maxPv: null,
      targetPv: null,
      leg: null,
      zeroPvMonths: null,
      pureConsumers: false,
      raw: '',
    };
  }

  const result = { minPv: null, maxPv: null, targetPv: null, leg: null, zeroPvMonths: null, pureConsumers: false, raw: text };

  const rangeMatch = text.match(/(\d+)\s*(?:to|se|-)\s*(\d+)\s*(?:pv)?/i);
  if (rangeMatch) {
    result.minPv = Number(rangeMatch[1]);
    result.maxPv = Number(rangeMatch[2]);
  }

  const slabMatch = text.match(/(\d+)\s*pv/i);
  if (slabMatch && result.minPv == null && result.maxPv == null) {
    result.targetPv = Number(slabMatch[1]);
  }

  const legMatch = text.match(/(?:leg|group)\s*([abc])/i);
  if (legMatch) {
    const legValue = String(legMatch[1]).toUpperCase();
    result.leg = ['A', 'B', 'C'].includes(legValue) ? legValue : null;
  }

  const zeroMatch = text.match(/(?:0|zero)\s*pv|(?:(\d+)\s*(?:mahine|month))/i);
  if (zeroMatch) {
    result.zeroPvMonths = Number(zeroMatch[1] || 0) || 0;
  }

  const pureConsumerMatch = /bina referral|pure consumer|0 joining/i.test(text);
  if (pureConsumerMatch) {
    result.pureConsumers = true;
  }

  return result;
}

module.exports = { parseQuery };
