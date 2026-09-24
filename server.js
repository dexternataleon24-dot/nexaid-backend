const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { YoutubeTranscript } = require('youtube-transcript');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
const allowedOrigins = [
  'http://localhost:5501',
  'http://127.0.0.1:5501',
  'http://localhost:5001',
  'http://127.0.0.1:5001',
  'https://nexaid-ea5fd.web.app',
  'https://nexaid-ea5fd.firebaseapp.com'
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json());

// Setup file uploads
const uploadDir = (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, 'uploads');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (err) {
  console.warn('[Server] Could not initialize uploadDir:', err.message);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, 'input_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB max
});

// Auto-detect Ghostscript command
let gsCmd = process.env.GS_COMMAND;
if (!gsCmd) {
  if (process.platform === 'win32') {
    gsCmd = 'gswin64c'; // Default 64-bit Ghostscript on Windows
  } else {
    gsCmd = 'gs'; // Default on Mac/Linux
  }
}

// Function to test if Ghostscript is installed
function checkGhostscript() {
  return new Promise((resolve) => {
    // Run command to print version
    exec(`"${gsCmd}" --version`, (error, stdout, stderr) => {
      if (error) {
        // Fallback for Windows if gswin32c is installed
        if (process.platform === 'win32' && gsCmd === 'gswin64c') {
          exec('gswin32c --version', (err2, out2) => {
            if (err2) {
              resolve({ available: false, error: 'Ghostscript not found. Please install Ghostscript and add it to PATH.' });
            } else {
              gsCmd = 'gswin32c';
              resolve({ available: true, version: out2.trim() });
            }
          });
        } else {
          resolve({ available: false, error: `Ghostscript command "${gsCmd}" not found. Ensure it is installed and added to PATH.` });
        }
      } else {
        resolve({ available: true, version: stdout.trim() });
      }
    });
  });
}

// Routes

// 1. Health check
app.get(['/health', '/api/health'], async (req, res) => {
  const gsCheck = await checkGhostscript();
  res.json({
    status: 'ok',
    server: 'NexaID Server',
    port: PORT,
    platform: process.platform,
    ghostscript: gsCheck
  });
});

