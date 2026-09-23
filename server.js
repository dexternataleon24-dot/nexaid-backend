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
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
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

    let transcriptList;
    try {
      transcriptList = await YoutubeTranscript.fetchTranscript(videoId);
    } catch (err) {
      console.warn(`[YouTube Transcript] fetchTranscript failed for ${videoId}:`, err.message);
      return res.status(404).json({
        success: false,
        error: 'TRANSCRIPT_UNAVAILABLE',
        message: 'Transcript unavailable for this YouTube video. Please upload the video\'s audio or video file instead.'
      });
    }

    if (!transcriptList || transcriptList.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'TRANSCRIPT_UNAVAILABLE',
        message: 'No usable transcript was found. Please upload the video\'s audio or video file instead.'
      });
    }

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
      title: metadata.title,
      author: metadata.author,
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
app.listen(PORT, () => {
  console.log(`============================================================`);
  console.log(` NexaCompress API Server running on port ${PORT}`);
  console.log(` Configured Ghostscript command: "${gsCmd}"`);
  console.log(`============================================================`);
});
