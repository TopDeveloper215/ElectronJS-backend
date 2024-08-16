require('dotenv').config();
const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const authController = require('./controllers/authController');
const auth = require('./middleware/auth');
const { exec } = require('child_process');
const { debug } = require('console');
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);

const app = express();

const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = ['http://localhost:5173', 'https://your-production-frontend.com'];
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI ||"mongodb://127.0.0.1:27017/videoeditor")
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
      cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname))
    }
  })
  
const upload = multer({ storage: storage });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());

// Video processing functions
const cutVideo = (inputPath, startTime, endTime, outputPath) => {
  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath).setStartTime(startTime);

    if (endTime !== null) {
      command = command.setDuration(endTime - startTime);
    }

    command
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log('FFmpeg started with command:', commandLine);
      })
      .on('progress', (progress) => {
        console.log(`Processing: ${progress.percent}% done`);
      })
      .on('end', () => {
        console.log('FFmpeg processing finished');
        resolve(outputPath);
      })
      .on('error', (err, stdout, stderr) => {
        console.error('FFmpeg error:', err.message);
        console.error('FFmpeg stdout:', stdout);
        console.error('FFmpeg stderr:', stderr);
        reject(err);
      })
      .run();
  });
};

async function getVideoDuration(filePath) {
  const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  
  try {
    const { stdout } = await execAsync(command);
    return parseFloat(stdout.trim());
  } catch (error) {
    console.error('Error getting video duration:', error);
    throw error;
  }
}

const removeAudioFromVideo = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noAudio()
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
};

const adjustVideoSpeed = (inputPath, outputPath, speed) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters(`setpts=${1/speed}*PTS`)
      .audioFilters(`atempo=${speed}`)
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log('Spawned FFmpeg with command: ' + commandLine);
      })
      .on('error', (err, stdout, stderr) => {
        console.error('FFmpeg error:', err);
        console.error('FFmpeg stdout:', stdout);
        console.error('FFmpeg stderr:', stderr);
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .on('end', () => {
        console.log('Speed adjustment finished');
        resolve(outputPath);
      })
      .run();
  });
};

function mergeVideos(inputPaths, outputPath) {
  return new Promise((resolve, reject) => {
    // Create a temporary file to store the list of input files
    const tempListPath = path.join(__dirname, 'temp_list.txt');
    
    // Write the list of input files to the temporary file
    const fileList = inputPaths.map(file => `file '${file}'`).join('\n');
    fs.writeFileSync(tempListPath, fileList);

    // Construct the FFmpeg command
    const command = `ffmpeg -f concat -safe 0 -i "${tempListPath}" -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`;

    exec(command, (error, stdout, stderr) => {
      // Delete the temporary file
      fs.unlinkSync(tempListPath);

      if (error) {
        console.error(`FFmpeg error: ${error}`);
        console.error(`FFmpeg stderr: ${stderr}`);
        reject(error);
      } else {
        console.log('Videos merged successfully');
        resolve();
      }
    });
  });
}

const unmuteVideo = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    // First, let's check if the video has an audio stream
    const checkAudioCommand = `ffprobe -v error -select_streams a:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 ${inputPath}`;
    
    exec(checkAudioCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error checking audio: ${error.message}`);
        return reject(error);
      }

      const hasAudio = parseInt(stdout.trim()) > 0;

      let command;
      if (hasAudio) {
        // If the video already has audio, we just need to copy it
        command = `ffmpeg -i ${inputPath} -c copy ${outputPath}`;
      } else {
        // If the video doesn't have audio, we'll add a silent audio track
        command = `ffmpeg -i ${inputPath} -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v copy -c:a aac -shortest ${outputPath}`;
      }

      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error: ${error.message}`);
          return reject(error);
        }
        if (stderr) {
          console.error(`stderr: ${stderr}`);
        }
        console.log(`stdout: ${stdout}`);
        resolve();
      });
    });
  });
};

