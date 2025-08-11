#!/bin/bash

echo "🔍 Checking Translation Backend Services..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check service health
check_service() {
    local service_name=$1
    local url=$2
    local expected_status=$3
    
    echo -n "Checking $service_name... "
    
    response=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null)
    
    if [ "$response" = "$expected_status" ]; then
        echo -e "${GREEN}✓ OK${NC}"
        return 0
    else
        echo -e "${RED}✗ FAILED (HTTP $response)${NC}"
        return 1
    fi
}

# Check if Docker Compose is running
echo "📋 Checking Docker Compose services..."
docker-compose ps

echo ""
echo "🌐 Testing service endpoints..."

# Check Translation Backend
check_service "Translation Backend" "http://localhost:3001/" "200"

# Check LibreTranslate
check_service "LibreTranslate" "http://localhost:5001/languages" "200"

# Check Redis (via Translation Backend)
echo -n "Checking Redis connection... "
redis_check=$(curl -s "http://localhost:3001/" 2>/dev/null)
if [[ $redis_check == *"Welcome to the Translation API"* ]]; then
    echo -e "${GREEN}✓ OK${NC}"
else
    echo -e "${RED}✗ FAILED${NC}"
fi

# Check Queue Dashboard
check_service "Queue Dashboard" "http://localhost:3001/admin/queues" "200"

echo ""
echo "📊 Service URLs:"
echo "• Translation API: http://localhost:3001"
echo "• Queue Dashboard: http://localhost:3001/admin/queues"
echo "• LibreTranslate: http://localhost:5001"

echo ""
echo -e "${YELLOW}💡 To test file upload:${NC}"
echo "curl -X POST -F \"file=@your-file.txt\" -F \"language=es\" http://localhost:3001/upload"
