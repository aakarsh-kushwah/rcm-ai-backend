/**
 * channelSyncService.js  (production-hardened & foolproof)
 *
 * What this service does
 *  1. Syncs a channel's videos from YouTube (Shorts + long videos) into ChannelVideo.
 *  2. Keeps channel metadata (name, logo, subscribers ...) fresh.
 *  3. Daily health check: marks deleted / private / non-embeddable videos as unavailable.
 *  4. Live-stream detection (+ "LIVE now" push notification) for opt-in channels.
 *
 * Key design decisions
 *  - Shorts are taken from YouTube's own Shorts playlist (UUSH...) and long videos from UULF...
 *    If UUSH is empty or missing, it automatically falls back to uploads (UU...) with duration filtering (<= 180s).
 *  - Existing rows keep their isShort value (admin toggles are never overwritten by a sync).
 *  - Incremental sync: stops at the first already-synced video (24h safety margin, upserts are idempotent).
 *  - DB writes are batched (1 SELECT + 1 bulk INSERT per page, no per-video findOrCreate).
 *  - Per-channel / per-job error isolation + overlap guards, so one bad channel never stops the rest.
 *  - Crons run only on PM2 instance 0 (or when NODE_APP_INSTANCE is not set) and never if DISABLE_CRONS=true.
 */

const axios = require('axios');
const cron = require('node-cron');
const EventEmitter = require('events');
const { Op } = require('sequelize');
const { Channel, ChannelVideo } = require('../models');
const { parse } = require('iso8601-duration');

/* ------------------------------------------------------------------ */
/* Logger                                                             */
/* ------------------------------------------------------------------ */
let logger;
try {
  logger = require('../utils/logger');
} catch (e) {
  logger = console;
}
const log = {
  info: (m) => logger.info(String(m)),
  warn: (m) => logger.warn(String(m)),
  error: (m) => logger.error(String(m)),
};

let sendNewVideoAlert = null;
try {
  ({ sendNewVideoAlert } = require('../utils/emailService'));
} catch (e) {
  log.warn('emailService not available - new video alerts disabled.');
}

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */
const YT = 'https://www.googleapis.com/youtube/v3';
const HTTP_TIMEOUT_MS = 10000;
const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

const SHORT_MAX_SECONDS = 180;             // YouTube Shorts can be up to 3 minutes
const RESYNC_MARGIN_MS = 24 * 3600 * 1000; // re-check last 24h on every incremental sync
const MAX_ALERTS_PER_SYNC = 5;             // never email-storm
const CRON_MAX_PAGES = 100;                // 100 x 50 = 5000 videos per playlist per run
const UPDATE_CHUNK = 10;

// live detection
const LIVE_RECHECK_MS = 2 * 60 * 1000;
const DISCOVERY_INTERVAL_MS = (parseInt(process.env.LIVE_DISCOVERY_MINUTES, 10) || 120) * 60 * 1000;
const PRELIVE_WINDOW_MIN = 15;
const MISSED_AFTER_MIN = 45;
const PRELIVE_POLL_MS = 55 * 1000;
const NO_SCHEDULE_POLL_MS = 5 * 60 * 1000;
const MAX_LIVE_MS = 14 * 3600 * 1000;     // safety: a "live" flag older than this is force-closed

class LiveEventEmitter extends EventEmitter {}
const liveEmitter = new LiveEventEmitter();

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
let dailyQuotaSpent = 0;
let lastQuotaLogDate = new Date().toDateString();

function trackQuota(units) {
  const today = new Date().toDateString();
  if (today !== lastQuotaLogDate) {
    log.info(`[Quota Audit] Previous day total quota spent by sync/live jobs: ${dailyQuotaSpent} units.`);
    dailyQuotaSpent = 0;
    lastQuotaLogDate = today;
  }
  dailyQuotaSpent += units;
}

async function ytGet(resource, params) {
  const { data } = await axios.get(`${YT}/${resource}`, {
    params: { ...params, key: process.env.YOUTUBE_API_KEY },
    timeout: HTTP_TIMEOUT_MS,
  });
  return data;
}

