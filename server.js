// server.js
const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const rateLimit = require('express-rate-limit');
const { pipeline } = require('stream');
const fetch = global.fetch; // Node 20+
const { URL } = require('url');

const execPromise = promisify(exec);
const streamPipeline = promisify(pipeline);

const app = express();
const PORT = process.env.PORT || 3001;

// ------------------- CORS configuration -------------------
const DEFAULT_ALLOWED = [
  'http://localhost:3000',
  'https://twittervideodownloader-gilt.vercel.app'
];

// Allow adding more origins via env (comma-separated)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Utility to check origin; allow requests with no origin (curl / server-to-server)
function isOriginAllowed(origin) {
  if (!origin) return true; // allow non-browser requests (curl, server-to-server)
  if (allowedOrigins.includes(origin)) return true;
  // optional: allow vercel preview subdomains (uncomment if you want)
  // if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;
  return false;
}

// CORS middleware (manual so we can echo exact origin and set Vary header)
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (isOriginAllowed(origin)) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin); // echo exact origin (required if credentials true)
      res.setHeader('Vary', 'Origin'); // ensure caches respect origin-specific responses
    } else {
      // non-browser clients (curl, server-to-server)
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    // If you don't use cookies/sessions, you can remove this header.
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // Allowed methods & headers
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    // Expose streaming & range headers so browsers can use <video> range requests properly
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  } else {
    // No CORS headers set -> browser will block cross-origin request
    console.warn('Blocked CORS origin:', origin);
  }

  if (req.method === 'OPTIONS') {
    // Preflight short-circuit
    return res.sendStatus(204);
  }
  next();
});
// ------------------- end CORS configuration -------------------

app.use(express.json());

// Rate limiting (apply after CORS)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: 'Too many requests, please try again later.'
});
app.use('/api/', limiter);

// Validate Twitter/X URL
function isValidTwitterUrl(url) {
  const patterns = [
    /^https?:\/\/(www\.)?(twitter|x)\.com\/[^/]+\/status\/\d+/,
    /^https?:\/\/(www\.)?twitter\.com\/i\/web\/status\/\d+/
  ];
  return patterns.some(pattern => pattern.test(url));
}

// Helper to pick best formats
function normalizeFormats(formats) {
  if (!Array.isArray(formats)) return [];
  return formats.map(f => ({
    format_id: f.format_id || f.format,
    quality: f.format_note || (f.height ? `${f.height}p` : f.format_id || ''),
    height: f.height || null,
    ext: f.ext || '',
    filesize: f.filesize || f.filesize_approx || null,
    url: f.url,
    protocol: f.protocol,
    http_headers: f.http_headers || {},
    acodec: f.acodec || null,
    vcodec: f.vcodec || null
  }));
}

// Extract video info endpoint
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  
  if (!url || !isValidTwitterUrl(url)) {
    return res.status(400).json({ 
      error: 'Invalid Twitter/X URL. Provide a valid tweet URL.' 
    });
  }

  try {
    const command = `yt-dlp -J "${url}"`;
    const { stdout, stderr } = await execPromise(command, {
      maxBuffer: 1024 * 1024 * 30,
      timeout: 120000
    });

    if (!stdout) {
      console.error('yt-dlp produced no stdout, stderr:', stderr);
      return res.status(500).json({ 
        error: 'yt-dlp returned empty output', 
        details: stderr 
      });
    }

    const videoInfo = JSON.parse(stdout);
    const formatsRaw = videoInfo.formats || [];
    const formats = normalizeFormats(formatsRaw);

    // Separate video-only and audio-only; also find combined (mp4) formats
    const videoCombined = formats.filter(f => 
      f.vcodec !== 'none' && f.acodec !== 'none'
    );
    const videoOnly = formats.filter(f => 
      f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none')
    );
    const audioOnly = formats.filter(f => 
      f.acodec !== 'none' && (f.vcodec === 'none' || !f.vcodec)
    );

    // Sort by height (desc) when possible
    const sortByHeightDesc = arr => arr.slice().sort((a, b) => 
      (b.height || 0) - (a.height || 0)
    );

    const combinedSorted = sortByHeightDesc(videoCombined);
    const videoSorted = sortByHeightDesc(videoOnly);

    // Choose a direct playable URL
    const directPlayable = (
      combinedSorted[0] || 
      videoSorted[0] || 
      formats[0]
    ) || null;

    const response = {
      id: videoInfo.id || videoInfo.display_id || null,
      title: videoInfo.title || 'Twitter/X Video',
      thumbnail: videoInfo.thumbnail || null,
      duration: videoInfo.duration || null,
      uploader: videoInfo.uploader || videoInfo.channel || null,
      formats: [
        ...combinedSorted.slice(0, 8),
        ...videoSorted.slice(0, 8),
        ...audioOnly.slice(0, 4)
      ],
      hasAudioSeparate: audioOnly.length > 0,
      directPlayable: directPlayable ? {
        url: directPlayable.url,
        protocol: directPlayable.protocol,
        http_headers: directPlayable.http_headers || {}
      } : null,
      raw: {
        extractor: videoInfo.extractor,
        webpage_url: videoInfo.webpage_url || videoInfo.original_url || null
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Extraction error:', error);
    if (error.killed) {
      return res.status(408).json({ 
        error: 'Request timeout. Please try again.' 
      });
    }
    res.status(500).json({
      error: 'Failed to extract video. The tweet may be private, deleted, or require authentication.',
      details: (error && error.message) || error
    });
  }
});

