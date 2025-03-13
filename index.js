const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const mammoth = require('mammoth');
const { PDFDocument } = require('pdf-lib');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const Queue = require('bull');
const redis = require('redis');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cors = require("cors");

const app = express();

// Configure file storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    // Keep original filename but make it unique
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// LibreTranslate API setup
const LIBRETRANSLATE_URL = 'http://localhost:5001'; // Replace with your LibreTranslate server URL

// Redis and Bull setup
const redisClient = redis.createClient();
// Connect to Redis
(async () => {
  try {
    await redisClient.connect();
    console.log('Connected to Redis');
  } catch (err) {
    console.error('Redis connection error:', err);
  }
})();

// File processing queue
const fileQueue = new Queue('fileQueue', {
  redis: {
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null, // Disable retry limit
  },
});

// Bull Board setup for monitoring queues
const serverAdapter = new ExpressAdapter();
createBullBoard({
  queues: [new BullAdapter(fileQueue)],
  serverAdapter: serverAdapter,
});
serverAdapter.setBasePath('/admin/queues');
app.use(cors());
app.use('/admin/queues', serverAdapter.getRouter());

// Temporary folders
const UPLOAD_FOLDER = 'uploads';
const TRANSLATED_FOLDER = 'translated';
const TEMP_FOLDER = 'temp';

// Ensure folders exist
[UPLOAD_FOLDER, TRANSLATED_FOLDER, TEMP_FOLDER].forEach(folder => {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder);
});

// In-memory storage for tracking file status
const fileStatus = {};

// Endpoint to upload a file
app.post('/upload', upload.single('file'), (req, res) => {
  const file = req.file;
  const targetLanguage = req.body.language || 'en'; // Default to English
  console.log(file, "file", targetLanguage, "targetLanguage");

  // Check if a file was uploaded
  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Validate file type for ZIP
  const isZipFile = file.originalname.endsWith('.zip');
  const validZipMimeTypes = [
    'application/zip', 
    'application/x-zip-compressed', 
    'application/octet-stream', 
    'multipart/x-zip'
  ];
  
  if (isZipFile && !validZipMimeTypes.includes(file.mimetype)) {
    return res.status(400).json({ error: 'Invalid ZIP file type.' });
  }

  // Generate a unique file ID
  const fileId = Date.now().toString();
  fileStatus[fileId] = { status: 'queued', uploadTime: new Date().toISOString() };

  // Log file details
  console.log(`Uploaded file: ${file.originalname}, size: ${file.size} bytes, type: ${file.mimetype}`);

  // Add the file processing task to the queue
  fileQueue.add(
    { 
      fileId, 
      filePath: file.path, 
      targetLanguage, 
      originalname: file.originalname 
    },
    { 
      attempts: 3, // Retry up to 3 times
      removeOnComplete: true // Remove completed jobs from queue
    }
  );

  res.json({ 
    fileId, 
    status: 'queued', 
    message: 'File uploaded successfully and queued for processing' 
  });
});

// Endpoint to check file status
app.get('/status/:fileId', (req, res) => {
  const fileId = req.params.fileId;

  if (!fileStatus[fileId]) {
    return res.status(404).json({ error: 'Invalid file ID' });
  }

  res.json(fileStatus[fileId]);
});

// Endpoint to download the translated file
app.get('/download/:fileId', (req, res) => {
  const fileId = req.params.fileId;

  if (!fileStatus[fileId]) {
    return res.status(404).json({ error: 'Invalid file ID' });
  }

  if (fileStatus[fileId].status !== 'completed') {
    return res.status(400).json({ 
      error: 'File processing not completed',
      status: fileStatus[fileId].status
    });
  }

  const translatedFilePath = fileStatus[fileId].translatedFile;
  
  if (!fs.existsSync(translatedFilePath)) {
    return res.status(404).json({ error: 'Translated file not found' });
  }

  // Set appropriate headers for download
  const filename = path.basename(translatedFilePath);
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  
  // Set content type based on file extension
  const ext = path.extname(translatedFilePath).toLowerCase();
  if (ext === '.zip') {
    res.set('Content-Type', 'application/zip');
  } else if (ext === '.txt') {
    res.set('Content-Type', 'text/plain');
  } else if (ext === '.docx') {
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } else if (ext === '.pdf') {
    res.set('Content-Type', 'application/pdf');
  }

  res.download(translatedFilePath, (err) => {
    if (err) {
      console.error(`Error downloading file ${fileId}:`, err);
      // Don't attempt to send another response here as one has already been started
    }
  });
});

