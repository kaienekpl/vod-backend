const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";
const TWITCH_LOGIN = process.env.TWITCH_LOGIN || "kaienekpl";

function assertEnv() {
  const missing = [];
  if (!TWITCH_CLIENT_ID) missing.push("TWITCH_CLIENT_ID");
  if (!TWITCH_CLIENT_SECRET) missing.push("TWITCH_CLIENT_SECRET");
  if (!TWITCH_LOGIN) missing.push("TWITCH_LOGIN");

  if (missing.length) {
    const err = new Error("Missing environment variables: " + missing.join(", "));
    err.statusCode = 500;
    throw err;
  }
}

async function getAppAccessToken() {
  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", TWITCH_CLIENT_ID);
  url.searchParams.set("client_secret", TWITCH_CLIENT_SECRET);
  url.searchParams.set("grant_type", "client_credentials");

  const res = await fetch(url.toString(), { method: "POST" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Twitch token error: " + text);
  }

  const data = await res.json();
  return data.access_token;
}

async function twitchGet(path, token, query = {}) {
  const url = new URL(`https://api.twitch.tv/helix/${path}`);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.append(key, String(value));
    }
  });

  const res = await fetch(url.toString(), {
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      "Authorization": `Bearer ${token}`
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitch API error (${path}): ${text}`);
  }

  return res.json();
}

function normalizeThumbnailUrl(thumbnailUrl, width = 320, height = 180) {
  if (!thumbnailUrl) return "";
  return thumbnailUrl
    .replace("%{width}", String(width))
    .replace("%{height}", String(height));
}

function normalizeBoxArtUrl(boxArtUrl, width = 188, height = 250) {
  if (!boxArtUrl) return "";
  return boxArtUrl
    .replace("{width}", String(width))
    .replace("{height}", String(height));
}

function deriveStoryboardUrl(thumbnailUrl, vodId) {
  try {
    if (!thumbnailUrl || !vodId) return "";

    const normalized = thumbnailUrl.replace("https://static-cdn.jtvnw.net/cf_vods/", "");
    const parts = normalized.split("/").filter(Boolean);

    if (parts.length < 3) return "";

    const cloudfrontHostKey = parts[0];
    const vodPathKey = parts[1];

    if (!cloudfrontHostKey || !vodPathKey) return "";

    return `https://${cloudfrontHostKey}.cloudfront.net/${vodPathKey}/storyboards/${vodId}-strip-0.jpg`;
  } catch (_err) {
    return "";
  }
}

async function getUserByLogin(token, login) {
  const users = await twitchGet("users", token, { login });
  const user = users && users.data ? users.data[0] : null;

  if (!user) {
    const err = new Error(`Twitch user not found for login: ${login}`);
    err.statusCode = 404;
    throw err;
  }

  return user;
}

async function getChannelInfo(token, broadcasterId) {
  const channels = await twitchGet("channels", token, { broadcaster_id: broadcasterId });
  return channels && channels.data ? channels.data[0] || null : null;
}

async function getGameInfo(token, gameId) {
  if (!gameId) {
    return {
      game_id: "",
      game_name: "",
      box_art_url: ""
    };
  }

  const games = await twitchGet("games", token, { id: gameId });
  const game = games && games.data ? games.data[0] || null : null;

  return {
    game_id: game && game.id ? game.id : gameId,
    game_name: game && game.name ? game.name : "",
    box_art_url: normalizeBoxArtUrl(game && game.box_art_url ? game.box_art_url : "", 188, 250)
  };
}