// Get direct download URL endpoint
app.post('/api/download', async (req, res) => {
  const { url, quality } = req.body;
  
  if (!url || !isValidTwitterUrl(url)) {
    return res.status(400).json({ error: 'Invalid Twitter/X URL' });
  }

  try {
    const { stdout } = await execPromise(`yt-dlp -J "${url}"`, {
      maxBuffer: 1024 * 1024 * 30,
      timeout: 120000
    });
    
    const info = JSON.parse(stdout);
    const formats = normalizeFormats(info.formats || []);

    let chosen;
    if (quality && quality !== 'best') {
      const maxH = Number(quality);
      // Try to find a combined format with height <= maxH first
      chosen = formats
        .filter(f => 
          f.height && 
          f.height <= maxH && 
          f.vcodec !== 'none' && 
          f.acodec !== 'none'
        )
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      
      if (!chosen) {
        // fallback to video-only with height <= maxH
        chosen = formats
          .filter(f => 
            f.height && 
            f.height <= maxH && 
            f.vcodec !== 'none'
          )
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      }
    } else {
      // pick best combined or best video-only
      chosen = formats
        .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0] || 
        formats
          .filter(f => f.vcodec !== 'none')
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    }

    if (!chosen || !chosen.url) {
      return res.status(500).json({ 
        error: 'Could not find a download URL for that quality' 
      });
    }

    res.json({
      downloadUrl: chosen.url,
      protocol: chosen.protocol,
      http_headers: chosen.http_headers || {}
    });
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      error: 'Failed to get download URL', 
      details: (error && error.message) || error 
    });
  }
});

// Stream proxy endpoint
app.get('/api/stream', async (req, res) => {
  const { remoteUrl, h } = req.query;
  
  if (!remoteUrl) {
    return res.status(400).json({ error: 'remoteUrl required' });
  }

  // Parse optional base64-encoded headers JSON
  let extraHeaders = {};
  if (h) {
    try {
      extraHeaders = JSON.parse(Buffer.from(decodeURIComponent(h), 'base64').toString('utf8'));
    } catch (e) {
      console.warn('Invalid headers param', e);
    }
  }

  try {
    // Will throw if invalid URL
    const parsed = new URL(remoteUrl);

    const forward = {};
    if (req.headers.range) forward['range'] = req.headers.range;
    Object.assign(forward, extraHeaders);

    const upstream = await fetch(remoteUrl, {
      headers: forward,
      // follow redirects (default)
    });

    // Forward upstream status and selected headers
    res.status(upstream.status);

    upstream.headers.forEach((value, name) => {
      const hopByHop = [
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailers',
        'transfer-encoding',
        'upgrade'
      ];
      if (!hopByHop.includes(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    });

    // Pipe stream to client (supports range requests)
    await streamPipeline(upstream.body, res);
  } catch (err) {
    console.error('Stream proxy error', err);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'stream failed', 
        details: err.message 
      });
    }
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'running' });
});

// Check dependencies
app.get('/api/check-dependencies', async (req, res) => {
  try {
    const { stdout: ytdlp } = await execPromise('which yt-dlp || true');
    const { stdout: version } = await execPromise('yt-dlp --version || true');
    res.json({ 
      yt_dlp_path: ytdlp.trim(), 
      yt_dlp_version: version.trim() 
    });
  } catch (e) {
    res.status(500).json({ 
      error: 'dependency check failed', 
      details: e.message 
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