// Process files in the background
fileQueue.process(async (job) => {
  const { fileId, filePath, targetLanguage, originalname } = job.data;

  try {
    // Update status to processing
    fileStatus[fileId] = {
      ...fileStatus[fileId],
      status: 'processing',
      startTime: new Date().toISOString()
    };

    console.log(`Processing file ${fileId}: ${originalname}`);
    let translatedFilePath;

    const isZipFile = originalname.endsWith('.zip');
    if (isZipFile) {
      translatedFilePath = await processZip(filePath, targetLanguage, fileId);
    } else {
      translatedFilePath = await processSingleFile(filePath, targetLanguage, originalname, fileId);
    }

    // Update the file status
    fileStatus[fileId] = {
      ...fileStatus[fileId],
      status: 'completed',
      translatedFile: translatedFilePath,
      completedTime: new Date().toISOString()
    };

    console.log(`Completed processing file ${fileId}: ${originalname}`);
    return { success: true, translatedFilePath };
  } catch (error) {
    console.error(`Error processing file ${fileId}:`, error);
    fileStatus[fileId] = {
      ...fileStatus[fileId],
      status: 'failed',
      error: error.message,
      failedTime: new Date().toISOString()
    };
    throw error; // Re-throw to trigger Bull's retry mechanism
  } finally {
    // Clean up the uploaded file
    cleanupFile(filePath);
  }
});

// Handle queue errors
fileQueue.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed with error: ${err.message}`);
  const { fileId } = job.data;
  if (fileStatus[fileId]) {
    fileStatus[fileId].status = 'failed';
    fileStatus[fileId].error = err.message;
  }
});

// Function to translate text using LibreTranslate
async function translateText(text, targetLanguage) {
  if (!text || text.trim() === '') {
    return ''; // Return empty string for empty content
  }

  try {
    const response = await axios.post(`${LIBRETRANSLATE_URL}/translate`, {
      q: text,
      source: 'auto',
      target: targetLanguage,
    });
    return response.data.translatedText;
  } catch (error) {
    console.error('Translation failed:', error.message);
    // More detailed error message
    if (error.response) {
      throw new Error(`Translation service error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      throw new Error('Translation service unavailable - no response received');
    } else {
      throw new Error(`Translation error: ${error.message}`);
    }
  }
}

