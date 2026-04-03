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
      url.searchParams.set(key, String(value));
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

async function getLatestVod() {
  assertEnv();

  const token = await getAppAccessToken();

  const users = await twitchGet("users", token, { login: TWITCH_LOGIN });
  const user = users?.data?.[0];
  if (!user) {
    const err = new Error(`Twitch user not found for login: ${TWITCH_LOGIN}`);
    err.statusCode = 404;
    throw err;
  }

  const videos = await twitchGet("videos", token, {
    user_id: user.id,
    type: "archive",
    first: 1
  });

  const vod = videos?.data?.[0];
  if (!vod) {
    const err = new Error(`No archive VOD found for login: ${TWITCH_LOGIN}`);
    err.statusCode = 404;
    throw err;
  }

  return {
    ok: true,
    broadcaster_login: TWITCH_LOGIN,
    broadcaster_name: vod.user_name || user.display_name || TWITCH_LOGIN,
    user_id: user.id,
    vod_id: vod.id,
    title: vod.title,
    url: vod.url,
    created_at: vod.created_at,
    published_at: vod.published_at,
    duration: vod.duration,
    view_count: vod.view_count,
    thumbnail_url: normalizeThumbnailUrl(vod.thumbnail_url, 320, 180),
    thumbnail_url_large: normalizeThumbnailUrl(vod.thumbnail_url, 640, 360),
    image_proxy_url: `/last-vod-image?size=large`,
    language: vod.language || "",
    type: vod.type || "",
    fetched_at: new Date().toISOString()
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "vod-backend",
    endpoints: ["/health", "/last-vod", "/last-vod-image?size=small|large"]
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptime_seconds: Math.round(process.uptime()),
    fetched_at: new Date().toISOString()
  });
});

app.get("/last-vod", async (_req, res) => {
  try {
    const data = await getLatestVod();
    res.json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || "Unknown error"
    });
  }
});

app.get("/last-vod-image", async (req, res) => {
  try {
    const size = String(req.query.size || "large").toLowerCase();
    const data = await getLatestVod();
    const imageUrl = size === "small" ? data.thumbnail_url : data.thumbnail_url_large;

    const upstream = await fetch(imageUrl);
    if (!upstream.ok) {
      const text = await upstream.text();
      throw new Error("Thumbnail fetch error: " + text);
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(buffer);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || "Unknown error"
    });
  }
});

app.listen(PORT, () => {
  console.log(`vod-backend listening on port ${PORT}`);
});
