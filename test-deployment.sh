#!/bin/bash

echo "🚀 Testing Translation Backend Deployment"
echo "=========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}📋 Checking Docker Compose services...${NC}"
docker-compose ps

echo ""
echo -e "${BLUE}🌐 Testing Translation Backend API...${NC}"

# Test main API
echo -n "Testing main API endpoint... "
response=$(curl -s http://localhost:3001/)
if [[ $response == *"Welcome to the Translation API"* ]]; then
    echo -e "${GREEN}✓ OK${NC}"
else
    echo -e "${RED}✗ FAILED${NC}"
    exit 1
fi

# Test languages endpoint
echo -n "Testing languages endpoint... "
response=$(curl -s http://localhost:3001/languages)
if [[ $response == *"["* ]]; then
    echo -e "${GREEN}✓ OK${NC}"
else
    echo -e "${RED}✗ FAILED${NC}"
    exit 1
fi

# Test queue dashboard
echo -n "Testing queue dashboard... "
response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/admin/queues)
if [ "$response" = "200" ]; then
    echo -e "${GREEN}✓ OK${NC}"
else
    echo -e "${RED}✗ FAILED (HTTP $response)${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}📊 Service URLs:${NC}"
echo "• Translation API: http://localhost:3001"
echo "• Queue Dashboard: http://localhost:3001/admin/queues"
echo "• LibreTranslate: http://localhost:5001 (may take 2-3 minutes to fully start)"

echo ""
echo -e "${YELLOW}💡 To test file upload (create a test file first):${NC}"
echo "echo 'Hello world' > test.txt"
echo "curl -X POST -F \"file=@test.txt\" -F \"language=es\" http://localhost:3001/upload"

echo ""
echo -e "${GREEN}✅ Translation Backend is successfully deployed!${NC}"
echo -e "${YELLOW}Note: LibreTranslate may take 2-3 minutes to download language models on first run.${NC}"