const addTextOverlay = (inputPath,  text,  fontSize = 24, fontColor = 'white', position = 'center',fontFile,outputPath) => {
  return new Promise((resolve, reject) => {
    let filterComplex;
    
    switch(position) {
      case 'top':
        filterComplex = `drawtext=fontfile=${fontFile}:fontsize=${fontSize}:fontcolor=${fontColor}:box=1:boxcolor=black@0.5:boxborderw=5:x=(w-text_w)/2:y=10:text='${text}'`;
        break;
      case 'bottom':
        filterComplex = `drawtext=fontfile=${fontFile}:fontsize=${fontSize}:fontcolor=${fontColor}:box=1:boxcolor=black@0.5:boxborderw=5:x=(w-text_w)/2:y=h-th-10:text='${text}'`;
        break;
      case 'center':
      default:
        filterComplex = `drawtext=fontfile=${fontFile}:fontsize=${fontSize}:fontcolor=${fontColor}:box=1:boxcolor=black@0.5:boxborderw=5:x=(w-text_w)/2:y=(h-text_h)/2:text='${text}'`;
    }

    ffmpeg(inputPath)
      .videoFilters(filterComplex)
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log('Spawned FFmpeg with command: ' + commandLine);
      })
      .on('error', (err, stdout, stderr) => {
        console.error('FFmpeg error:', err);
        console.error('FFmpeg stdout:', stdout);
        console.error('FFmpeg stderr:', stderr);
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .on('end', () => {
        console.log('Text overlay finished');
        resolve(outputPath);
      })
      .run();
  });
};

// Auth routes
app.post('/api/signup', authController.signup);
app.post('/api/login', authController.login);

// Protected route example
app.get('/api/protected', auth, (req, res) => {
  res.json({ msg: 'This is a protected route' });
});

app.get('/',()=>{
  res.json({msg:'server is running well!'})
})

// API Endpoints
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded' });
  }
  res.json({ filename: req.file.filename });
});

app.post('/api/upload-multiple', upload.array('videos', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No video files uploaded' });
  }
  const filePaths = req.files.map(file => file.path);
  res.json({ filePaths });
});

app.use('/api/videos', express.static(path.join(__dirname, 'output')));