// Function to process a single file
async function processSingleFile(filePath, targetLanguage, originalname, fileId) {
  const fileExtension = path.extname(originalname).toLowerCase();
  let content;

  // Update status
  updateFileStatus(fileId, { step: `Extracting content from ${fileExtension} file` });

  try {
    if (fileExtension === '.txt') {
      content = fs.readFileSync(filePath, 'utf8');
    } else if (fileExtension === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      content = result.value;
      
      if (!content || content.trim() === '') {
        throw new Error('Failed to extract text from DOCX file');
      }
    } else if (fileExtension === '.pdf') {
      const pdfBytes = fs.readFileSync(filePath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      
      // This is a placeholder - pdf-lib doesn't actually extract text this way
      // Consider using a dedicated PDF text extraction library instead
      content = `PDF file content placeholder. Please use a proper PDF extraction library.`;
    } else {
      throw new Error(`Unsupported file format: ${fileExtension}`);
    }

    // Update status
    updateFileStatus(fileId, { step: 'Translating content' });

    // Translate the content
    const translatedContent = await translateText(content, targetLanguage);

    // Update status
    updateFileStatus(fileId, { step: 'Saving translated content' });

    // Save the translated content to a new file
    const translatedFilename = `${path.basename(originalname, fileExtension)}_translated_to_${targetLanguage}${fileExtension}`;
    const translatedFilePath = path.join(TRANSLATED_FOLDER, translatedFilename);
    fs.writeFileSync(translatedFilePath, translatedContent);

    return translatedFilePath;
  } catch (error) {
    console.error(`Error processing file ${originalname}:`, error);
    throw new Error(`Failed to process ${fileExtension} file: ${error.message}`);
  }
}

// Function to process a ZIP file
async function processZip(zipPath, targetLanguage, fileId) {
  // Validate the ZIP file first
  try {
    // Check if file exists and has content
    const stats = fs.statSync(zipPath);
    if (stats.size === 0) {
      throw new Error('ZIP file is empty');
    }

    updateFileStatus(fileId, { step: 'Validating ZIP file' });
    
    let zip;
    try {
      zip = new AdmZip(zipPath);
    } catch (error) {
      throw new Error(`Invalid ZIP file: ${error.message}`);
    }

    const zipEntries = zip.getEntries();
    if (!zipEntries || zipEntries.length === 0) {
      throw new Error('ZIP file is empty or invalid');
    }

    // Create a unique temp directory for this job
    const tempDir = path.join(TEMP_FOLDER, fileId);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const translatedFiles = [];
    const totalFiles = zipEntries.filter(entry => !entry.isDirectory).length;
    let processedFiles = 0;

    updateFileStatus(fileId, { 
      step: `Processing ZIP file with ${totalFiles} files`,
      progress: 0,
      totalFiles
    });

    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;

      try {
        const fileExtension = path.extname(entry.entryName).toLowerCase();
        let content;
        const entryName = entry.entryName;

        // Skip files we can't process
        if (!['.txt', '.docx', '.pdf'].includes(fileExtension)) {
          console.log(`Skipping unsupported file: ${entryName}`);
          continue;
        }

        updateFileStatus(fileId, { 
          step: `Processing ${entryName}`,
          current: ++processedFiles,
          progress: Math.round((processedFiles / totalFiles) * 100)
        });

        if (fileExtension === '.txt') {
          content = entry.getData().toString('utf8');
        } else if (fileExtension === '.docx') {
          // Extract DOCX to temp file first
          const tempFilePath = path.join(tempDir, path.basename(entryName));
          fs.writeFileSync(tempFilePath, entry.getData());
          
          try {
            const result = await mammoth.extractRawText({ path: tempFilePath });
            content = result.value;
            // Clean up temp file
            cleanupFile(tempFilePath);
          } catch (error) {
            console.error(`Error extracting text from DOCX: ${entryName}`, error);
            cleanupFile(tempFilePath);
            continue; // Skip this file but continue with others
          }
        } else if (fileExtension === '.pdf') {
          try {
            // Write PDF to temp file
            const tempFilePath = path.join(tempDir, path.basename(entryName));
            fs.writeFileSync(tempFilePath, entry.getData());
            
            // This is a placeholder - implement proper PDF text extraction
            content = `Content of PDF file ${entryName}`;
            
            // Clean up temp file
            cleanupFile(tempFilePath);
          } catch (error) {
            console.error(`Error extracting text from PDF: ${entryName}`, error);
            continue; // Skip this file but continue with others
          }
        }

        if (!content || content.trim() === '') {
          console.warn(`Empty content in file: ${entryName}`);
          continue;
        }

        // Translate the content
        updateFileStatus(fileId, { subStep: `Translating ${entryName}` });
        const translatedContent = await translateText(content, targetLanguage);

        // Save the translated content to a new file
        const translatedFilename = `${path.basename(entryName, fileExtension)}_translated_to_${targetLanguage}${fileExtension}`;
        const translatedFilePath = path.join(tempDir, translatedFilename);
        fs.writeFileSync(translatedFilePath, translatedContent);
        translatedFiles.push({
          path: translatedFilePath,
          entryName: `translated/${translatedFilename}`
        });
      } catch (error) {
        console.error(`Error processing zip entry ${entry.entryName}:`, error);
        // Continue with other files instead of failing the whole process
      }
    }

    if (translatedFiles.length === 0) {
      throw new Error('No files were successfully translated');
    }

    // Create a new ZIP file with the translated files
    updateFileStatus(fileId, { step: 'Creating ZIP archive with translated files' });
    const translatedZipFilename = `translated_to_${targetLanguage}_${path.basename(zipPath)}`;
    const translatedZipPath = path.join(TRANSLATED_FOLDER, translatedZipFilename);
    
    const translatedZip = new AdmZip();
    translatedFiles.forEach(file => {
      translatedZip.addLocalFile(file.path, path.dirname(file.entryName));
    });
    
    translatedZip.writeZip(translatedZipPath);

    // Clean up temporary translated files
    updateFileStatus(fileId, { step: 'Cleaning up temporary files' });
    translatedFiles.forEach(file => {
      cleanupFile(file.path);
    });
    
    // Clean up temp directory
    try {
      fs.rmdirSync(tempDir, { recursive: true });
    } catch (error) {
      console.error(`Error removing temp directory ${tempDir}:`, error);
    }

    return translatedZipPath;
  } catch (error) {
    console.error('Error processing ZIP file:', error);
    if (error.message.includes('end of central directory')) {
      throw new Error('Invalid ZIP file format. The file may be corrupted or not a valid ZIP file.');
    }
    throw error;
  }
}

// Utility function to update file status
function updateFileStatus(fileId, update) {
  if (fileStatus[fileId]) {
    fileStatus[fileId] = {
      ...fileStatus[fileId],
      ...update,
      lastUpdated: new Date().toISOString()
    };
  }
}

// Utility function to clean up a file
function cleanupFile(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      console.error(`Error removing file ${filePath}:`, error);
    }
  }
}

// API endpoint to get available languages from LibreTranslate
app.get('/languages', async (req, res) => {
  try {
    const response = await axios.get(`${LIBRETRANSLATE_URL}/languages`);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching languages:', error);
    res.status(500).json({ error: 'Failed to fetch available languages' });
  }
});

// Home page with basic info
app.get('/', (req, res) => {
  res.send({message: "Welcome to the Translation API"});
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Server error', 
    message: err.message 
  });
});

// Clean up process when the application exits
process.on('exit', async () => {
  await fileQueue.close();
  redisClient.quit();
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Queue dashboard available at http://localhost:${PORT}/admin/queues`);
});