function getPlaylistIds(channelId) {
  const cleanId = channelId && channelId.startsWith('UC') ? channelId.slice(2) : channelId;
  return {
    uploads: `UU${cleanId}`,
    longOnly: `UULF${cleanId}`,
    shortsOnly: `UUSH${cleanId}`,
  };
}

function pickThumb(thumbs) {
  if (!thumbs) return null;
  return (thumbs.high && thumbs.high.url) || (thumbs.medium && thumbs.medium.url) || (thumbs.default && thumbs.default.url) || null;
}

function durationSeconds(iso) {
  if (!iso) return 0;
  try {
    const d = parse(iso);
    return (d.days || 0) * 86400 + (d.hours || 0) * 3600 + (d.minutes || 0) * 60 + (d.seconds || 0);
  } catch (e) {
    return 0;
  }
}

function isNotFound(err) {
  return Boolean(err && err.response && err.response.status === 404);
}

function isQuotaOrAuthError(err) {
  const s = err && err.response && err.response.status;
  return s === 403 || s === 429;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* Channel metadata                                                   */
/* ------------------------------------------------------------------ */
async function refreshChannelMetadata(channel, { save = true } = {}) {
  if (!process.env.YOUTUBE_API_KEY || !channel.youtubeChannelId) return;

  try {
    const data = await ytGet('channels', {
      part: 'snippet,statistics,brandingSettings,contentDetails',
      id: channel.youtubeChannelId,
    });
    trackQuota(1);

    const chData = (data.items || [])[0];
    if (!chData) return;

    const sn = chData.snippet || {};
    const st = chData.statistics || {};
    const br = chData.brandingSettings || {};
    const cd = chData.contentDetails || {};

    channel.name = sn.title || channel.name;
    channel.handle = sn.customUrl || channel.handle;
    channel.logoUrl = pickThumb(sn.thumbnails) || channel.logoUrl;
    channel.description = sn.description || channel.description;
    channel.joinedDate = sn.publishedAt ? new Date(sn.publishedAt) : channel.joinedDate;
    channel.country = sn.country || channel.country;
    channel.subscriberCount = st.subscriberCount ? parseInt(st.subscriberCount, 10) : channel.subscriberCount;
    channel.videoCount = st.videoCount ? parseInt(st.videoCount, 10) : channel.videoCount;
    channel.viewCount = st.viewCount ? parseInt(st.viewCount, 10) : channel.viewCount;
    channel.bannerUrl = (br.image && br.image.bannerExternalUrl) || channel.bannerUrl;
    if (!channel.uploadsPlaylistId && cd.relatedPlaylists && cd.relatedPlaylists.uploads) {
      channel.uploadsPlaylistId = cd.relatedPlaylists.uploads;
    }

    if (save) await channel.save();
  } catch (err) {
    log.error(`Error refreshing metadata for channel ${channel.name}: ${err.message}`);
  }
}

let metadataRunning = false;
async function refreshMetadataForAllChannels() {
  if (metadataRunning) return;
  metadataRunning = true;
  try {
    const channels = await Channel.findAll({ where: { isActive: true } });
    for (const channel of channels) {
      await refreshChannelMetadata(channel);
    }
    log.info(`Channel metadata refresh completed (${channels.length} channels).`);
  } catch (err) {
    log.error(`Error in refreshMetadataForAllChannels: ${err.message}`);
  } finally {
    metadataRunning = false;
  }
}

/* ------------------------------------------------------------------ */
/* Video sync                                                         */
/* ------------------------------------------------------------------ */

function buildRow(channel, plSnippet, v, mode) {
  const vs = v.snippet || {};
  const live = vs.liveBroadcastContent || 'none';
  const durationStr = (v.contentDetails && v.contentDetails.duration) || '';
  const totalSeconds = durationSeconds(durationStr);

  let isShort;
  if (mode === 'short') isShort = true;
  else if (mode === 'long') isShort = false;
  else isShort = live === 'none' && totalSeconds > 0 && totalSeconds <= SHORT_MAX_SECONDS;

  const privacy = v.status && v.status.privacyStatus;
  const embeddable = v.status ? v.status.embeddable !== false : true;
  const scheduled = v.liveStreamingDetails && v.liveStreamingDetails.scheduledStartTime;

  return {
    youtubeVideoId: v.id,
    channelId: channel.id,
    title: vs.title || (plSnippet && plSnippet.title) || 'Untitled Video',
    thumbnailUrl: pickThumb(vs.thumbnails) || pickThumb(plSnippet && plSnippet.thumbnails) || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    publishedAt: vs.publishedAt ? new Date(vs.publishedAt) : new Date(),
    isAvailable: privacy ? privacy === 'public' && embeddable : true,
    isShort,
    durationStr,
    totalSeconds,
    viewCount: v.statistics && v.statistics.viewCount ? parseInt(v.statistics.viewCount, 10) : 0,
    liveBroadcastContent: live,
    scheduledStartTime: scheduled ? new Date(scheduled) : null,
  };
}

async function persistRows(channel, rows, ctx) {
  if (rows.length === 0) return;

  const existing = await ChannelVideo.findAll({
    where: { youtubeVideoId: { [Op.in]: rows.map((r) => r.youtubeVideoId) } },
  });
  const byYtId = new Map(existing.map((v) => [v.youtubeVideoId, v]));

  const toCreate = [];
  const toUpdate = [];
  rows.forEach((row) => {
    const ex = byYtId.get(row.youtubeVideoId);
    if (ex) toUpdate.push([ex, row]);
    else toCreate.push(row);
  });

  if (toCreate.length > 0) {
    await ChannelVideo.bulkCreate(toCreate, { ignoreDuplicates: true });
    ctx.newVideos += toCreate.length;
    toCreate.forEach((r) => {
      if (r.isShort) ctx.newShorts += 1;
    });

    if (!ctx.skipAlerts && ctx.lastSyncedAtTime > 0 && typeof sendNewVideoAlert === 'function') {
      for (const r of toCreate) {
        if (ctx.alertsSent >= MAX_ALERTS_PER_SYNC) break;
        try {
          await sendNewVideoAlert({ title: r.title, youtubeVideoId: r.youtubeVideoId, publishedAt: r.publishedAt }, channel.name);
          ctx.alertsSent += 1;
        } catch (e) {}
      }
    }
  }

  for (const part of chunk(toUpdate, UPDATE_CHUNK)) {
    await Promise.all(
      part.map(async ([video, row]) => {
        video.set({
          title: row.title,
          thumbnailUrl: row.thumbnailUrl,
          publishedAt: row.publishedAt,
          isAvailable: row.isAvailable,
          durationStr: row.durationStr,
          totalSeconds: row.totalSeconds,
          viewCount: row.viewCount,
          liveBroadcastContent: row.liveBroadcastContent,
          scheduledStartTime: row.scheduledStartTime,
        });
        if (video.changed()) await video.save();
      })
    );
  }
}

async function syncPlaylist(channel, playlistId, mode, ctx) {
  const cutoff = ctx.lastSyncedAtTime ? ctx.lastSyncedAtTime - RESYNC_MARGIN_MS : 0;
  let pageToken = '';
  let pages = 0;
  let reachedSynced = false;

  do {
    if (ctx.maxPages > 0 && pages >= ctx.maxPages) {
      ctx.truncated = true;
      break;
    }
    pages += 1;

    const pl = await ytGet('playlistItems', {
      part: 'snippet',
      playlistId,
      maxResults: 50,
      pageToken: pageToken || undefined,
    });
    trackQuota(1);

    pageToken = pl.nextPageToken || '';
    const items = pl.items || [];
    const ids = [...new Set(items.map((i) => i.snippet && i.snippet.resourceId && i.snippet.resourceId.videoId).filter(Boolean))];
    if (ids.length === 0) continue;

    const details = await ytGet('videos', {
      part: 'snippet,contentDetails,statistics,status,liveStreamingDetails',
      id: ids.join(','),
    });
    trackQuota(1);
    const detailMap = new Map((details.items || []).map((v) => [v.id, v]));

    const rows = [];
    for (const item of items) {
      const sn = item.snippet;
      const vid = sn && sn.resourceId && sn.resourceId.videoId;
      const v = vid && detailMap.get(vid);
      if (!v) continue;

      const row = buildRow(channel, sn, v, mode);
      if (cutoff && row.publishedAt.getTime() <= cutoff) {
        reachedSynced = true;
        break;
      }
      if (ctx.onlyShorts && !row.isShort) continue;
      rows.push(row);
    }

    await persistRows(channel, rows, ctx);
  } while (pageToken && !reachedSynced);
}

const activeSyncs = new Set();

async function syncChannel(channel, options = {}) {
  const { skipAlerts = false, maxPages = 0, shortsOnly = false } = options;

  if (!process.env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is missing');
  if (!CHANNEL_ID_RE.test(channel.youtubeChannelId || '')) {
    throw new Error(`Channel "${channel.name}" has no valid YouTube channel id (${channel.youtubeChannelId}).`);
  }
  if (activeSyncs.has(channel.id)) return 0;
  activeSyncs.add(channel.id);

  const ctx = {
    lastSyncedAtTime: channel.lastSyncedAt ? new Date(channel.lastSyncedAt).getTime() : 0,
    skipAlerts,
    maxPages,
    onlyShorts: false,
    newVideos: 0,
    newShorts: 0,
    alertsSent: 0,
    truncated: false,
  };

  try {
    channel.lastSyncStatus = 'syncing';
    await channel.save();

    if (!channel.uploadsPlaylistId) await refreshChannelMetadata(channel, { save: false });

    const ids = getPlaylistIds(channel.youtubeChannelId);
    const uploadsId = channel.uploadsPlaylistId || ids.uploads;
    const source = channel.source || (channel.isShortsOnly ? 'shorts-only' : 'channel');
    const wantLong = source !== 'shorts-only' && !shortsOnly;

    const plan = [{ id: ids.shortsOnly, mode: 'short' }];
    if (wantLong) plan.push({ id: ids.longOnly, mode: 'long' });

    let missingPlaylist = false;
    for (const step of plan) {
      try {
        await syncPlaylist(channel, step.id, step.mode, ctx);
      } catch (err) {
        if (isNotFound(err)) {
          missingPlaylist = true;
          log.warn(`Playlist ${step.id} not found for channel ${channel.name}; will use uploads fallback.`);
        } else {
          throw err;
        }
      }
    }

    // ROBUSTNESS FIX: If UUSH playlist returned 0 shorts (API quirk on old channels), force uploads fallback!
    const currentShortsCount = await ChannelVideo.count({ where: { channelId: channel.id, isShort: true } });
    if (missingPlaylist || currentShortsCount === 0) {
      log.info(`[Sync] Shorts playlist UUSH was empty or missing for ${channel.name}. Forcing Uploads playlist fallback scan.`);
      ctx.onlyShorts = !wantLong;
      await syncPlaylist(channel, uploadsId, 'auto', ctx);
    }

    const partial = ctx.truncated || (shortsOnly && source !== 'shorts-only');
    if (!partial) channel.lastSyncedAt = new Date();
    channel.lastSyncStatus = 'ok';
    channel.lastSyncError = null;
    channel.shortsCount = await ChannelVideo.count({ where: { channelId: channel.id, isShort: true } });
    await channel.save();

    log.info(`[Sync] ${channel.name}: +${ctx.newVideos} new (${ctx.newShorts} shorts), total shorts ${channel.shortsCount}${partial ? ' [partial]' : ''}.`);
    return ctx.newVideos;
  } catch (err) {
    log.error(`Error syncing channel ${channel.name}: ${err.message}`);
    try {
      channel.lastSyncStatus = 'error';
      channel.lastSyncError = String(err.message).slice(0, 500);
      await channel.save();
    } catch (saveErr) {}
    throw err;
  } finally {
    activeSyncs.delete(channel.id);
  }
}

let syncAllRunning = false;
async function syncAllActiveChannels() {
  if (syncAllRunning) return;
  syncAllRunning = true;
  try {
    const channels = await Channel.findAll({ where: { isActive: true } });
    for (const channel of channels) {
      try {
        await syncChannel(channel, { maxPages: CRON_MAX_PAGES });
      } catch (err) {
        if (isQuotaOrAuthError(err)) break;
      }
    }
  } catch (err) {
  } finally {
    syncAllRunning = false;
  }
}

/* ------------------------------------------------------------------ */
/* Video health                                                       */
/* ------------------------------------------------------------------ */
let healthRunning = false;
async function checkVideoHealth() {
  if (!process.env.YOUTUBE_API_KEY || healthRunning) return;
  healthRunning = true;
  try {
    let lastId = null;
    for (;;) {
      const rows = await ChannelVideo.findAll({
        attributes: ['id', 'youtubeVideoId', 'isAvailable'],
        where: lastId ? { id: { [Op.gt]: lastId } } : {},
        order: [['id', 'ASC']],
        limit: 500,
        raw: true,
      });
      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id;

      for (const batch of chunk(rows, 50)) {
        try {
          const data = await ytGet('videos', { part: 'status', id: batch.map((v) => v.youtubeVideoId).join(',') });
          trackQuota(1);

          const okIds = new Set();
          (data.items || []).forEach((item) => {
            const st = item.status || {};
            if (st.privacyStatus === 'public' && st.embeddable !== false) okIds.add(item.id);
          });

          const makeAvailable = [];
          const makeUnavailable = [];
          batch.forEach((v) => {
            const available = okIds.has(v.youtubeVideoId);
            if (available && !v.isAvailable) makeAvailable.push(v.id);
            if (!available && v.isAvailable) makeUnavailable.push(v.id);
          });
          if (makeAvailable.length) await ChannelVideo.update({ isAvailable: true }, { where: { id: { [Op.in]: makeAvailable } } });
          if (makeUnavailable.length) await ChannelVideo.update({ isAvailable: false }, { where: { id: { [Op.in]: makeUnavailable } } });
        } catch (batchErr) {
          if (isQuotaOrAuthError(batchErr)) throw batchErr;
        }
      }
    }
  } catch (err) {
  } finally {
    healthRunning = false;
  }
}

/* ------------------------------------------------------------------ */
/* Live detection & Notifications                                     */
/* ------------------------------------------------------------------ */
async function getVideoLiveStatus(videoId) {
  if (!process.env.YOUTUBE_API_KEY || !videoId) return null;
  try {
    const data = await ytGet('videos', { part: 'snippet,liveStreamingDetails', id: videoId });
    trackQuota(1);

    const item = (data.items || [])[0];
    if (!item) return false;

    const sn = item.snippet || {};
    const ld = item.liveStreamingDetails || {};
    return {
      videoId: item.id,
      title: sn.title || 'Untitled Video',
      thumbnailUrl: pickThumb(sn.thumbnails) || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      liveBroadcastContent: sn.liveBroadcastContent || 'none',
      scheduledStartTime: ld.scheduledStartTime ? new Date(ld.scheduledStartTime) : null,
      actualStartTime: ld.actualStartTime ? new Date(ld.actualStartTime) : null,
      actualEndTime: ld.actualEndTime ? new Date(ld.actualEndTime) : null,
    };
  } catch (err) {
    return null;
  }
}

function triggerLiveTransition(data) {
  liveEmitter.emit('upcomingToLive', data);
}

liveEmitter.on('upcomingToLive', async ({ channel, videoId }) => {
  try {
    const [claimed] = await Channel.update(
      { lastNotifiedVideoId: videoId },
      {
        where: {
          id: channel.id,
          [Op.or]: [{ lastNotifiedVideoId: null }, { lastNotifiedVideoId: { [Op.ne]: videoId } }],
        },
      }
    );
    if (!claimed) return;

    const nc = require('../controllers/notificationController');
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const payload = {
      title: process.env.LIVE_NOTIFY_TITLE || 'RCM Gurukul is LIVE now',
      body: process.env.LIVE_NOTIFY_BODY || "TC Sir's session has started — tap to join",
      actionUrl: url,
      dataPayload: { videoId, channelId: channel.id, type: 'live_stream', url },
    };

    if (typeof nc.broadcastNotification === 'function') {
      await nc.broadcastNotification(payload);
    } else if (typeof nc.sendTitanBroadcast === 'function') {
      await nc.sendTitanBroadcast(null, null, payload, true);
    }
  } catch (err) {}
});

function resetUpcoming(channel) {
  channel.upcomingVideoId = null;
  channel.scheduledStartTime = null;
  channel.discoveredAt = null;
}

async function markChannelLive(channel, videoId, startedAt, scheduledStartTime) {
  const started = startedAt || new Date();
  channel.isCurrentlyLive = true;
  channel.liveVideoId = videoId;
  channel.upcomingVideoId = videoId;
  channel.liveStartedAt = started;
  channel.lastKnownLiveStartTime = started;
  channel.lastLiveCheckAt = new Date();
  await channel.save();

  triggerLiveTransition({ channel, videoId, scheduledStartTime: scheduledStartTime || null, liveStartedAt: started });
}

async function finishLive(channel, status, now) {
  channel.isCurrentlyLive = false;
  channel.liveVideoId = null;
  channel.liveStartedAt = null;
  resetUpcoming(channel);
  channel.lastLiveCheckAt = now;
  await channel.save();

  if (!status) return;
  try {
    const [, created] = await ChannelVideo.findOrCreate({
      where: { youtubeVideoId: status.videoId },
      defaults: {
        channelId: channel.id,
        title: status.title,
        thumbnailUrl: status.thumbnailUrl,
        publishedAt: status.actualStartTime || now,
        isAvailable: true,
        isShort: false,
      },
    });
    if (!created) {
      await ChannelVideo.update(
        { title: status.title, thumbnailUrl: status.thumbnailUrl, isAvailable: true },
        { where: { youtubeVideoId: status.videoId } }
      );
    }
  } catch (vodErr) {}
}

async function runPhaseADiscovery(channel) {
  if (!process.env.YOUTUBE_API_KEY || !channel.uploadsPlaylistId) return;

  const since = channel.lastLiveCheckAt ? Date.now() - new Date(channel.lastLiveCheckAt).getTime() : Infinity;
  if (since < DISCOVERY_INTERVAL_MS) return;

  try {
    const pl = await ytGet('playlistItems', { part: 'snippet', playlistId: channel.uploadsPlaylistId, maxResults: 10 });
    trackQuota(1);

    const ids = (pl.items || []).map((i) => i.snippet && i.snippet.resourceId && i.snippet.resourceId.videoId).filter(Boolean);
    if (ids.length === 0) {
      channel.lastLiveCheckAt = new Date();
      await channel.save();
      return;
    }

    const vids = await ytGet('videos', { part: 'snippet,liveStreamingDetails', id: ids.join(',') });
    trackQuota(1);
    const items = vids.items || [];

    const liveNow = items.find((v) => v.snippet && v.snippet.liveBroadcastContent === 'live');
    if (liveNow) {
      const ld = liveNow.liveStreamingDetails || {};
      await markChannelLive(channel, liveNow.id, ld.actualStartTime ? new Date(ld.actualStartTime) : new Date(), ld.scheduledStartTime ? new Date(ld.scheduledStartTime) : null);
      return;
    }

    const upcoming = items
      .filter((v) => v.snippet && v.snippet.liveBroadcastContent === 'upcoming')
      .map((v) => ({ id: v.id, at: v.liveStreamingDetails && v.liveStreamingDetails.scheduledStartTime ? new Date(v.liveStreamingDetails.scheduledStartTime) : null }))
      .sort((a, b) => (a.at ? a.at.getTime() : Infinity) - (b.at ? b.at.getTime() : Infinity))[0];

    if (upcoming) {
      channel.upcomingVideoId = upcoming.id;
      channel.scheduledStartTime = upcoming.at;
      channel.discoveredAt = new Date();
    } else if (channel.upcomingVideoId || channel.scheduledStartTime) {
      resetUpcoming(channel);
    }
    channel.lastLiveCheckAt = new Date();
    await channel.save();
  } catch (err) {}
}

async function processLiveChannelState(channel) {
  const now = new Date();
  const nowMs = now.getTime();
  const since = (d) => (d ? nowMs - new Date(d).getTime() : Infinity);

  if (channel.isCurrentlyLive && channel.liveVideoId) {
    const tooLong = channel.liveStartedAt && since(channel.liveStartedAt) > MAX_LIVE_MS;
    if (!tooLong && since(channel.lastLiveCheckAt) < LIVE_RECHECK_MS) return;

    const status = tooLong ? false : await getVideoLiveStatus(channel.liveVideoId);
    if (status === null) return;

    if (status === false || status.liveBroadcastContent === 'none' || status.actualEndTime) {
      await finishLive(channel, status || null, now);
    } else {
      channel.lastLiveCheckAt = now;
      await channel.save();
    }
    return;
  }

  if (channel.upcomingVideoId) {
    let scheduled = channel.scheduledStartTime ? new Date(channel.scheduledStartTime) : null;
    if (scheduled) {
      const diffMin = (scheduled.getTime() - nowMs) / 60000;
      if (diffMin > PRELIVE_WINDOW_MIN) return;
      if (diffMin < -MISSED_AFTER_MIN) {
        resetUpcoming(channel);
        channel.lastLiveCheckAt = now;
        await channel.save();
        return;
      }
      if (since(channel.lastLiveCheckAt) < PRELIVE_POLL_MS) return;
    } else if (since(channel.lastLiveCheckAt) < NO_SCHEDULE_POLL_MS) {
      return;
    }

    const status = await getVideoLiveStatus(channel.upcomingVideoId);
    if (status === null) return;

    channel.lastLiveCheckAt = now;
    if (status === false || (status.liveBroadcastContent === 'none' && status.actualEndTime)) {
      resetUpcoming(channel);
      await channel.save();
    } else if (status.liveBroadcastContent === 'live') {
      await markChannelLive(channel, channel.upcomingVideoId, status.actualStartTime || now, channel.scheduledStartTime);
    } else {
      await channel.save();
    }
    return;
  }

  await runPhaseADiscovery(channel);
}

async function checkLiveAndUpcomingStatus() {
  try {
    const channels = await Channel.findAll({ where: { isActive: true, checkLiveStatus: true } });
    for (const channel of channels) {
      if (!channel.youtubeChannelId || !channel.uploadsPlaylistId) continue;
      try {
        await processLiveChannelState(channel);
      } catch (err) {}
    }
  } catch (err) {}
}

/* ------------------------------------------------------------------ */
/* Crons                                                             */
/* ------------------------------------------------------------------ */
function shouldRunCrons() {
  if (process.env.DISABLE_CRONS === 'true') return false;
  const inst = process.env.NODE_APP_INSTANCE;
  return inst === undefined || inst === '' || inst === '0';
}

if (shouldRunCrons()) {
  try {
    cron.schedule('0 * * * *', () => { syncAllActiveChannels(); });
    cron.schedule('0 */6 * * *', () => { refreshMetadataForAllChannels(); });
    cron.schedule('0 3 * * *', () => { checkVideoHealth(); }, { timezone: 'Asia/Kolkata' });
    cron.schedule('* * * * *', () => { checkLiveAndUpcomingStatus(); });
  } catch (err) {}
}

module.exports = {
  getPlaylistIds,
  syncChannel,
  syncAllActiveChannels,
  refreshChannelMetadata,
  refreshMetadataForAllChannels,
  checkVideoHealth,
  checkLiveAndUpcomingStatus,
  runPhaseADiscovery,
  getVideoLiveStatus,
  liveEmitter,
  triggerLiveTransition,
};