app.post('/api/process', async (req, res) => {
  const { prompt, filePaths } = req.body;
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant that extracts video editing instructions from user prompts. Handle various time formats and convert them to seconds:
          - '18s' should be converted to 18 seconds
          - '18:40' should be converted to 1120 seconds
          - '18 minutes' should be converted to 1080 seconds
          - '18 minutes 32 seconds' should be converted to 1112 seconds
    
          Respond in JSON format with an object containing the following properties as needed:
          - 'action': The type of edit (cut, split, merge, text_overlay, adjust_speed)
          - 'start': For cut action, the start time in seconds
          - 'end': For cut action, the end time in seconds
          - 'points': For split action, an array of split points in seconds
          - 'speed': For adjust_speed action, the speed multiplier (e.g., 1.5 for speedup, 0.2 for slowdown)
          - 'text': For text_overlay action, the text to display
          - 'fontSize': For text_overlay action, the font size
          - 'fontColor': For text_overlay action, the font color
          - 'position': For text_overlay action, the position of the text
          - 'fontFile': For text_overlay action, the font file to use
    
          For 'start', 'end', and 'points', always use seconds in the output JSON.`
        },
        {
          role: "user",
          content: `Analyze this prompt and provide the appropriate video editing instructions: "${prompt}"`
        }
      ],
      temperature: 0.7,
    });
    
    const parsedResponse = JSON.parse(completion.choices[0].message.content);
    const { action } = parsedResponse;

    let outputFileName;
    let outputPath;
    let nlpResponse = '';
    let outputPaths = [];
    switch(action) {
      case 'cut':
        if (filePaths.length !== 1) throw new Error('Cut action requires exactly one input video');
        outputFileName = `cut_${Date.now()}.mp4`;
        outputPath = path.join(__dirname, 'output', outputFileName);
        await cutVideo(filePaths[0], parsedResponse.start, parsedResponse.end, outputPath);
        outputPaths.push(outputFileName);
        nlpResponse = `Video cut from ${parsedResponse.start} seconds to ${parsedResponse.end} seconds.`;
        break;

        case 'split':
          if (filePaths.length !== 1) throw new Error('Split action requires exactly one input video');
          
          // Get the total duration of the video
          const videoDuration = await getVideoDuration(filePaths[0]);
          
          // Add 0 at the beginning and video duration at the end of the points array
          const splitPoints = [0, ...parsedResponse.points, videoDuration];
          
          for (let i = 0; i < splitPoints.length - 1; i++) {
            outputFileName = `split_${i + 1}_${Date.now()}.mp4`;
            outputPath = path.join(__dirname, 'output', outputFileName);
            await cutVideo(filePaths[0], splitPoints[i], splitPoints[i + 1], outputPath);
            outputPaths.push(outputFileName);
            nlpResponse += `Video part ${i + 1} cut from ${splitPoints[i]} to ${splitPoints[i + 1]} seconds.\n`;
          }
          nlpResponse += 'All video parts split successfully!';
          break;

      case 'merge':
        if (filePaths.length < 2) throw new Error('At least two input paths are required for merging');
        outputFileName = `merged_${Date.now()}.mp4`;
        outputPath = path.join(__dirname, 'output', outputFileName);
        await mergeVideos(filePaths, outputPath);
        outputPaths.push(outputFileName);
        nlpResponse = `${filePaths.length} videos have been merged successfully.`;
        break;

      case 'text_overlay':
        if (filePaths.length !== 1) throw new Error('Text overlay requires exactly one input video');
        outputFileName = `text_overlay_${Date.now()}.mp4`;
        outputPath = path.join(__dirname, 'output', outputFileName);
        const fontFilePath = './font/GreatVibes-Regular.otf';
        // await addTextOverlay(filePaths[0], parsedResponse.text, parsedResponse.fontSize, parsedResponse.fontColor, parsedResponse.position, parsedResponse.fontFile, outputPath);
        await addTextOverlay(filePaths[0], parsedResponse.text, parsedResponse.fontSize, parsedResponse.fontColor, parsedResponse.position, fontFilePath, outputPath);
        outputPaths.push(outputFileName);
        nlpResponse = 'Text overlay has been added to the video.';
        break;

      case 'adjust_speed':
        if (filePaths.length !== 1) throw new Error('Speed adjustment requires exactly one input video');
        if (isNaN(parsedResponse.speed) || parsedResponse.speed <= 0) {
          throw new Error('Invalid speed value');
        }
        outputFileName = `speed_adjusted_${Date.now()}.mp4`;
        outputPath = path.join(__dirname, 'output', outputFileName);
        await adjustVideoSpeed(filePaths[0], outputPath, parsedResponse.speed);
        outputPaths.push(outputFileName);
        nlpResponse = `Video speed adjusted to ${parsedResponse.speed}x.`;
        break;

      case 'mute':
        if (filePaths.length !== 1) throw new Error('Mute action requires exactly one input video');
        outputFileName = `muted_${Date.now()}.mp4`;
        outputPath = path.join(__dirname, 'output', outputFileName);
        await removeAudioFromVideo(filePaths[0], outputPath);
        outputPaths.push(outputFileName);
        nlpResponse = 'Video audio has been muted.';
        break;

      case 'unmute':
        if (filePaths.length !== 1) throw new Error('Unmute action requires exactly one input video');
        outputFileName = `unmuted_${Date.now()}.mp4`;
        outputPath = path.join(__dirname, 'output', outputFileName);
        await unmuteVideo(filePaths[0], outputPath);
        outputPaths.push(outputFileName);
        nlpResponse = 'Video audio has been restored.';
        break;

      default:
        throw new Error('Unrecognized action');
    }

    res.json({ success: true, nlpResponse, outputPaths });
  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/download/:filename', auth, (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'output', filename);

  // Check if file exists
  if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
  }

  // Set headers
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');

  // Stream the file
  const fileStream = fs.createReadStream(filePath);
  
  fileStream.on('error', (error) => {
      console.error('Error reading file:', error);
      res.status(500).send('Error reading file');
  });

  fileStream.pipe(res);

  // Handle client disconnection
  res.on('close', () => {
      fileStream.destroy();
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));