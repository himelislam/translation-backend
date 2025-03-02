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

const app = express();
const upload = multer({ dest: 'uploads/' });

// LibreTranslate API setup
const LIBRETRANSLATE_URL = 'http://localhost:5001'; // Replace with your LibreTranslate server URL

// Redis and Bull setup
const redisClient = redis.createClient();
// const fileQueue = new Queue('fileQueue', 'redis://127.0.0.1:6379');

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
app.use('/admin/queues', serverAdapter.getRouter());

// Temporary folders
const UPLOAD_FOLDER = 'uploads';
const TRANSLATED_FOLDER = 'translated';
if (!fs.existsSync(UPLOAD_FOLDER)) fs.mkdirSync(UPLOAD_FOLDER);
if (!fs.existsSync(TRANSLATED_FOLDER)) fs.mkdirSync(TRANSLATED_FOLDER);

// In-memory storage for tracking file status
const fileStatus = {};

// Endpoint to upload a file
app.post('/upload', upload.single('file'), (req, res) => {
    const file = req.file;
    const targetLanguage = req.body.language || 'en'; // Default to English
    console.log(file, "file", targetLanguage, "targetLanguage");

    if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    // Validate file type
    if (file.originalname.endsWith('.zip') && file.mimetype !== 'application/zip') {
        return res.status(400).json({ error: 'Invalid file type. Expected a ZIP file.' });
    }

    const fileId = Date.now().toString(); // Generate a unique file ID
    fileStatus[fileId] = { status: 'processing' };

    // Log file details
    console.log(`Uploaded file: ${file.originalname}, size: ${file.size} bytes, type: ${file.mimetype}`);

    // Add the file processing task to the queue
    fileQueue.add({ fileId, filePath: file.path, targetLanguage, originalname: file.originalname });

    res.json({ fileId, status: 'processing' });
});

// Endpoint to check file status
app.get('/upload/:fileId', (req, res) => {
    const fileId = req.params.fileId;

    if (!fileStatus[fileId]) {
        return res.status(404).json({ error: 'Invalid file ID' });
    }

    res.json({ fileId, status: fileStatus[fileId] });
});

// Endpoint to download the translated file
app.get('/download/:fileId', (req, res) => {
    const fileId = req.params.fileId;

    if (!fileStatus[fileId] || fileStatus[fileId].status !== 'completed') {
        return res.status(400).json({ error: 'File processing not completed' });
    }

    const translatedFilePath = fileStatus[fileId].translatedFile;
    res.download(translatedFilePath);
});

// Process files in the background
fileQueue.process(async (job) => {
    const { fileId, filePath, targetLanguage, originalname } = job.data;

    try {
        let translatedFilePath;
        if (originalname.endsWith('.zip')) {
            translatedFilePath = await processZip(filePath, targetLanguage);
        } else {
            translatedFilePath = await processSingleFile(filePath, targetLanguage, originalname);
        }

        fileStatus[fileId] = {
            status: 'completed',
            translatedFile: translatedFilePath,
        };
    } catch (error) {
        console.error(`Error processing file ${fileId}:`, error);
        fileStatus[fileId] = {
            status: 'failed',
            error: error.message,
        };
    } finally {
        // Clean up the uploaded file
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
});

async function translateText(text, targetLanguage) {
    try {
        const response = await axios.post(`${LIBRETRANSLATE_URL}/translate`, {
            q: text,
            source: 'auto',
            target: targetLanguage,
        });
        return response.data.translatedText;
    } catch (error) {
        console.error('Translation failed:', error.message);
        throw new Error('Translation service unavailable');
    }
}

// Function to process a single file
async function processSingleFile(filePath, targetLanguage, originalname) {
    const fileExtension = path.extname(originalname).toLowerCase()
    let content;

    if (fileExtension === '.txt') {
        content = fs.readFileSync(filePath, 'utf8');
    } else if (fileExtension === '.docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        content = result.value;
    } else if (fileExtension === '.pdf') {
        const pdfBytes = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const pages = pdfDoc.getPages();
        content = pages.map((page) => page.getTextContent().items.map((item) => item.str).join(' ')).join('\n');
    } else {
        throw new Error('Unsupported file format');
    }

    // Translate the content
    const translatedContent = await translateText(content, targetLanguage);

    // Save the translated content to a new file
    const translatedFilePath = path.join(TRANSLATED_FOLDER, `${path.basename(originalname, fileExtension)}_translated${fileExtension}`);
    fs.writeFileSync(translatedFilePath, translatedContent);

    return translatedFilePath;
}

// Function to process a ZIP file
async function processZip(zipPath, targetLanguage) {
    const zip = new AdmZip(zipPath);

    // Check if the ZIP file is valid
    if (!zip.getEntries() || zip.getEntries().length === 0) {
        throw new Error('Invalid or empty ZIP file');
    }


    const zipEntries = zip.getEntries();
    const translatedFiles = [];

    for (const entry of zipEntries) {
        if (!entry.isDirectory) {
            const fileExtension = path.extname(entry.entryName).toLowerCase();
            let content;

            if (fileExtension === '.txt') {
                content = entry.getData().toString('utf8');
            } else if (fileExtension === '.docx') {
                const result = await mammoth.extractRawText({ buffer: entry.getData() });
                content = result.value;
            } else if (fileExtension === '.pdf') {
                const pdfDoc = await PDFDocument.load(entry.getData());
                const pages = pdfDoc.getPages();
                content = pages.map((page) => page.getTextContent().items.map((item) => item.str).join(' ')).join('\n');
            } else {
                console.warn(`Skipping unsupported file: ${entry.entryName}`);
                continue;
            }

            // Translate the content
            const translatedContent = await translateText(content, targetLanguage);

            // Save the translated content to a new file
            const translatedFilePath = path.join(TRANSLATED_FOLDER, `${path.basename(entry.entryName, fileExtension)}_translated${fileExtension}`);
            fs.writeFileSync(translatedFilePath, translatedContent);
            translatedFiles.push(translatedFilePath);
        }
    }

    // Create a new ZIP file with the translated files
    const translatedZipPath = path.join(TRANSLATED_FOLDER, `translated_${path.basename(zipPath)}`);
    const translatedZip = new AdmZip();
    translatedFiles.forEach((file) => translatedZip.addLocalFile(file));
    translatedZip.writeZip(translatedZipPath);

    return translatedZipPath;
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

redisClient.on('connect', () => {
    console.log('Connected to Redis');
});

redisClient.on('error', (err) => {
    console.error('Redis error:', err);
});