// 2. Compress endpoint (Iterative Loop)
app.post('/compress', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const inputPath = req.file.path;
  const targetSize = parseInt(req.body.targetSize) || 3 * 1024 * 1024; // Default 3 MB
  const preset = req.body.preset || 'balanced';
  const removeMetadata = req.body.removeMetadata === 'true' || req.body.removeMetadata === true;
  const convertGrayscale = req.body.grayscale === 'true' || req.body.grayscale === true;

  const originalSize = req.file.size;
  const gsCheck = await checkGhostscript();

  if (!gsCheck.available) {
    // Cleanup input file
    safeDelete(inputPath);
    return res.status(500).json({
      error: 'Ghostscript is not installed on the server.',
      message: gsCheck.error,
      suggestLocal: true
    });
  }

  console.log(`[NexaCompress] Processing "${req.file.originalname}" (${originalSize} bytes). Target: ${targetSize} bytes.`);

  if (originalSize <= targetSize) {
    // Already smaller, bypass compression
    console.log(`[NexaCompress] File is already smaller than target size. Bypassing.`);
    const outputFilename = `${path.basename(req.file.originalname, '.pdf')}_compressed.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('X-Original-Size', originalSize);
    res.setHeader('X-Compressed-Size', originalSize);
    res.setHeader('X-Reduction-Pct', 0);
    res.setHeader('X-Target-Status', 'Target Reached (Unchanged)');
    res.setHeader('X-Compression-Log', JSON.stringify([{ pass: 0, size: originalSize, action: 'Bypassed (Already smaller than target)' }]));
    
    const fileStream = fs.createReadStream(inputPath);
    fileStream.pipe(res);
    fileStream.on('end', () => {
      safeDelete(inputPath);
    });
    return;
  }

  const isSmallestPossible = !targetSize || targetSize === 0;

  // Iterative Optimization settings
  // Pass configuration: DPI resolution and distiller QFactor (quantization factor - larger = lower quality, smaller file)
  const passes = [
    { pass: 1, dpi: 150, qFactor: 0.40, grayscale: false, label: 'High Quality Pass' },
    { pass: 2, dpi: 120, qFactor: 0.70, grayscale: false, label: 'Balanced Pass' },
    { pass: 3, dpi: 96,  qFactor: 1.20, grayscale: convertGrayscale, label: 'Strong Pass' },
    { pass: 4, dpi: 72,  qFactor: 1.80, grayscale: convertGrayscale || preset === 'maximum', label: 'Maximum Compression Pass' }
  ];

  // Adjust starting pass based on selected presets
  let startingIndex = 0;
  if (preset === 'high') startingIndex = 0;
  else if (preset === 'balanced') startingIndex = 1;
  else if (preset === 'strong') startingIndex = 2;
  else if (preset === 'maximum') startingIndex = 0; // Run all passes to find smallest result

  const activePasses = passes.slice(startingIndex);
  
  let currentInputPath = inputPath;
  let finalOutputPath = null;
  let finalSize = originalSize;
  let compressionLog = [];
  let targetReached = false;

  try {
    for (let i = 0; i < activePasses.length; i++) {
      const p = activePasses[i];
      const tempOutName = `compressed_p${p.pass}_${Date.now()}.pdf`;
      const tempOutPath = path.join(uploadDir, tempOutName);

      // Construct GS flags
      // Convert to grayscale if requested or on the maximum pass
      const colorSpace = (convertGrayscale || p.grayscale) ? 'DeviceGray' : 'DeviceRGB';
      
      const gsArgs = [
        `"${gsCmd}"`,
        `-sDEVICE=pdfwrite`,
        `-dCompatibilityLevel=1.4`,
        `-dNOPAUSE`,
        `-dQUIET`,
        `-dBATCH`,
        `-dDetectDuplicateImages=true`,
        `-dDownsampleColorImages=true`,
        `-dColorImageResolution=${p.dpi}`,
        `-dDownsampleGrayImages=true`,
        `-dGrayImageResolution=${p.dpi}`,
        `-dDownsampleMonoImages=true`,
        `-dMonoImageResolution=${p.dpi}`,
        `-dColorConversionStrategy=${colorSpace}`,
      ];

      // Remove metadata if checked
      if (removeMetadata) {
        gsArgs.push(`-dKeepInfo=false`);
      }

      // Add image distiller options (QFactor)
      gsArgs.push(`-c "<< /ColorImageDict << /QFactor ${p.qFactor} /Blend /Compatible >> /GrayImageDict << /QFactor ${p.qFactor} >> >> setdistillerparams"`);
      
      // Output and input files
      gsArgs.push(`-f "${currentInputPath}"`);
      gsArgs.push(`-sOutputFile="${tempOutPath}"`);

      const cmd = gsArgs.join(' ');
      
      console.log(`[NexaCompress] Pass ${p.pass} - DPI: ${p.dpi}, QFactor: ${p.qFactor}, Grayscale: ${colorSpace === 'DeviceGray'}`);
      
      await runCommandPromise(cmd);

      // Check resulting size
      if (fs.existsSync(tempOutPath)) {
        const size = fs.statSync(tempOutPath).size;
        console.log(`[NexaCompress] Pass ${p.pass} complete. File size: ${size} bytes.`);
        compressionLog.push({
          pass: p.pass,
          dpi: p.dpi,
          qFactor: p.qFactor,
          grayscale: colorSpace === 'DeviceGray',
          size: size,
          action: p.label
        });

        // Clean up previous temp files (except original input)
        if (currentInputPath !== inputPath && currentInputPath !== tempOutPath) {
          safeDelete(currentInputPath);
        }

        currentInputPath = tempOutPath;
        finalOutputPath = tempOutPath;
        finalSize = size;

        // If target size reached, break early!
        if (!isSmallestPossible && size <= targetSize) {
          targetReached = true;
          console.log(`[NexaCompress] Target reached at Pass ${p.pass}!`);
          break;
        }
      } else {
        throw new Error(`Ghostscript failed to generate output for Pass ${p.pass}`);
      }
    }

    if (finalOutputPath && fs.existsSync(finalOutputPath)) {
      const reduction = ((originalSize - finalSize) / originalSize) * 100;
      let targetStatus = 'Target Reached';
      if (isSmallestPossible) {
        targetStatus = 'Smallest Valid Result Found';
      } else if (finalSize > targetSize) {
        if (finalSize <= targetSize * 1.15) {
          targetStatus = 'Target Almost Reached';
        } else {
          targetStatus = 'Best Possible Result Achieved';
        }
      }

      console.log(`[NexaCompress] Successful compression: Original: ${originalSize} -> Final: ${finalSize} (${reduction.toFixed(1)}% reduction). Status: ${targetStatus}`);

      // Send file
      const outputFilename = `${path.basename(req.file.originalname, '.pdf')}_compressed.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
      res.setHeader('X-Original-Size', originalSize);
      res.setHeader('X-Compressed-Size', finalSize);
      res.setHeader('X-Reduction-Pct', reduction.toFixed(1));
      res.setHeader('X-Target-Status', targetStatus);
      res.setHeader('X-Compression-Log', JSON.stringify(compressionLog));

      const fileStream = fs.createReadStream(finalOutputPath);
      fileStream.pipe(res);

      fileStream.on('end', () => {
        // Cleanup temp files
        safeDelete(inputPath);
        if (finalOutputPath && finalOutputPath !== inputPath) {
          safeDelete(finalOutputPath);
        }
      });
    } else {
      throw new Error('No compressed PDF generated');
    }

  } catch (err) {
    console.error(`[NexaCompress] Error during compression:`, err);
    // Cleanup files
    safeDelete(inputPath);
    if (finalOutputPath && finalOutputPath !== inputPath) {
      safeDelete(finalOutputPath);
    }
    res.status(500).json({ error: 'Failed to compress PDF', details: err.message });
  }
});

