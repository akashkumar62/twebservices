// server.js
const express = require('express');
const cors = require('cors');
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

const allowedOrigins = [
  'http://localhost:3000',
  'https://twittervideodownloader-gilt.vercel.app'
];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));


app.use(express.json());

// Rate limiting (apply after CORS!)
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
      extraHeaders = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
    } catch (e) {
      console.warn('Invalid headers param', e);
    }
  }

  try {
    const parsed = new URL(remoteUrl);

    const forward = {};
    if (req.headers.range) forward['range'] = req.headers.range;
    Object.assign(forward, extraHeaders);

    const upstream = await fetch(remoteUrl, {
      headers: forward,
    });

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
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 CORS enabled for: ${allowedOrigins.join(', ')}`);
});

module.exports = app;