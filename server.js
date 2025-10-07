const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const rateLimit = require('express-rate-limit');

const execPromise = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  message: 'Too many requests, please try again later.'
});

app.use('/api/', limiter);

// Validate Twitter URL
function isValidTwitterUrl(url) {
  const patterns = [
    /^https?:\/\/(www\.)?(twitter|x)\.com\/\w+\/status\/\d+/,
    /^https?:\/\/(www\.)?twitter\.com\/i\/web\/status\/\d+/,
  ];
  return patterns.some(pattern => pattern.test(url));
}

// Extract video info endpoint
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;

  // Validate URL
  if (!url || !isValidTwitterUrl(url)) {
    return res.status(400).json({ 
      error: 'Invalid Twitter URL. Please provide a valid tweet URL.' 
    });
  }

  try {
    // Get video information using yt-dlp
    const command = `yt-dlp -J "${url}"`;
    const { stdout } = await execPromise(command, { 
      maxBuffer: 1024 * 1024 * 10,
      timeout: 30000 
    });

    const videoInfo = JSON.parse(stdout);

    // Extract relevant information
    const formats = videoInfo.formats || [];
    
    // Filter video formats
    const videoFormats = formats
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
      .map(f => ({
        quality: f.format_note || f.height + 'p',
        height: f.height,
        ext: f.ext,
        filesize: f.filesize,
        url: f.url
      }))
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    // Get best audio format for MP3 option
    const audioFormat = formats.find(f => f.acodec !== 'none' && f.vcodec === 'none');

    const response = {
      title: videoInfo.title || 'Twitter Video',
      thumbnail: videoInfo.thumbnail,
      duration: videoInfo.duration,
      uploader: videoInfo.uploader || videoInfo.channel,
      formats: videoFormats.slice(0, 5), // Return top 5 qualities
      hasAudio: !!audioFormat,
      directUrl: videoInfo.url // Direct video URL
    };

    res.json(response);

  } catch (error) {
    console.error('Extraction error:', error);
    
    if (error.killed) {
      return res.status(408).json({ error: 'Request timeout. Please try again.' });
    }
    
    res.status(500).json({ 
      error: 'Failed to extract video. The tweet might be private, deleted, or contain no video.',
      details: error.message 
    });
  }
});

// Get direct download URL endpoint
app.post('/api/download', async (req, res) => {
  const { url, quality } = req.body;

  if (!url || !isValidTwitterUrl(url)) {
    return res.status(400).json({ error: 'Invalid Twitter URL' });
  }

  try {
    // Get direct download URL for specific quality
    let command = `yt-dlp -g "${url}"`;
    
    if (quality && quality !== 'best') {
      command = `yt-dlp -f "bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]" -g "${url}"`;
    }

    const { stdout } = await execPromise(command, {
      maxBuffer: 1024 * 1024 * 10,
      timeout: 30000
    });

    const downloadUrl = stdout.trim().split('\n')[0]; // Get first URL

    res.json({ 
      downloadUrl,
      message: 'Use this URL to download the video directly'
    });

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      error: 'Failed to get download URL',
      details: error.message 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Check if yt-dlp is installed
app.get('/api/check-dependencies', async (req, res) => {
  try {
    await execPromise('yt-dlp --version');
    res.json({ ytdlp: 'installed' });
  } catch (error) {
    res.json({ ytdlp: 'not installed', error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📹 Twitter Video Downloader API ready`);
});

module.exports = app;