// Helper functions

function runCommandPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.error(`Failed to delete file: ${filePath}`, e);
  }
}

// YouTube Transcript Retrieval Pipeline

function getYoutubeMetadata(videoId) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({
            title: json.title || 'YouTube Video',
            author: json.author_name || 'Unknown Channel',
            thumbnail: json.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
          });
        } catch (e) {
          resolve({
            title: 'YouTube Video',
            author: 'Unknown Channel',
            thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
          });
        }
      });
    }).on('error', () => {
      resolve({
        title: 'YouTube Video',
        author: 'Unknown Channel',
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
      });
    });
  });
}

// Multi-strategy robust transcript retrieval
async function fetchYouTubeTranscriptRobust(videoId) {
  const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

  // Strategy 1: Supadata API (works from any IP, including datacenter/Vercel)
  // This is the PRIMARY strategy for production since YouTube blocks datacenter IPs
  const supadataKey = process.env.SUPADATA_API_KEY;
  if (supadataKey) {
    try {
      console.log(`[YouTube Transcript] Trying Supadata API for ${videoId}...`);
      const supadataUrl = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&lang=en`;
      const supadataRes = await fetch(supadataUrl, {
        headers: { 'x-api-key': supadataKey },
        signal: AbortSignal.timeout(15000)
      });

      if (supadataRes.ok) {
        const supadataData = await supadataRes.json();
        if (supadataData.content) {
          // Supadata returns either an array of {text, offset, duration, lang} or a string
          let transcriptList;
          if (Array.isArray(supadataData.content)) {
            transcriptList = supadataData.content.map(item => ({
              text: (item.text || '').replace(/\n/g, ' ').trim(),
              offset: item.offset || 0,
              duration: item.duration || 0,
              lang: item.lang || supadataData.lang || 'en'
            }));
          } else {
            // Plain text mode — create a single entry
            transcriptList = [{
              text: String(supadataData.content).replace(/\n/g, ' ').trim(),
              offset: 0,
              duration: 0,
              lang: supadataData.lang || 'en'
            }];
          }

          if (transcriptList.length > 0) {
            console.log(`[YouTube Transcript] Supadata success for ${videoId}: ${transcriptList.length} segments`);
            return { transcriptList };
          }
        }
      } else {
        const errBody = await supadataRes.text().catch(() => '');
        console.warn(`[YouTube Transcript] Supadata returned ${supadataRes.status} for ${videoId}: ${errBody.substring(0, 200)}`);
      }
    } catch (supadataErr) {
      console.warn(`[YouTube Transcript] Supadata API failed for ${videoId}:`, supadataErr.message);
    }
  }

  // Strategy 2: YouTube InnerTube Android Player API
  // Works reliably from residential IPs (local dev) but blocked on datacenter IPs (Vercel)
  try {
    console.log(`[YouTube Transcript] Trying InnerTube ANDROID for ${videoId}...`);
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)"
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38"
          }
        },
        videoId: videoId
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (res.ok) {
      const data = await res.json();
      const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      const details = data?.videoDetails || {};

      if (Array.isArray(captionTracks) && captionTracks.length > 0) {
        // Preferred language order: en, id, or first available
        const track = captionTracks.find(t => t.languageCode === "en") ||
                      captionTracks.find(t => t.languageCode?.startsWith("en")) ||
                      captionTracks.find(t => t.languageCode === "id") ||
                      captionTracks[0];

        // Fetch caption XML (default format from InnerTube, most reliable)
        try {
          const xmlRes = await fetch(track.baseUrl, {
            headers: { "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)" },
            signal: AbortSignal.timeout(8000)
          });
          if (xmlRes.ok) {
            const xml = await xmlRes.text();
            if (xml.length > 0) {
              const list = [];
              // Parse <p t="..." d="...">content</p> format
              const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
              let match;
              while ((match = pRegex.exec(xml)) !== null) {
                const raw = match[3].replace(/<[^>]+>/g, '').trim();
                if (raw) {
                  list.push({
                    text: raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
                    duration: parseInt(match[2], 10),
                    offset: parseInt(match[1], 10),
                    lang: track.languageCode
                  });
                }
              }
              // Also try <text start="..." dur="...">content</text> format
              if (list.length === 0) {
                const textRegex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
                while ((match = textRegex.exec(xml)) !== null) {
                  const raw = match[3].replace(/<[^>]+>/g, '').trim();
                  if (raw) {
                    list.push({
                      text: raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
                      duration: Math.floor(parseFloat(match[2]) * 1000),
                      offset: Math.floor(parseFloat(match[1]) * 1000),
                      lang: track.languageCode
                    });
                  }
                }
              }
              if (list.length > 0) {
                console.log(`[YouTube Transcript] InnerTube XML success for ${videoId}: ${list.length} segments`);
                return {
                  title: details.title,
                  author: details.author,
                  transcriptList: list
                };
              }
            }
          }
        } catch (xmlErr) {
          console.warn(`[YouTube Transcript] InnerTube XML retrieval failed for ${videoId}:`, xmlErr.message);
        }
      }
    }
  } catch (innerTubeErr) {
    console.warn(`[YouTube Transcript] InnerTube attempt failed for ${videoId}:`, innerTubeErr.message);
  }

  // Strategy 3: Fallback to YoutubeTranscript npm package
  try {
    console.log(`[YouTube Transcript] Trying YoutubeTranscript package for ${videoId}...`);
    const list = await YoutubeTranscript.fetchTranscript(videoId);
    if (list && list.length > 0) {
      console.log(`[YouTube Transcript] Package success for ${videoId}: ${list.length} segments`);
      return {
        transcriptList: list
      };
    }
  } catch (ytErr) {
    console.warn(`[YouTube Transcript] YoutubeTranscript package fallback failed for ${videoId}:`, ytErr.message);
  }

  return null;
}

app.post('/api/test-raw', async (req, res) => {
  const { videoId } = req.body;
  const clients = [
    { name: "ANDROID", version: "20.10.38", ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14)" },
    { name: "WEB_EMBEDDED_PLAYER", version: "1.20240313.01.00", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    { name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", version: "2.0", ua: "Mozilla/5.0 (PlayStation; PlayStation 4/11.50) AppleWebKit/605.1.15 (KHTML, like Gecko)" },
    { name: "IOS", version: "19.29.1", ua: "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)" },
    { name: "MWEB", version: "2.20240313.01.00", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" }
  ];

  const results = {};
  for (const c of clients) {
    try {
      const ytRes = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": c.ua },
        body: JSON.stringify({
          context: { client: { clientName: c.name, clientVersion: c.version } },
          videoId: videoId
        })
      });
      const data = await ytRes.json();
      results[c.name] = {
        playability: data.playabilityStatus?.status,
        reason: data.playabilityStatus?.reason,
        hasCaptions: !!data.captions,
        captionTracksCount: data?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length || 0
      };
    } catch(e) {
      results[c.name] = { error: e.message };
    }
  }
  res.json({ videoId, results });
});

app.post('/api/youtube/transcript', async (req, res) => {
  const { videoUrl, videoId: clientVideoId } = req.body;
  
  let videoId = clientVideoId;
  
  if (videoUrl) {
    const trimmed = videoUrl.trim();
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/|live\/)([^#\&\?]*).*/;
    const match = trimmed.match(regExp);
    if (match && match[2].length === 11) {
      videoId = match[2];
    } else if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      videoId = trimmed;
    }
  }

  if (!videoId) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_YOUTUBE_URL',
      message: 'Please enter a valid YouTube URL.'
    });
  }

  const videoIdRegex = /^[a-zA-Z0-9_-]{11}$/;
  if (!videoIdRegex.test(videoId)) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_VIDEO_ID',
      message: 'Invalid YouTube Video ID format.'
    });
  }

  try {
    console.log(`[YouTube Transcript] Retrieving transcript for: ${videoId}`);
    const metadata = await getYoutubeMetadata(videoId);

    const result = await fetchYouTubeTranscriptRobust(videoId);

    if (!result || !result.transcriptList || result.transcriptList.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'TRANSCRIPT_UNAVAILABLE',
        message: 'Transcript unavailable for this YouTube video. Please upload the video\'s audio or video file instead.'
      });
    }

    const transcriptList = result.transcriptList;
    const lastItem = transcriptList[transcriptList.length - 1];
    const durationMs = lastItem ? (lastItem.offset + lastItem.duration) : 0;
    const durationSec = Math.floor(durationMs / 1000);

    const rawTranscriptText = transcriptList.map(t => t.text).join(' ');
    const cleanTranscript = rawTranscriptText
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanTranscript.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'EMPTY_TRANSCRIPT',
        message: 'No usable transcript was found.'
      });
    }

    res.json({
      success: true,
      videoId: videoId,
      title: result.title || metadata.title,
      author: result.author || metadata.author,
      thumbnail: metadata.thumbnail,
      duration: durationSec,
      transcript: cleanTranscript,
      transcriptList: transcriptList
    });

  } catch (error) {
    console.error(`[YouTube Transcript] Failed to process ${videoId}:`, error);
    res.status(500).json({
      success: false,
      error: 'BACKEND_ERROR',
      message: 'An error occurred on the server while retrieving the YouTube transcript.'
    });
  }
});

// Start Server
if (!process.env.VERCEL && require.main === module) {
  app.listen(PORT, () => {
    console.log(`============================================================`);
    console.log(` NexaCompress API Server running on port ${PORT}`);
    console.log(` Configured Ghostscript command: "${gsCmd}"`);
    console.log(`============================================================`);
  });
}

module.exports = app;