async function getLatestVodData(token, login) {
  const user = await getUserByLogin(token, login);

  const videos = await twitchGet("videos", token, {
    user_id: user.id,
    type: "archive",
    first: 1
  });

  const vod = videos && videos.data ? videos.data[0] : null;
  if (!vod) {
    const err = new Error(`No archive VOD found for login: ${login}`);
    err.statusCode = 404;
    throw err;
  }

  const thumbnailSmall = normalizeThumbnailUrl(vod.thumbnail_url, 320, 180);
  const thumbnailLarge = normalizeThumbnailUrl(vod.thumbnail_url, 640, 360);
  const storyboardUrl = deriveStoryboardUrl(thumbnailSmall, vod.id);

  let categorySource = "none";
  let gameData = { game_id: "", game_name: "", box_art_url: "" };

  if (vod.game_id) {
    gameData = await getGameInfo(token, vod.game_id);
    categorySource = gameData.game_id ? "video" : "none";
  }

  if (!gameData.game_id) {
    const channel = await getChannelInfo(token, user.id);
    if (channel && channel.game_id) {
      gameData = await getGameInfo(token, channel.game_id);
      if (gameData.game_id) categorySource = "channel_fallback";
    }
  }

  return {
    ok: true,
    service: "VOD_BACKEND_TWITCH",
    broadcaster_login: login,
    broadcaster_name: vod.user_name || user.display_name || login,
    user_id: user.id,
    vod_id: vod.id,
    title: vod.title,
    url: vod.url,
    created_at: vod.created_at,
    published_at: vod.published_at,
    duration: vod.duration,
    view_count: vod.view_count,
    thumbnail_url: thumbnailSmall,
    thumbnail_url_large: thumbnailLarge,
    storyboard_url: storyboardUrl,
    game_id: gameData.game_id,
    game_name: gameData.game_name,
    box_art_url: gameData.box_art_url,
    category_source: categorySource,
    language: vod.language || "",
    type: vod.type || "",
    fetched_at: new Date().toISOString()
  };
}

async function getLiveStatusData(token, login) {
  const user = await getUserByLogin(token, login);

  const streams = await twitchGet("streams", token, { user_login: login });
  const stream = streams && streams.data ? streams.data[0] || null : null;

  if (!stream) {
    return {
      ok: true,
      service: "VOD_BACKEND_TWITCH",
      broadcaster_login: login,
      user_id: user.id,
      is_live: false,
      viewer_count: 0,
      title: "",
      started_at: "",
      game_id: "",
      game_name: "",
      box_art_url: "",
      thumbnail_url: "",
      fetched_at: new Date().toISOString()
    };
  }

  const gameData = await getGameInfo(token, stream.game_id);

  return {
    ok: true,
    service: "VOD_BACKEND_TWITCH",
    broadcaster_login: login,
    user_id: user.id,
    is_live: true,
    viewer_count: stream.viewer_count || 0,
    title: stream.title || "",
    started_at: stream.started_at || "",
    game_id: gameData.game_id,
    game_name: gameData.game_name || stream.game_name || "",
    box_art_url: gameData.box_art_url,
    thumbnail_url: stream.thumbnail_url
      ? stream.thumbnail_url.replace("{width}", "640").replace("{height}", "360")
      : "",
    fetched_at: new Date().toISOString()
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "VOD_BACKEND_TWITCH",
    endpoints: ["/health", "/last-vod", "/live-status"]
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "VOD_BACKEND_TWITCH",
    uptime_seconds: Math.round(process.uptime()),
    fetched_at: new Date().toISOString()
  });
});

app.get("/last-vod", async (_req, res) => {
  try {
    assertEnv();
    const token = await getAppAccessToken();
    const data = await getLatestVodData(token, TWITCH_LOGIN);
    res.json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      ok: false,
      service: "VOD_BACKEND_TWITCH",
      error: error.message || "Unknown error"
    });
  }
});

app.get("/live-status", async (_req, res) => {
  try {
    assertEnv();
    const token = await getAppAccessToken();
    const data = await getLiveStatusData(token, TWITCH_LOGIN);
    res.json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      ok: false,
      service: "VOD_BACKEND_TWITCH",
      error: error.message || "Unknown error"
    });
  }
});

app.listen(PORT, () => {
  console.log("VOD_BACKEND_TWITCH listening on port " + PORT);
});
