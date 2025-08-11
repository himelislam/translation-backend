# Translation Backend

A Node.js backend service for translating documents (TXT, DOCX, PDF, ZIP) using LibreTranslate.

## Features

- File upload and translation (TXT, DOCX, PDF, ZIP archives)
- Queue-based processing with Redis and Bull
- Web dashboard for monitoring translation jobs
- Support for 40+ languages via LibreTranslate
- Docker containerization for easy deployment

## Quick Start with Docker

### Prerequisites
- Docker and Docker Compose installed

### One-Command Deployment

```bash
# Start all services (LibreTranslate, Redis, Translation Backend)
docker-compose up -d
```

This single command will:
1. Start Redis database
2. Start LibreTranslate service
3. Build and start the Translation Backend
4. Set up all networking and dependencies

### Services

After running `docker-compose up -d`, the following services will be available:

- **Translation API**: http://localhost:3001
- **Queue Dashboard**: http://localhost:3001/admin/queues
- **LibreTranslate**: http://localhost:5001

### API Endpoints

- `POST /upload` - Upload file for translation
- `GET /status/:fileId` - Check translation status
- `GET /download/:fileId` - Download translated file
- `GET /languages` - Get available languages
- `GET /` - API health check

### Usage Example

```bash
# Upload a file for translation to Spanish
curl -X POST -F "file=@document.txt" -F "language=es" http://localhost:3001/upload

# Check status
curl http://localhost:3001/status/YOUR_FILE_ID

# Download translated file
curl http://localhost:3001/download/YOUR_FILE_ID -o translated_document.txt
```

## Development

### Local Development Setup

```bash
# Install dependencies
npm install

# Start Redis locally
brew services start redis

# Start LibreTranslate locally
docker run -p 5001:5000 libretranslate/libretranslate

# Start the application
npm run dev
```

### Docker Commands

```bash
# Build and start all services
npm run docker:up

# View logs
npm run docker:logs

# Stop all services
npm run docker:down

# Rebuild services
npm run docker:build
```

## Environment Variables

The application supports the following environment variables:

- `NODE_ENV` - Environment (production/development)
- `PORT` - Server port (default: 3001)
- `REDIS_HOST` - Redis hostname (default: 127.0.0.1)
- `REDIS_PORT` - Redis port (default: 6379)
- `LIBRETRANSLATE_URL` - LibreTranslate service URL

## File Support

- **TXT**: Plain text files
- **DOCX**: Microsoft Word documents
- **PDF**: PDF documents (basic support)
- **ZIP**: Archives containing multiple supported files

## Deployment

### Production Deployment

1. Clone the repository
2. Run `docker-compose up -d`
3. The service will be available on port 3001

### Scaling

To scale the translation backend:

```bash
docker-compose up -d --scale translation-backend=3
```

## Monitoring

- Queue dashboard: http://localhost:3001/admin/queues
- Docker logs: `docker-compose logs -f`
- Health checks are built into all services

## Troubleshooting

### Check service status
```bash
docker-compose ps
```

### View logs
```bash
docker-compose logs translation-backend
docker-compose logs libretranslate
docker-compose logs redis
```

### Restart services
```bash
docker-compose restart
```
